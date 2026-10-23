const { WebSocketServer, WebSocket } = require("ws");
const jwt = require("jsonwebtoken");
const url = require("url");

/**
 * Live Device-to-Admin Screen & Audio Streaming WebSocket Relay
 *
 * Transmits real-time screen frames (JPEG binary frames) and ambient PCM audio
 * from target device to admin dashboard popup window with zero disk storage
 * or database persistence.
 *
 * Path:
 *   /ws/screen-stream?role=admin|device&token=<jwt>&deviceId=<id>
 */
function attachScreenRelay(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  // deviceId -> { adminWsSet: Set<WebSocket>, deviceWs: WebSocket | null }
  const streams = new Map();

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    if (pathname !== "/ws/screen-stream") return;

    const { role, token, deviceId } = query;
    if (!role || !token || !deviceId || !["admin", "device"].includes(role)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (role === "device" && payload.role !== "device") {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (role === "admin" && payload.role === "device") {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    const effectiveDeviceId = (role === "device" && payload.sub) ? payload.sub : deviceId;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, { role, deviceId: effectiveDeviceId });
    });
  });

  wss.on("connection", (ws, req, { role, deviceId }) => {
    let stream = streams.get(deviceId);
    if (!stream) {
      stream = { adminWsSet: new Set(), deviceWs: null };
      streams.set(deviceId, stream);
    }

    // Disable Nagle's algorithm for instant low-latency frame dispatch
    try {
      ws._socket?.setNoDelay(true);
    } catch {}

    if (role === "admin") {
      stream.adminWsSet.add(ws);
      console.log(`[screenRelay] Admin connected for device ${deviceId} (active viewers: ${stream.adminWsSet.size})`);

      if (stream.deviceWs && stream.deviceWs.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "status", status: "streaming", message: "Device streaming active" }));
      } else {
        ws.send(JSON.stringify({ type: "status", status: "waiting_device", message: "Waiting for device screen stream..." }));
      }

      ws.on("message", (msg) => {
        try {
          const parsed = JSON.parse(msg.toString());
          if (parsed.action === "stop") {
            if (stream.deviceWs && stream.deviceWs.readyState === WebSocket.OPEN) {
              stream.deviceWs.send(JSON.stringify({ action: "stop" }));
            }
          }
        } catch {
          // ignore non-json messages
        }
      });

      ws.on("close", () => {
        stream.adminWsSet.delete(ws);
        console.log(`[screenRelay] Admin disconnected for device ${deviceId} (remaining: ${stream.adminWsSet.size})`);
        if (stream.adminWsSet.size === 0) {
          // Grace period: allow 4 seconds for reconnection (React mount/StrictMode, refresh, etc.)
          setTimeout(() => {
            const currentStream = streams.get(deviceId);
            if (currentStream && currentStream.adminWsSet.size === 0) {
              console.log(`[screenRelay] No admins watching device ${deviceId} after grace period — stopping device stream`);
              if (currentStream.deviceWs && currentStream.deviceWs.readyState === WebSocket.OPEN) {
                currentStream.deviceWs.send(JSON.stringify({ action: "stop" }));
              }
              if (!currentStream.deviceWs) {
                streams.delete(deviceId);
              }
            }
          }, 4000);
        }
      });

      ws.on("error", () => {
        stream.adminWsSet.delete(ws);
      });
    } else {
      console.log(`[screenRelay] Device ${deviceId} connected to screen stream`);
      if (stream.disconnectTimeout) {
        clearTimeout(stream.disconnectTimeout);
        stream.disconnectTimeout = null;
      }
      stream.deviceWs = ws;

      for (const admin of stream.adminWsSet) {
        if (admin.readyState === WebSocket.OPEN) {
          admin.send(JSON.stringify({ type: "status", status: "streaming", message: "Device screen stream started" }));
        }
      }

      ws.on("message", (data, isBinary) => {
        // Broadcast binary frame to all connected admins watching this device
        for (const admin of stream.adminWsSet) {
          // Buffer bloat prevention: drop stale frames only if admin socket has high backlog (> 128 KB)
          if (isBinary && admin.bufferedAmount > 128 * 1024) {
            continue;
          }
          admin.send(data, { binary: isBinary });
        }
      });

      ws.on("close", () => {
        console.log(`[screenRelay] Device ${deviceId} stream closed`);
        if (stream.deviceWs === ws) {
          stream.deviceWs = null;

          for (const admin of stream.adminWsSet) {
            if (admin.readyState === WebSocket.OPEN) {
              admin.send(JSON.stringify({ type: "status", status: "reconnecting", message: "Device stream reconnecting..." }));
            }
          }

          if (stream.disconnectTimeout) clearTimeout(stream.disconnectTimeout);
          stream.disconnectTimeout = setTimeout(() => {
            const currentStream = streams.get(deviceId);
            if (currentStream && !currentStream.deviceWs) {
              for (const admin of currentStream.adminWsSet) {
                if (admin.readyState === WebSocket.OPEN) {
                  admin.send(JSON.stringify({ type: "status", status: "device_stopped", message: "Device stopped screen streaming" }));
                }
              }
              if (currentStream.adminWsSet.size === 0) {
                streams.delete(deviceId);
              }
            }
          }, 5000);
        }
      });

      ws.on("error", () => {
        if (stream.deviceWs === ws) {
          stream.deviceWs = null;
        }
      });
    }
  });

  return wss;
}

module.exports = { attachScreenRelay };

const { WebSocketServer, WebSocket } = require("ws");
const jwt = require("jsonwebtoken");
const url = require("url");

/**
 * Live Device-to-Admin Camera Streaming WebSocket Relay
 *
 * Transmits real-time front or back camera frames (JPEG binary frames)
 * and ambient PCM audio from the target device to the admin dashboard
 * with zero disk storage or database persistence.
 *
 * Path:
 *   /ws/camera-stream?role=admin|device&token=<jwt>&deviceId=<id>&lens=front|back
 */
function attachCameraRelay(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  // deviceId -> { adminWsSet: Set<WebSocket>, deviceWs: WebSocket | null, currentLens: string }
  const streams = new Map();

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    if (pathname !== "/ws/camera-stream") return;

    const { role, token, deviceId, lens } = query;
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
    const initialLens = lens === "front" ? "front" : "back";

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, { role, deviceId: effectiveDeviceId, lens: initialLens });
    });
  });

  wss.on("connection", (ws, req, { role, deviceId, lens }) => {
    let stream = streams.get(deviceId);
    if (!stream) {
      stream = { adminWsSet: new Set(), deviceWs: null, currentLens: lens || "back" };
      streams.set(deviceId, stream);
    } else if (role === "admin" && lens && (!stream.deviceWs || stream.deviceWs.readyState !== WebSocket.OPEN)) {
      stream.currentLens = lens;
    }

    // Disable Nagle's algorithm for instant low-latency frame dispatch
    try {
      ws._socket?.setNoDelay(true);
    } catch {}

    if (role === "admin") {
      stream.adminWsSet.add(ws);
      console.log(`[cameraRelay] Admin connected for device ${deviceId} (active viewers: ${stream.adminWsSet.size})`);

      if (stream.deviceWs && stream.deviceWs.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "status",
          status: "streaming",
          lens: stream.currentLens,
          message: "Device camera streaming active",
        }));
      } else {
        ws.send(JSON.stringify({
          type: "status",
          status: "waiting_device",
          lens: stream.currentLens,
          message: "Waiting for device camera stream...",
        }));
      }

      ws.on("message", (msg) => {
        try {
          const parsed = JSON.parse(msg.toString());
          if (parsed.action === "stop") {
            if (stream.deviceWs && stream.deviceWs.readyState === WebSocket.OPEN) {
              stream.deviceWs.send(JSON.stringify({ action: "stop" }));
            }
          } else if (parsed.action === "switch_lens" && (parsed.lens === "front" || parsed.lens === "back")) {
            stream.currentLens = parsed.lens;
            console.log(`[cameraRelay] Admin requested lens switch to ${parsed.lens} for device ${deviceId}`);
            if (stream.deviceWs && stream.deviceWs.readyState === WebSocket.OPEN) {
              stream.deviceWs.send(JSON.stringify({ action: "switch_lens", lens: parsed.lens }));
            }
          }
        } catch {
          // ignore non-json messages
        }
      });

      ws.on("close", () => {
        stream.adminWsSet.delete(ws);
        console.log(`[cameraRelay] Admin disconnected for device ${deviceId} (remaining: ${stream.adminWsSet.size})`);
        if (stream.adminWsSet.size === 0) {
          // Grace period: allow 4 seconds for reconnection (React mount/StrictMode, refresh, etc.)
          setTimeout(() => {
            const currentStream = streams.get(deviceId);
            if (currentStream && currentStream.adminWsSet.size === 0) {
              console.log(`[cameraRelay] No admins watching camera for device ${deviceId} after grace period — stopping stream`);
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
      console.log(`[cameraRelay] Device ${deviceId} connected with camera lens: ${lens}`);
      stream.deviceWs = ws;
      stream.currentLens = lens;

      for (const admin of stream.adminWsSet) {
        if (admin.readyState === WebSocket.OPEN) {
          admin.send(JSON.stringify({
            type: "status",
            status: "streaming",
            lens: stream.currentLens,
            message: "Device camera stream started",
          }));
        }
      }

      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          try {
            const parsed = JSON.parse(data.toString());
            if (parsed.type === "lens_switched") {
              stream.currentLens = parsed.lens;
              for (const admin of stream.adminWsSet) {
                if (admin.readyState === WebSocket.OPEN) {
                  admin.send(JSON.stringify({ type: "lens_switched", lens: parsed.lens }));
                }
              }
            }
          } catch {
            // ignore non-json
          }
          return;
        }

        // Broadcast binary frame to all connected admins watching this device
        for (const admin of stream.adminWsSet) {
          if (admin.readyState === WebSocket.OPEN) {
            // Buffer bloat prevention: drop stale frames only if admin socket has high backlog (> 128 KB)
            if (isBinary && admin.bufferedAmount > 128 * 1024) {
              continue;
            }
            admin.send(data, { binary: isBinary });
          }
        }
      });

      ws.on("close", () => {
        console.log(`[cameraRelay] Device ${deviceId} camera stream closed`);
        if (stream.deviceWs === ws) {
          stream.deviceWs = null;
          for (const admin of stream.adminWsSet) {
            if (admin.readyState === WebSocket.OPEN) {
              admin.send(JSON.stringify({
                type: "status",
                status: "device_stopped",
                message: "Device stopped camera streaming",
              }));
            }
          }
        }
        if (stream.adminWsSet.size === 0 && !stream.deviceWs) {
          streams.delete(deviceId);
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

module.exports = { attachCameraRelay };

const { WebSocketServer, WebSocket } = require("ws");
const jwt = require("jsonwebtoken");
const url = require("url");

/**
 * Live Device-to-Admin Surrounding / Ambient Audio Streaming WebSocket Relay
 *
 * Transmits real-time high-fidelity stereo / binaural ambient PCM audio
 * from the target device's dual microphones to the admin dashboard
 * with ultra-low latency and zero disk storage or database persistence.
 *
 * Path:
 *   /ws/audio-stream?role=admin|device&token=<jwt>&deviceId=<id>
 */
function attachAudioRelay(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  // deviceId -> { adminWsSet: Set<WebSocket>, deviceWs: WebSocket | null, audioMeta: object | null }
  const streams = new Map();

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    if (pathname !== "/ws/audio-stream") return;

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
      stream = { adminWsSet: new Set(), deviceWs: null, audioMeta: null };
      streams.set(deviceId, stream);
    }

    // Disable Nagle's algorithm for instant low-latency audio chunk dispatch
    try {
      ws._socket?.setNoDelay(true);
    } catch {}

    if (role === "admin") {
      stream.adminWsSet.add(ws);
      console.log(`[audioRelay] Admin connected for device ${deviceId} (active listeners: ${stream.adminWsSet.size})`);

      if (stream.deviceWs && stream.deviceWs.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "status",
          status: "streaming",
          audioMeta: stream.audioMeta,
          message: "Device audio streaming active",
        }));
      } else {
        ws.send(JSON.stringify({
          type: "status",
          status: "waiting_device",
          message: "Waiting for device audio stream...",
        }));
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
        console.log(`[audioRelay] Admin disconnected for device ${deviceId} (remaining listeners: ${stream.adminWsSet.size})`);
        if (stream.adminWsSet.size === 0) {
          // Grace period: allow 4 seconds for reconnection (React mount/StrictMode, refresh, etc.)
          setTimeout(() => {
            const currentStream = streams.get(deviceId);
            if (currentStream && currentStream.adminWsSet.size === 0) {
              console.log(`[audioRelay] No admins listening to audio for device ${deviceId} after grace period — stopping device stream`);
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
      console.log(`[audioRelay] Device ${deviceId} audio transmitter connected`);
      stream.deviceWs = ws;

      for (const admin of stream.adminWsSet) {
        if (admin.readyState === WebSocket.OPEN) {
          admin.send(JSON.stringify({
            type: "status",
            status: "streaming",
            message: "Device audio stream started",
          }));
        }
      }

      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          try {
            const parsed = JSON.parse(data.toString());
            if (parsed.type === "init") {
              stream.audioMeta = parsed;
              for (const admin of stream.adminWsSet) {
                if (admin.readyState === WebSocket.OPEN) {
                  admin.send(JSON.stringify({ type: "init", ...parsed }));
                }
              }
            }
          } catch {
            // ignore non-json
          }
          return;
        }

        // Broadcast binary PCM audio packet to all connected admins listening to this device
        for (const admin of stream.adminWsSet) {
          if (admin.readyState === WebSocket.OPEN) {
            // Buffer bloat prevention: drop audio chunk if admin client socket has buffered bytes
            // to prevent queue buildup and keep latency strictly under 100ms
            if (isBinary && admin.bufferedAmount > 16384) {
              continue;
            }
            admin.send(data, { binary: isBinary });
          }
        }
      });

      ws.on("close", () => {
        console.log(`[audioRelay] Device ${deviceId} audio stream closed`);
        if (stream.deviceWs === ws) {
          stream.deviceWs = null;
          stream.audioMeta = null;
          for (const admin of stream.adminWsSet) {
            if (admin.readyState === WebSocket.OPEN) {
              admin.send(JSON.stringify({
                type: "status",
                status: "device_stopped",
                message: "Device stopped audio streaming",
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
          stream.audioMeta = null;
        }
      });
    }
  });

  return wss;
}

module.exports = { attachAudioRelay };

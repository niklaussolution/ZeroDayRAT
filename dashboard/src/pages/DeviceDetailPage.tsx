import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { devicesApi } from "../api/devices";
import type { Device } from "../api/types";
import FeatureFlagsCard from "../components/FeatureFlagsCard";
import RemoteActionsCard from "../components/RemoteActionsCard";
import ScreenStreamCard from "../components/ScreenStreamCard";
import CameraStreamCard from "../components/CameraStreamCard";
import AudioStreamCard from "../components/AudioStreamCard";
import LocationCard from "../components/LocationCard";
import GeofencesCard from "../components/GeofencesCard";
import AppUsageChart from "../components/AppUsageChart";
import LogsTables from "../components/LogsTables";
import InstalledAppsCard from "../components/InstalledAppsCard";
import WebHistoryCard from "../components/WebHistoryCard";
import AlertsCard from "../components/AlertsCard";
import BlockRulesCard from "../components/BlockRulesCard";
import AppsCard from "../components/AppsCard";
import SavedContactsCard from "../components/SavedContactsCard";

export default function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [device, setDevice] = useState<Device | null>(null);
  const [locationRefreshKey, setLocationRefreshKey] = useState(0);
  const [isStreamActive, setIsStreamActive] = useState(false);
  const [isCameraStreamActive, setIsCameraStreamActive] = useState(false);
  const [isAudioStreamActive, setIsAudioStreamActive] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!id) return;
    devicesApi
      .get(id)
      .then((d) => {
        if (d.status === "revoked") {
          navigate(`/devices/${id}/archive`, { replace: true });
          return;
        }
        setDevice(d);
      })
      .catch(() => {
        navigate("/devices", { replace: true });
      });
  }, [id, navigate]);

  if (!id) return null;
  if (!device) return <p className="text-sm text-gray-500">Loading...</p>;

  async function handleDeactivate() {
    if (!id) return;
    if (
      !confirm(
        "Deactivate this device? It will stop syncing immediately. Its history is kept, and you can reconnect it later with the same device code."
      )
    ) {
      return;
    }
    setDeactivating(true);
    try {
      await devicesApi.deactivate(id);
      navigate(`/devices/${id}/archive`, { replace: true });
    } finally {
      setDeactivating(false);
    }
  }

  async function handleDelete() {
    if (!id || !device) return;
    const confirmed = confirm(
      `Permanently delete "${device.device_label}" and ALL of its stored data in PostgreSQL?\n\n` +
        `This will immediately and permanently purge:\n` +
        `• All WhatsApp chat messages\n` +
        `• Location history and geofences\n` +
        `• Call and SMS logs\n` +
        `• App usage and installed apps\n` +
        `• Web history, alerts, and remote commands\n\n` +
        `This action cannot be undone.`
    );
    if (!confirmed) return;
    setDeleting(true);
    try {
      await devicesApi.delete(id);
      navigate("/devices", { replace: true });
    } catch (e) {
      alert(`Delete device failed: ${(e as Error).message}`);
      setDeleting(false);
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
          <p className="text-xs text-gray-500 flex items-center gap-1.5 flex-wrap">
            <span className="capitalize">{device.status}</span> ·
            <span>{device.os_version || "unknown OS"}</span> ·
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                device.app_version === "1.0.1"
                  ? "bg-emerald-100 text-emerald-700 border border-emerald-300"
                  : "bg-amber-100 text-amber-700 border border-amber-300"
              }`}
            >
              App {device.app_version ? `v${device.app_version}` : "v1.0.0"}
              {device.app_version !== "1.0.1" ? " · Update Available" : " · Latest"}
            </span> ·
            <span>
              last seen {device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : "never"}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleDeactivate}
            disabled={deactivating || deleting}
            className="text-gray-700 border border-gray-300 text-sm px-4 py-2 rounded hover:bg-gray-50 transition disabled:opacity-50"
          >
            {deactivating ? "Deactivating..." : "Deactivate Device"}
          </button>
          <button
            onClick={handleDelete}
            disabled={deactivating || deleting}
            className="bg-red-600 text-white text-sm px-4 py-2 rounded hover:bg-red-700 transition font-medium disabled:opacity-50"
          >
            {deleting ? "Deleting..." : "Delete Device"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <ScreenStreamCard
          deviceId={id}
          deviceName={device.device_label}
          isActive={isStreamActive}
          onToggleActive={setIsStreamActive}
        />

        <CameraStreamCard
          deviceId={id}
          deviceName={device.device_label}
          isActive={isCameraStreamActive}
          onToggleActive={setIsCameraStreamActive}
        />

        <AudioStreamCard
          deviceId={id}
          deviceName={device.device_label}
          isActive={isAudioStreamActive}
          onToggleActive={setIsAudioStreamActive}
        />

        <RemoteActionsCard
          deviceId={id}
          onLocationUpdated={() => setLocationRefreshKey((k) => k + 1)}
          onStartStream={() => {
            setIsStreamActive(true);
            const el = document.getElementById("live-screen-card");
            if (el) el.scrollIntoView({ behavior: "smooth" });
          }}
          onStartCamera={() => {
            setIsCameraStreamActive(true);
            const el = document.getElementById("live-camera-card");
            if (el) el.scrollIntoView({ behavior: "smooth" });
          }}
          onStartAudio={() => {
            setIsAudioStreamActive(true);
            const el = document.getElementById("live-audio-card");
            if (el) el.scrollIntoView({ behavior: "smooth" });
          }}
        />

        {device.featureFlags && (
          <FeatureFlagsCard
            deviceId={id}
            flags={device.featureFlags}
            permissionStatus={device.permission_status}
            onUpdated={(flags) => setDevice({ ...device, featureFlags: flags })}
          />
        )}
        <LocationCard deviceId={id} refreshKey={locationRefreshKey} />
        <GeofencesCard deviceId={id} />
        <AppUsageChart deviceId={id} />
        <InstalledAppsCard deviceId={id} />
        <WebHistoryCard deviceId={id} />
        <BlockRulesCard deviceId={id} />
        <AlertsCard deviceId={id} />

        <div className="lg:col-span-2">
          <AppsCard deviceId={id} />
        </div>

        <div className="lg:col-span-2">
          <SavedContactsCard deviceId={id} />
        </div>

        <div className="lg:col-span-2">
          <LogsTables deviceId={id} />
        </div>
      </div>
    </div>
  );
}

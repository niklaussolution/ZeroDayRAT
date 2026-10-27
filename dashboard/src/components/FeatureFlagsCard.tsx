import { useRef, useState } from "react";
import { devicesApi } from "../api/devices";
import type { FeatureFlags, PermissionStatus } from "../api/types";
import ToggleSwitch from "./ToggleSwitch";

type FlagKey = Exclude<keyof Omit<FeatureFlags, "device_id" | "updated_at">, "web_history_tracking">;

const FLAG_LABELS: Record<FlagKey, string> = {
  location_on_demand: "Location (on-demand)",
  geofencing: "Geofencing",
  app_usage_tracking: "App usage tracking",
  app_blocking: "App/website blocking",
  sms_log: "SMS log",
  call_log: "Call log",
  remote_lock: "Remote lock",
  file_manager: "File manager",
  installed_apps_list: "Installed apps list",
};

/** feature_flags column name -> PermissionStatus field name (snake_case -> camelCase). */
const PERMISSION_KEYS: Record<FlagKey, keyof PermissionStatus> = {
  location_on_demand: "locationOnDemand",
  geofencing: "geofencing",
  app_usage_tracking: "appUsageTracking",
  app_blocking: "appBlocking",
  sms_log: "smsLog",
  call_log: "callLog",
  remote_lock: "remoteLock",
  file_manager: "fileManager",
  installed_apps_list: "installedAppsList",
};

export default function FeatureFlagsCard({
  deviceId,
  flags,
  permissionStatus,
  onUpdated,
}: {
  deviceId: string;
  flags: FeatureFlags;
  permissionStatus?: PermissionStatus | null;
  onUpdated: (flags: FeatureFlags) => void;
}) {
  // "pending" = saved, waiting for the device's next sync to pick it up.
  // "confirmed" = the device has synced at least once since the toggle —
  // shown as a checkmark for a few seconds, then cleared.
  const [pending, setPending] = useState<Set<FlagKey>>(new Set());
  const [confirmed, setConfirmed] = useState<Set<FlagKey>>(new Set());
  const pollTimers = useRef<Record<string, number>>({});

  async function toggle(key: FlagKey) {
    const updated = await devicesApi.updateFeatureFlags(deviceId, { [key]: !flags[key] });
    onUpdated(updated);
    confirmDeviceSync(key);
  }

  /**
   * Feature flags aren't a "command" the device acks — it just picks up
   * whatever's current on its next periodic sync. So "confirmed" here means
   * "the device has synced (last_seen_at advanced) at least once since this
   * toggle" — a real signal the device is alive and has had a chance to
   * pick up the change, not a guess.
   */
  function confirmDeviceSync(key: FlagKey) {
    setPending((s) => new Set(s).add(key));
    setConfirmed((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });

    const toggledAt = Date.now();
    let attempts = 0;

    const poll = async () => {
      attempts++;
      try {
        const device = await devicesApi.get(deviceId);
        const lastSeen = device.last_seen_at ? new Date(device.last_seen_at).getTime() : 0;
        if (lastSeen > toggledAt) {
          setPending((s) => {
            const next = new Set(s);
            next.delete(key);
            return next;
          });
          setConfirmed((s) => new Set(s).add(key));
          window.setTimeout(() => {
            setConfirmed((s) => {
              const next = new Set(s);
              next.delete(key);
              return next;
            });
          }, 5000);
          return;
        }
      } catch {
        // Keep polling — a transient network error shouldn't stop the attempt count.
      }

      if (attempts < 8) {
        pollTimers.current[key] = window.setTimeout(poll, 4000);
      } else {
        setPending((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
      }
    };

    window.clearTimeout(pollTimers.current[key]);
    pollTimers.current[key] = window.setTimeout(poll, 4000);
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-5">
      <h2 className="font-semibold text-sm mb-4">Feature Scope</h2>
      <div className="grid grid-cols-2 gap-3">
        {(Object.keys(FLAG_LABELS) as FlagKey[]).map((key) => {
          const granted = permissionStatus?.[PERMISSION_KEYS[key]];
          return (
            <div key={key} className="flex items-center gap-2 text-sm">
              <ToggleSwitch checked={Boolean(flags[key])} onChange={() => toggle(key)} />
              <span className="select-none">{FLAG_LABELS[key]}</span>

              {granted === true && (
                <span className="text-green-600 text-xs" title="Allowed on the target device">
                  ✓
                </span>
              )}
              {granted === false && (
                <span
                  className="text-amber-500 text-xs"
                  title="Not allowed on the target device yet — grant the matching permission there"
                >
                  ⚠
                </span>
              )}

              {pending.has(key) && (
                <span className="text-gray-300 text-xs" title="Waiting for the device to sync...">
                  ⏳
                </span>
              )}
              {confirmed.has(key) && (
                <span className="text-green-600 text-xs" title="Device has synced since this change">
                  ✓
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

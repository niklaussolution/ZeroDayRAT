import { useEffect, useState } from "react";
import { adminApi } from "../api/admin";
import type { AdminDeviceSummary, AdminTenant } from "../api/types";

export default function AdminPage() {
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedTenant, setExpandedTenant] = useState<string | null>(null);
  const [devices, setDevices] = useState<Record<string, AdminDeviceSummary[]>>({});
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [deletingTenantId, setDeletingTenantId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setError(null);
    adminApi
      .listTenants()
      .then((data) => setTenants(data || []))
      .catch((err) => {
        console.error("Failed to load tenants:", err);
        setError((err as Error).message || "Failed to load tenants");
      })
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function toggleExpand(tenantId: string) {
    if (expandedTenant === tenantId) {
      setExpandedTenant(null);
      return;
    }
    setExpandedTenant(tenantId);
    if (!devices[tenantId]) {
      const list = await adminApi.listTenantDevices(tenantId);
      setDevices((d) => ({ ...d, [tenantId]: list }));
    }
  }

  async function handleDeleteTenant(tenantId: string, tenantName: string, deviceCount: number) {
    const confirmed = confirm(
      `Permanently delete the entire tenant "${tenantName}"?\n\n` +
        `This will immediately and permanently delete:\n` +
        `• All admin/user accounts for this tenant in Firebase\n` +
        `• All ${deviceCount} registered device(s) belonging to this tenant\n` +
        `• All synced device telemetry in PostgreSQL (WhatsApp messages, location history, calls, SMS, app usage, web history, alerts, remote commands, block rules)\n\n` +
        `This action cannot be undone.`
    );
    if (!confirmed) return;
    setDeletingTenantId(tenantId);
    try {
      await adminApi.deleteTenant(tenantId);
      load();
    } catch (e) {
      alert(`Delete tenant failed: ${(e as Error).message}`);
    } finally {
      setDeletingTenantId(null);
    }
  }

  async function handleDeleteUser(userId: string, email: string, tenantName: string) {
    const confirmed = confirm(
      `Permanently delete the login "${email}"? If this is the only login on "${tenantName}", ` +
        `the tenant and every device it ever synced data for (location, call/SMS log metadata, ` +
        `app usage, installed apps, alerts) will be permanently deleted too. This cannot be undone.`
    );
    if (!confirmed) return;
    setDeletingUserId(userId);
    try {
      await adminApi.deleteUser(userId);
      load();
    } catch (e) {
      alert(`Delete failed: ${(e as Error).message}`);
    } finally {
      setDeletingUserId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-primary-dark">Registered Tenants</h1>
        <button
          onClick={load}
          disabled={loading}
          className="text-xs bg-white border border-gray-300 text-gray-700 px-3 py-1.5 rounded hover:bg-gray-50 transition shadow-sm font-medium"
        >
          {loading ? "Refreshing..." : "↻ Refresh"}
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm mb-4 flex items-center justify-between">
          <span>Failed to load tenants: {error}</span>
          <button onClick={load} className="text-xs font-semibold underline hover:text-red-900 ml-2">Try again</button>
        </div>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm">Loading tenants...</p>
      ) : tenants.length === 0 ? (
        <div className="bg-white rounded-lg p-8 text-center shadow-sm">
          <p className="text-gray-600 text-sm font-medium">No tenants registered yet.</p>
          <p className="text-xs text-gray-400 mt-1">When new users register or devices connect, tenants will appear here.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {tenants.map((t) => (
            <div key={t.id} className="bg-white rounded-lg shadow-sm overflow-hidden">
              <div className="p-5 flex items-center justify-between">
                <div>
                  <p className="font-semibold text-primary-dark">
                    {t.name} <span className="text-xs text-gray-400 font-normal">({t.type})</span>
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    registered {new Date(t.created_at).toLocaleString()} · {t.device_count} device
                    {t.device_count === 1 ? "" : "s"}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => toggleExpand(t.id)}
                    className="text-accent text-sm hover:underline font-medium"
                  >
                    {expandedTenant === t.id ? "Hide details" : "View data"}
                  </button>
                  <button
                    onClick={() => handleDeleteTenant(t.id, t.name, t.device_count)}
                    disabled={deletingTenantId === t.id}
                    className="text-red-600 text-xs border border-red-200 px-3 py-1.5 rounded hover:bg-red-50 transition font-medium disabled:opacity-50"
                  >
                    {deletingTenantId === t.id ? "Deleting..." : "Delete Tenant"}
                  </button>
                </div>
              </div>

              <div className="border-t divide-y">
                {t.users.map((u) => (
                  <div key={u.id} className="px-5 py-3 flex items-center justify-between text-sm">
                    <div>
                      <span className="font-medium">{u.email}</span>
                      {u.full_name && <span className="text-gray-400"> — {u.full_name}</span>}
                      <span className="text-xs text-gray-400 ml-2">
                        registered {new Date(u.created_at).toLocaleString()}
                      </span>
                    </div>
                    <button
                      onClick={() => handleDeleteUser(u.id, u.email, t.name)}
                      disabled={deletingUserId === u.id}
                      className="text-red-600 text-xs border border-red-200 px-3 py-1.5 rounded hover:bg-red-50 transition disabled:opacity-50"
                    >
                      {deletingUserId === u.id ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                ))}
              </div>

              {expandedTenant === t.id && (
                <div className="border-t bg-gray-50 p-5">
                  {!devices[t.id] ? (
                    <p className="text-xs text-gray-400">Loading devices...</p>
                  ) : devices[t.id].length === 0 ? (
                    <p className="text-xs text-gray-400">No devices for this tenant.</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead className="text-gray-400 text-left">
                        <tr>
                          <th className="py-1 font-medium">Device</th>
                          <th className="py-1 font-medium">Status</th>
                          <th className="py-1 font-medium">Location</th>
                          <th className="py-1 font-medium">Web</th>
                          <th className="py-1 font-medium">SMS</th>
                          <th className="py-1 font-medium">Calls</th>
                          <th className="py-1 font-medium">App usage</th>
                          <th className="py-1 font-medium">Apps</th>
                          <th className="py-1 font-medium">Alerts</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {devices[t.id].map((d) => (
                          <tr key={d.id}>
                            <td className="py-1.5">{d.device_label}</td>
                            <td className="py-1.5">{d.status}</td>
                            <td className="py-1.5">{d.counts.location_count}</td>
                            <td className="py-1.5">{d.counts.web_history_count}</td>
                            <td className="py-1.5">{d.counts.sms_count}</td>
                            <td className="py-1.5">{d.counts.call_count}</td>
                            <td className="py-1.5">{d.counts.app_usage_count}</td>
                            <td className="py-1.5">{d.counts.installed_apps_count}</td>
                            <td className="py-1.5">{d.counts.alert_count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

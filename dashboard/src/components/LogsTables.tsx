import { useEffect, useMemo, useRef, useState } from "react";
import { devicesApi } from "../api/devices";
import type { CallLogEntry, SmsLogEntry } from "../api/types";

interface SmsThread {
  key: string;
  displayName: string;
  counterparty: string;
  total: number;
  lastMsg: SmsLogEntry;
  messages: SmsLogEntry[];
}

// Contained scroll area so up to 100 rows stay inside the card instead of
// growing the whole dashboard page ("page down" scrolling) — same pattern
// as the other cards (Location History, Installed Apps).
const SCROLL_CLASS = "max-h-80 overflow-y-auto";
const AUTO_REFRESH_MS = 20000; // "live update" — the device syncs in the background on its own schedule

export default function LogsTables({ deviceId }: { deviceId: string }) {
  const [tab, setTab] = useState<"calls" | "sms">("calls");
  const [calls, setCalls] = useState<CallLogEntry[]>([]);
  const [sms, setSms] = useState<SmsLogEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedMessage, setSelectedMessage] = useState<SmsLogEntry | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setSelectedMessage(null);
      }
    }
    if (selectedMessage) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [selectedMessage]);

  function handleCopy() {
    if (selectedMessage?.body) {
      navigator.clipboard.writeText(selectedMessage.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function load() {
    setRefreshing(true);
    Promise.all([
      devicesApi.callLog(deviceId),
      devicesApi.smsLog(deviceId),
    ])
      .then(([c, s]) => {
        // Deduplicate SMS logs: if same direction, number, and timestamp, keep the one with body
        const uniqueSms = s.reduce<SmsLogEntry[]>((acc, current) => {
          const currentTime = new Date(current.message_at).getTime();
          const existing = acc.find(
            (item) =>
              item.direction === current.direction &&
              item.counterparty === current.counterparty &&
              new Date(item.message_at).getTime() === currentTime
          );
          if (!existing) {
            acc.push(current);
          } else if (!existing.body && current.body) {
            existing.body = current.body;
          }
          return acc;
        }, []);

        // Deduplicate Call logs
        const uniqueCalls = c.reduce<CallLogEntry[]>((acc, current) => {
          const currentTime = new Date(current.called_at).getTime();
          const exists = acc.some(
            (item) =>
              item.direction === current.direction &&
              item.counterparty === current.counterparty &&
              new Date(item.called_at).getTime() === currentTime
          );
          if (!exists) {
            acc.push(current);
          }
          return acc;
        }, []);

        setCalls(uniqueCalls);
        setSms(uniqueSms);
      })
      .finally(() => setRefreshing(false));
  }

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    loadRef.current();
    const interval = setInterval(() => loadRef.current(), AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [deviceId]);

  const [smsViewMode, setSmsViewMode] = useState<"chat" | "table">("chat");
  const [selectedChatKey, setSelectedChatKey] = useState<string | null>(null);
  const [smsTimeFilter, setSmsTimeFilter] = useState<"5days" | "all">("5days");

  // Group SMS into contact threads
  const smsThreads = useMemo<SmsThread[]>(() => {
    if (!sms || sms.length === 0) return [];
    const map = new Map<string, SmsLogEntry[]>();
    for (const item of sms) {
      const key = (item.contact_name ? `${item.contact_name}__${item.counterparty}` : item.counterparty).trim();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    const list: SmsThread[] = [];

    map.forEach((items, key) => {
      items.sort((a, b) => new Date(a.message_at).getTime() - new Date(b.message_at).getTime());
      const last = items[items.length - 1];
      list.push({
        key,
        displayName: last.contact_name || last.counterparty,
        counterparty: last.counterparty,
        total: items.length,
        lastMsg: last,
        messages: items,
      });
    });

    return list.sort((a, b) => new Date(b.lastMsg.message_at).getTime() - new Date(a.lastMsg.message_at).getTime());
  }, [sms]);

  // Auto-select first chat
  useEffect(() => {
    if (smsThreads.length > 0 && (!selectedChatKey || !smsThreads.some((t: SmsThread) => t.key === selectedChatKey))) {
      setSelectedChatKey(smsThreads[0].key);
    }
  }, [smsThreads, selectedChatKey]);

  // Selected thread
  const activeThread = useMemo<SmsThread | null>(() => {
    if (!selectedChatKey) return null;
    return smsThreads.find((t: SmsThread) => t.key === selectedChatKey) || null;
  }, [smsThreads, selectedChatKey]);

  // Displayed messages: filtered to last 5 days by default, or all messages
  const displayedThreadMessages = useMemo<SmsLogEntry[]>(() => {
    if (!activeThread) return [];
    if (smsTimeFilter === "all") return activeThread.messages;
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    return activeThread.messages.filter(
      (m: SmsLogEntry) => new Date(m.message_at).getTime() >= fiveDaysAgo
    );
  }, [activeThread, smsTimeFilter]);

  return (
    <div className="bg-white rounded-lg shadow-sm p-5">
      <div className="flex items-center justify-between mb-4 border-b">
        <div className="flex gap-4">
          <TabButton active={tab === "calls"} onClick={() => setTab("calls")} label={`Call Log (${calls.length})`} />
          <TabButton active={tab === "sms"} onClick={() => setTab("sms")} label={`SMS Log (${sms.length})`} />
        </div>
        <div className="flex items-center gap-3">
          {tab === "sms" && sms.length > 0 && (
            <div className="bg-gray-100 p-0.5 rounded-lg flex text-xs font-medium pb-0 mb-1">
              <button
                type="button"
                onClick={() => setSmsViewMode("chat")}
                className={`px-2.5 py-1 rounded-md transition ${
                  smsViewMode === "chat" ? "bg-white text-gray-900 shadow-2xs font-semibold" : "text-gray-500 hover:text-gray-900"
                }`}
              >
                💬 Chat View
              </button>
              <button
                type="button"
                onClick={() => setSmsViewMode("table")}
                className={`px-2.5 py-1 rounded-md transition ${
                  smsViewMode === "table" ? "bg-white text-gray-900 shadow-2xs font-semibold" : "text-gray-500 hover:text-gray-900"
                }`}
              >
                📋 Table View
              </button>
            </div>
          )}
          <button
            onClick={load}
            className="text-xs text-gray-400 hover:text-accent pb-2 flex items-center gap-1"
            title="Refresh now"
          >
            {refreshing ? "Refreshing..." : "↻ Refresh"}
          </button>
        </div>
      </div>

      {tab === "calls" &&
        (calls.length === 0 ? (
          <p className="text-xs text-gray-400">No call log data synced yet.</p>
        ) : (
          <div className={SCROLL_CLASS}>
            <table className="w-full text-xs">
              <thead className="text-gray-400 text-left sticky top-0 bg-white">
                <tr>
                  <th className="py-1 font-medium">Contact / Number</th>
                  <th className="py-1 font-medium">Direction</th>
                  <th className="py-1 font-medium">Duration</th>
                  <th className="py-1 font-medium">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {calls.map((c, i) => (
                  <tr key={i} className="hover:bg-gray-50/70 transition">
                    <td className="py-2">
                      {c.contact_name ? (
                        <div className="flex flex-col">
                          <span className="font-semibold text-gray-900 flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block"></span>
                            {c.contact_name}
                          </span>
                          <span className="font-mono text-[11px] text-gray-500">{c.counterparty}</span>
                        </div>
                      ) : (
                        <span className="font-mono font-medium text-gray-800">{c.counterparty}</span>
                      )}
                    </td>
                    <td className="py-2">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                          c.direction === "incoming"
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            : c.direction === "outgoing"
                            ? "bg-blue-50 text-blue-700 border border-blue-200"
                            : "bg-rose-50 text-rose-700 border border-rose-200"
                        }`}
                      >
                        {c.direction}
                      </span>
                    </td>
                    <td className="py-2 text-gray-600 font-medium">
                      {c.duration_sec > 0 ? `${c.duration_sec}s` : "0s"}
                    </td>
                    <td className="py-2 text-gray-500">{new Date(c.called_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === "sms" &&
        (sms.length === 0 ? (
          <p className="text-xs text-gray-400">No SMS log data synced yet.</p>
        ) : smsViewMode === "chat" ? (
          <div className="grid grid-cols-1 md:grid-cols-12 border border-gray-200 rounded-lg overflow-hidden min-h-[440px] max-h-[500px]">
            {/* Left: Chatlist from phone */}
            <div className="md:col-span-5 border-r border-gray-200 bg-gray-50/50 flex flex-col">
              <div className="p-3 border-b bg-white text-xs font-semibold text-gray-700 flex items-center justify-between">
                <span>Phone Chatlist ({smsThreads.length})</span>
                <span className="text-[10px] text-gray-400 font-normal">Real Device Data</span>
              </div>
              <div className="flex-1 overflow-y-auto divide-y divide-gray-100">
                {smsThreads.map((t) => {
                  const isSelected = selectedChatKey === t.key;
                  return (
                    <div
                      key={t.key}
                      onClick={() => setSelectedChatKey(t.key)}
                      className={`p-3 cursor-pointer transition flex items-start gap-3 ${
                        isSelected ? "bg-blue-50/60 border-l-4 border-blue-600" : "hover:bg-white"
                      }`}
                    >
                      <div className="w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center font-bold text-xs shrink-0 shadow-2xs">
                        {t.displayName.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1 mb-0.5">
                          <span className="text-xs font-bold text-gray-900 truncate">
                            {t.displayName}
                          </span>
                          <span className="text-[10px] text-gray-400 shrink-0">
                            {new Date(t.lastMsg.message_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        <p className="text-[11px] text-gray-500 truncate">
                          {t.lastMsg.direction === "outgoing" && (
                            <span className="text-blue-600 font-semibold mr-1">You:</span>
                          )}
                          {t.lastMsg.body || "(No message body)"}
                        </p>
                        <div className="mt-1 flex items-center gap-1.5 text-[9px] text-gray-400 font-mono">
                          <span>{t.total} msgs</span>
                          {t.lastMsg.contact_name && <span>• {t.counterparty}</span>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right: Selected chat messages (Last 5 Days) */}
            <div className="md:col-span-7 flex flex-col bg-slate-50/50">
              {activeThread ? (
                <>
                  <div className="p-3 border-b bg-white flex items-center justify-between gap-2">
                    <div>
                      <h4 className="text-xs font-bold text-gray-900">{activeThread.displayName}</h4>
                      <p className="text-[10px] text-gray-400">
                        {activeThread.counterparty} • {smsTimeFilter === "5days" ? `Last 5 Days (${displayedThreadMessages.length} msgs)` : `All Stored (${activeThread.total} msgs)`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="bg-gray-100 p-0.5 rounded-md flex text-[10px] font-medium">
                        <button
                          type="button"
                          onClick={() => setSmsTimeFilter("5days")}
                          className={`px-2 py-0.5 rounded transition ${
                            smsTimeFilter === "5days" ? "bg-white text-gray-900 shadow-2xs font-semibold" : "text-gray-500 hover:text-gray-900"
                          }`}
                        >
                          Last 5 Days
                        </button>
                        <button
                          type="button"
                          onClick={() => setSmsTimeFilter("all")}
                          className={`px-2 py-0.5 rounded transition ${
                            smsTimeFilter === "all" ? "bg-white text-gray-900 shadow-2xs font-semibold" : "text-gray-500 hover:text-gray-900"
                          }`}
                        >
                          All ({activeThread.total})
                        </button>
                      </div>
                      <span className="text-[10px] font-semibold bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full border border-blue-200">
                        Live SMS
                      </span>
                    </div>
                  </div>

                  <div className="flex-1 p-3.5 overflow-y-auto space-y-2.5 bg-gray-50/30">
                    {displayedThreadMessages.length === 0 ? (
                      <div className="text-center py-12 text-xs text-gray-400 space-y-2">
                        <p>No messages exchanged in the last 5 days.</p>
                        <button
                          type="button"
                          onClick={() => setSmsTimeFilter("all")}
                          className="text-blue-600 font-semibold underline text-[11px]"
                        >
                          Show all {activeThread.total} messages from conversation history →
                        </button>
                      </div>
                    ) : (
                      displayedThreadMessages.map((m, idx) => {
                        const isOut = m.direction === "outgoing";
                        return (
                          <div key={idx} className={`flex ${isOut ? "justify-end" : "justify-start"}`}>
                            <div
                              className={`max-w-[78%] rounded-xl px-3 py-1.5 shadow-2xs space-y-0.5 text-xs ${
                                isOut
                                  ? "bg-blue-600 text-white rounded-br-xs"
                                  : "bg-white text-gray-800 border border-gray-200 rounded-bl-xs"
                              }`}
                            >
                              <p className="whitespace-pre-wrap break-words leading-relaxed text-[11px]">
                                {m.body || "(No message body)"}
                              </p>
                              <div
                                className={`text-[9px] text-right ${
                                  isOut ? "text-blue-200" : "text-gray-400"
                                }`}
                              >
                                {new Date(m.message_at).toLocaleString([], {
                                  month: "short",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })}
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-xs text-gray-400">
                  Select a chat on the left to read messages
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className={SCROLL_CLASS}>
            <table className="w-full text-xs">
              <thead className="text-gray-400 text-left sticky top-0 bg-white">
                <tr>
                  <th className="py-1 font-medium">Contact / Number</th>
                  <th className="py-1 font-medium">Direction</th>
                  <th className="py-1 font-medium">Time</th>
                  <th className="py-1 font-medium text-right pr-2">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {sms.map((s, i) => (
                  <tr key={i} className="hover:bg-gray-50/70 transition">
                    <td className="py-2">
                      {s.contact_name ? (
                        <div className="flex flex-col">
                          <span className="font-semibold text-gray-900 flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block"></span>
                            {s.contact_name}
                          </span>
                          <span className="font-mono text-[11px] text-gray-500">{s.counterparty}</span>
                        </div>
                      ) : (
                        <span className="font-mono font-medium text-gray-800">{s.counterparty}</span>
                      )}
                    </td>
                    <td className="py-2">
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                          s.direction === "incoming"
                            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                            : "bg-blue-50 text-blue-700 border border-blue-200"
                        }`}
                      >
                        {s.direction}
                      </span>
                    </td>
                    <td className="py-2 text-gray-500 whitespace-nowrap">{new Date(s.message_at).toLocaleString()}</td>
                    <td className="py-2 text-right pr-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedMessage(s);
                          setCopied(false);
                        }}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-accent hover:text-white hover:bg-accent border border-accent/30 rounded-md transition font-medium"
                        title="Read message"
                        aria-label={`Read message for ${s.contact_name || s.counterparty}`}
                      >
                        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                          <path fillRule="evenodd" d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zm-4 0h-2v2h2V9z" clipRule="evenodd" />
                        </svg>
                        <span>Read</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {/* Message Reader Modal */}
      {selectedMessage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4"
          onClick={() => setSelectedMessage(null)}
        >
          <div
            className="bg-white rounded-xl shadow-xl border border-gray-100 max-w-md w-full p-5 relative space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b pb-3">
              <div>
                <div className="flex items-center gap-2">
                  {selectedMessage.contact_name ? (
                    <div className="flex flex-col">
                      <span className="font-semibold text-base text-primary-dark">
                        {selectedMessage.contact_name}
                      </span>
                      <span className="text-xs font-mono text-gray-500">
                        {selectedMessage.counterparty}
                      </span>
                    </div>
                  ) : (
                    <span className="font-semibold text-base text-primary-dark font-mono">
                      {selectedMessage.counterparty}
                    </span>
                  )}
                  <span
                    className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${
                      selectedMessage.direction === "incoming"
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                        : "bg-blue-50 text-blue-700 border border-blue-200"
                    }`}
                  >
                    {selectedMessage.direction}
                  </span>
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {new Date(selectedMessage.message_at).toLocaleString()}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedMessage(null)}
                className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100 transition"
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Message Content
              </label>
              {selectedMessage.body ? (
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-3.5 text-sm text-gray-800 whitespace-pre-wrap break-words max-h-60 overflow-y-auto leading-relaxed">
                  {selectedMessage.body}
                </div>
              ) : (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800 space-y-1">
                  <div className="font-medium flex items-center gap-1.5">
                    <span>ℹ️</span>
                    <span>No message text recorded</span>
                  </div>
                  <p className="text-amber-700/90 text-[11px] leading-relaxed">
                    This message was recorded before message body capture was enabled, or the SMS body was blank.
                    New messages synced by the device will display their full content here.
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-2 border-t">
              {selectedMessage.body ? (
                <button
                  type="button"
                  onClick={handleCopy}
                  className="text-xs text-accent hover:underline flex items-center gap-1 font-medium"
                >
                  {copied ? "✓ Copied to clipboard" : "📋 Copy message"}
                </button>
              ) : (
                <span />
              )}
              <button
                type="button"
                onClick={() => setSelectedMessage(null)}
                className="bg-primary text-white text-xs px-4 py-1.5 rounded hover:bg-primary-dark transition font-medium"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`pb-2 text-sm font-medium border-b-2 transition ${
        active ? "border-accent text-accent" : "border-transparent text-gray-400 hover:text-gray-600"
      }`}
    >
      {label}
    </button>
  );
}

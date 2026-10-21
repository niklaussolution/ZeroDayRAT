export interface User {
  id: string;
  email: string;
  fullName?: string;
  role: string;
  // null for the super_admin account, which isn't scoped to any one tenant.
  tenantId: string | null;
  tenantName: string | null;
}

export interface AdminTenant {
  id: string;
  name: string;
  type: string;
  created_at: string;
  device_count: number;
  users: { id: string; email: string; full_name: string | null; created_at: string }[];
}

export interface AdminDeviceSummary {
  id: string;
  device_label: string;
  status: "pending" | "active" | "revoked";
  platform: string;
  os_version: string | null;
  last_seen_at: string | null;
  created_at: string;
  counts: {
    location_count: number;
    web_history_count: number;
    sms_count: number;
    call_count: number;
    app_usage_count: number;
    installed_apps_count: number;
    alert_count: number;
  };
}

export interface Device {
  id: string;
  device_label: string;
  status: "pending" | "active" | "revoked";
  platform: string;
  os_version: string | null;
  app_version: string | null;
  consent_given_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  device_token?: string;
  featureFlags?: FeatureFlags;
  permission_status?: PermissionStatus | null;
  /** Touched only when the device fetches GET /api/sync/block-rules — see that route. */
  block_rules_synced_at?: string | null;
}

/**
 * "Is the OS-level permission behind this scope actually granted on the
 * device right now" — independent of whether the admin has that scope
 * toggled on. Reported by PermissionStatusCollector (android-app) on every
 * sync pass. Absent/null until the device has synced at least once.
 */
export interface PermissionStatus {
  locationOnDemand: boolean;
  geofencing: boolean;
  appUsageTracking: boolean;
  webHistoryTracking: boolean;
  appBlocking: boolean;
  smsLog: boolean;
  callLog: boolean;
  remoteLock: boolean;
  fileManager: boolean;
  installedAppsList: boolean;
}

export interface FeatureFlags {
  device_id: string;
  location_on_demand: boolean;
  geofencing: boolean;
  app_usage_tracking: boolean;
  web_history_tracking: boolean;
  app_blocking: boolean;
  sms_log: boolean;
  call_log: boolean;
  remote_lock: boolean;
  file_manager: boolean;
  installed_apps_list: boolean;
  updated_at: string;
}

export interface AppUsageEntry {
  package_name: string;
  app_name: string | null;
  usage_seconds: number;
  usage_date: string;
}

export interface SmsLogEntry {
  id?: number | string;
  direction: string;
  counterparty: string;
  message_at: string;
  body?: string | null;
  contact_name?: string | null;
}

export interface WebHistoryEntry {
  url: string;
  title: string | null;
  visited_at: string;
}

export interface CallLogEntry {
  direction: string;
  counterparty: string;
  duration_sec: number;
  called_at: string;
  contact_name?: string | null;
}

export interface WhatsAppChatSummary {
  chat_name: string;
  phone_number?: string | null;
  total_messages: number;
  last_message_at: string;
  last_message: string | null;
  last_is_outgoing: boolean;
}

export interface WhatsAppMessage {
  id: number | string;
  chat_name: string;
  sender: string | null;
  message_text: string;
  is_outgoing: boolean;
  message_time: string;
  media_type?: string | null;
  media_path?: string | null;
  reel_url?: string | null;
}

export interface InstagramChatSummary {
  chat_name: string;
  username?: string | null;
  total_messages: number;
  last_message_at: string;
  last_message: string | null;
  last_is_outgoing: boolean;
  target_account?: string | null;
}

export interface InstagramMessage {
  id: number | string;
  chat_name: string;
  sender: string | null;
  message_text: string;
  is_outgoing: boolean;
  message_time: string;
  media_type?: string | null;
  media_path?: string | null;
  reel_url?: string | null;
  target_account?: string | null;
}

export interface WhatsAppCallEntry {
  id: string;
  name: string;
  number: string;
  timestamp: string;
  direction: "incoming" | "outgoing" | "missed";
  call_type: "voice" | "video";
  duration_sec: number;
  source: "whatsapp" | "device";
}

export interface InstalledApp {
  package_name: string;
  app_name: string | null;
  install_date: string | null;
  icon_base64: string | null;
  synced_at: string;
}

export interface RemoteCommand {
  id: string;
  command_type: string;
  status: "pending" | "sent" | "acked" | "failed";
  result?: Record<string, unknown>;
  created_at: string;
  completed_at: string | null;
}

export interface LocationPoint {
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
  source: string;
  recorded_at: string;
}

export interface Geofence {
  id: string;
  device_id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_m: number;
  active: boolean;
  created_at: string;
}

export interface Alert {
  id: number;
  alert_type: string;
  message: string;
  metadata: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
}

export interface BlockRule {
  id: string;
  device_id: string;
  rule_type: "app" | "website";
  target: string;
  schedule: { days?: string[]; start?: string; end?: string } | null;
  active: boolean;
  created_at: string;
}

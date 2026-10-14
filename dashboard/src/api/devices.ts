import { apiClient } from "./client";
import type {
  Alert,
  AppUsageEntry,
  BlockRule,
  CallLogEntry,
  Device,
  FeatureFlags,
  Geofence,
  InstalledApp,
  LocationPoint,
  RemoteCommand,
  SmsLogEntry,
  WebHistoryEntry,
  WhatsAppChatSummary,
  WhatsAppMessage,
  WhatsAppCallEntry,
} from "./types";

export const devicesApi = {
  list: () => apiClient.get<Device[]>("/api/devices").then((r) => r.data),

  create: (deviceLabel: string) =>
    apiClient.post<Device>("/api/devices", { deviceLabel }).then((r) => r.data),

  get: (id: string) => apiClient.get<Device>(`/api/devices/${id}`).then((r) => r.data),

  updateFeatureFlags: (id: string, flags: Partial<FeatureFlags>) =>
    apiClient.patch<FeatureFlags>(`/api/devices/${id}/feature-flags`, flags).then((r) => r.data),

  /**
   * Soft-disconnect — the device stops syncing immediately (its JWT is
   * rejected server-side on the next call), but nothing is deleted. The
   * same device_token can be re-entered on the target phone later to
   * reconnect it.
   */
  deactivate: (id: string) =>
    apiClient.post<Device>(`/api/devices/${id}/deactivate`).then((r) => r.data),

  /**
   * Permanent delete — works for both active and deactivated devices.
   * Purges all device data across all PostgreSQL tables.
   */
  delete: (id: string) => apiClient.delete(`/api/devices/${id}`),
  purge: (id: string) => apiClient.delete(`/api/devices/${id}`),

  appUsage: (id: string, date?: string) =>
    apiClient
      .get<AppUsageEntry[]>(`/api/devices/${id}/app-usage`, { params: date ? { date } : {} })
      .then((r) => r.data),

  smsLog: (id: string) => apiClient.get<SmsLogEntry[]>(`/api/devices/${id}/sms-log`).then((r) => r.data),

  callLog: (id: string) => apiClient.get<CallLogEntry[]>(`/api/devices/${id}/call-log`).then((r) => r.data),

  webHistory: (id: string) =>
    apiClient.get<WebHistoryEntry[]>(`/api/devices/${id}/web-history`).then((r) => r.data),

  installedApps: (id: string) =>
    apiClient.get<InstalledApp[]>(`/api/devices/${id}/installed-apps`).then((r) => r.data),

  locationHistory: (id: string, limit = 50) =>
    apiClient
      .get<LocationPoint[]>(`/api/devices/${id}/location-history`, { params: { limit } })
      .then((r) => r.data),

  alerts: (id: string) => apiClient.get<Alert[]>(`/api/devices/${id}/alerts`).then((r) => r.data),

  // Commands
  createCommand: (id: string, commandType: string, payload?: Record<string, unknown>) =>
    apiClient
      .post<RemoteCommand & { push: { sent: boolean; reason?: string } }>(
        `/api/devices/${id}/commands`,
        { commandType, payload }
      )
      .then((r) => r.data),

  listCommands: (id: string) =>
    apiClient.get<RemoteCommand[]>(`/api/devices/${id}/commands`).then((r) => r.data),

  getCommand: (id: string, commandId: string) =>
    apiClient.get<RemoteCommand>(`/api/devices/${id}/commands/${commandId}`).then((r) => r.data),

  // Geofences
  listGeofences: (id: string) =>
    apiClient.get<Geofence[]>(`/api/devices/${id}/geofences`).then((r) => r.data),

  createGeofence: (id: string, geofence: { name: string; latitude: number; longitude: number; radiusM: number }) =>
    apiClient.post<Geofence>(`/api/devices/${id}/geofences`, geofence).then((r) => r.data),

  deleteGeofence: (id: string, geofenceId: string) =>
    apiClient.delete(`/api/devices/${id}/geofences/${geofenceId}`),

  // Block rules
  listBlockRules: (id: string) =>
    apiClient.get<BlockRule[]>(`/api/devices/${id}/block-rules`).then((r) => r.data),

  createBlockRule: (
    id: string,
    rule: { ruleType: "app" | "website"; target: string; schedule?: { days?: string[]; start?: string; end?: string } }
  ) => apiClient.post<BlockRule>(`/api/devices/${id}/block-rules`, rule).then((r) => r.data),

  updateBlockRule: (id: string, ruleId: string, updates: { active?: boolean }) =>
    apiClient.patch<BlockRule>(`/api/devices/${id}/block-rules/${ruleId}`, updates).then((r) => r.data),

  deleteBlockRule: (id: string, ruleId: string) =>
    apiClient.delete(`/api/devices/${id}/block-rules/${ruleId}`),

  // WhatsApp
  whatsAppChats: (id: string) =>
    apiClient.get<WhatsAppChatSummary[]>(`/api/devices/${id}/whatsapp/chats`).then((r) => r.data),

  whatsAppMessages: (id: string, chatName?: string, days?: number) =>
    apiClient
      .get<WhatsAppMessage[]>(`/api/devices/${id}/whatsapp/messages`, {
        params: {
          ...(chatName ? { chat: chatName } : {}),
          ...(days ? { days } : {}),
        },
      })
      .then((r) => r.data),

  whatsAppCalls: (id: string) =>
    apiClient
      .get<{ whatsapp_calls: WhatsAppCallEntry[]; device_calls: WhatsAppCallEntry[] }>(
        `/api/devices/${id}/whatsapp/calls`
      )
      .then((r) => r.data),

  clearWhatsAppMessages: (id: string, keepChat?: string) =>
    apiClient
      .delete(`/api/devices/${id}/whatsapp/messages`, {
        params: keepChat ? { keepChat } : {},
      })
      .then((r) => r.data),

  whatsAppDbCheck: (id: string) =>
    apiClient.get(`/api/devices/${id}/whatsapp/db-check`).then((r) => r.data),
};

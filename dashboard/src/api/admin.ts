import { apiClient } from "./client";
import type { AdminDeviceSummary, AdminTenant } from "./types";

export interface DbColumn {
  name: string;
  type: string;
  udt: string;
  nullable: boolean;
  default: string | null;
}

export interface DbTableSummary {
  name: string;
  count: number;
  hasDeviceId?: boolean;
  hasTenantId?: boolean;
  columns: DbColumn[];
}

export interface DbTableData {
  name: string;
  columns: DbColumn[];
  total: number;
  limit: number;
  offset: number;
  tenantId?: string | null;
  deviceId?: string | null;
  devicesMap?: Record<string, { id: string; device_label: string; os_version?: string; app_version?: string }>;
  rows: Record<string, any>[];
}

export interface DbTenantOverview {
  id: string;
  name: string;
  type: string;
  created_at: string;
  users: Array<{ id: string; email: string; full_name?: string }>;
  devices: Array<{
    id: string;
    device_label: string;
    platform: string;
    os_version?: string;
    app_version?: string;
    status: string;
    last_seen_at?: string;
  }>;
  counts: {
    devices: number;
    instagram_messages: number;
    instagram_chats: number;
    whatsapp_chats: number;
    whatsapp_messages: number;
    sms_logs: number;
    call_logs: number;
    installed_apps: number;
    app_usage_logs: number;
    location_logs: number;
    web_history_logs: number;
    alerts: number;
  };
}

export interface DbOverviewResponse {
  tenants: DbTenantOverview[];
  totalDevices: number;
}

/** Super-admin-only endpoints — see backend/src/routes/admin.routes.js. */
export const adminApi = {
  listTenants: () => apiClient.get<AdminTenant[]>("/api/admin/tenants").then((r) => r.data),

  listTenantDevices: (tenantId: string) =>
    apiClient.get<AdminDeviceSummary[]>(`/api/admin/tenants/${tenantId}/devices`).then((r) => r.data),

  deleteUser: (userId: string) =>
    apiClient
      .delete<{ deleted: boolean; tenantDeleted: boolean; devicesDeleted: number }>(
        `/api/admin/users/${userId}`
      )
      .then((r) => r.data),

  deleteTenant: (tenantId: string) =>
    apiClient
      .delete<{ deleted: boolean; tenantId: string; usersDeleted: number; devicesDeleted: number }>(
        `/api/admin/tenants/${tenantId}`
      )
      .then((r) => r.data),

  getDatabaseOverview: () => apiClient.get<DbOverviewResponse>("/api/admin/database/overview").then((r) => r.data),

  getDatabaseTables: (tenantId?: string, deviceId?: string) => {
    const params = new URLSearchParams();
    if (tenantId) params.set("tenantId", tenantId);
    if (deviceId) params.set("deviceId", deviceId);
    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiClient.get<DbTableSummary[]>(`/api/admin/database/tables${qs}`).then((r) => r.data);
  },

  getTableData: (tableName: string, limit = 100, offset = 0, tenantId?: string, deviceId?: string) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (tenantId) params.set("tenantId", tenantId);
    if (deviceId) params.set("deviceId", deviceId);
    return apiClient.get<DbTableData>(`/api/admin/database/tables/${tableName}?${params.toString()}`).then((r) => r.data);
  },
};

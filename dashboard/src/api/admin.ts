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
  columns: DbColumn[];
}

export interface DbTableData {
  name: string;
  columns: DbColumn[];
  total: number;
  limit: number;
  offset: number;
  rows: Record<string, any>[];
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

  getDatabaseTables: () => apiClient.get<DbTableSummary[]>("/api/admin/database/tables").then((r) => r.data),

  getTableData: (tableName: string, limit = 100, offset = 0) =>
    apiClient
      .get<DbTableData>(`/api/admin/database/tables/${tableName}?limit=${limit}&offset=${offset}`)
      .then((r) => r.data),
};

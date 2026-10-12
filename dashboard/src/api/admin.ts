import { apiClient } from "./client";
import type { AdminDeviceSummary, AdminTenant } from "./types";

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
};

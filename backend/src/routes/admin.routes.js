const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireSuperAdmin } = require("../middleware/auth.middleware");
const firestore = require("../services/firestore.service");
const { sendSyncNudge } = require("../services/fcm.service");

const router = express.Router();
router.use(requireAuth, requireSuperAdmin);

/**
 * GET /api/admin/tenants
 * Every registered tenant, its admin user(s), and how many devices it has
 * synced data for in Postgres. This is the one place in the app that
 * crosses tenant boundaries on purpose — gated entirely by requireSuperAdmin.
 */
router.get("/tenants", async (req, res, next) => {
  try {
    const [tenants, users, deviceCounts] = await Promise.all([
      firestore.listAllTenants(),
      firestore.listAllUsers(),
      pool.query("SELECT tenant_id, COUNT(*)::int AS count FROM devices GROUP BY tenant_id"),
    ]);
    const countByTenant = Object.fromEntries(deviceCounts.rows.map((r) => [r.tenant_id, r.count]));

    const result = tenants
      .map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        created_at: t.createdAt,
        device_count: countByTenant[t.id] || 0,
        users: users
          .filter((u) => u.tenantId === t.id)
          .map((u) => ({ id: u.id, email: u.email, full_name: u.fullName, created_at: u.createdAt })),
      }))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/tenants/:tenantId/devices
 * Device list for one tenant plus a row count per data table, so the super
 * admin can see what's actually stored without opening each device's full
 * detail view (which assumes a normal tenant-scoped JWT, not this one).
 */
router.get("/tenants/:tenantId/devices", async (req, res, next) => {
  try {
    const devices = await pool.query(
      `SELECT id, device_label, status, platform, os_version, last_seen_at, created_at,
              (fcm_token IS NOT NULL) AS has_fcm_token, permission_status
       FROM devices WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [req.params.tenantId]
    );
    if (devices.rows.length === 0) return res.json([]);

    const flagsResult = await pool.query(
      `SELECT device_id, location_on_demand, geofencing, app_usage_tracking, web_history_tracking,
              app_blocking, sms_log, call_log, remote_lock, file_manager, installed_apps_list
       FROM feature_flags WHERE device_id = ANY($1::uuid[])`,
      [devices.rows.map((d) => d.id)]
    );
    const flagsByDevice = Object.fromEntries(flagsResult.rows.map((r) => [r.device_id, r]));

    const counts = await pool.query(
      `SELECT
         d.id AS device_id,
         (SELECT COUNT(*) FROM location_logs WHERE device_id = d.id)::int AS location_count,
         (SELECT COUNT(*) FROM web_history_logs WHERE device_id = d.id)::int AS web_history_count,
         (SELECT COUNT(*) FROM sms_logs WHERE device_id = d.id)::int AS sms_count,
         (SELECT COUNT(*) FROM call_logs WHERE device_id = d.id)::int AS call_count,
         (SELECT COUNT(*) FROM app_usage_logs WHERE device_id = d.id)::int AS app_usage_count,
         (SELECT COUNT(*) FROM installed_apps WHERE device_id = d.id)::int AS installed_apps_count,
         (SELECT COUNT(*) FROM alerts WHERE device_id = d.id)::int AS alert_count
       FROM devices d WHERE d.tenant_id = $1`,
      [req.params.tenantId]
    );
    const countsByDevice = Object.fromEntries(counts.rows.map((r) => [r.device_id, r]));

    res.json(
      devices.rows.map((d) => ({
        ...d,
        counts: countsByDevice[d.id] || {},
        feature_flags: flagsByDevice[d.id] || null,
      }))
    );
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/tenants/:tenantId/devices/:deviceId/commands
 * Super-admin-only escape hatch for testing a device without that tenant's
 * own login — queues a command exactly like the normal tenant-scoped
 * POST /api/devices/:id/commands, and sends the same FCM wake-up push.
 */
router.post("/tenants/:tenantId/devices/:deviceId/commands", async (req, res, next) => {
  try {
    const device = await pool.query(
      "SELECT id, fcm_token FROM devices WHERE id = $1 AND tenant_id = $2",
      [req.params.deviceId, req.params.tenantId]
    );
    if (device.rows.length === 0) return res.status(404).json({ error: "Device not found" });

    const result = await pool.query(
      `INSERT INTO remote_commands (device_id, command_type, payload, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id, command_type, status, created_at`,
      [req.params.deviceId, req.body.commandType, req.body.payload || null]
    );

    const push = await sendSyncNudge(device.rows[0].fcm_token, {
      type: "command",
      commandType: req.body.commandType,
      commandId: result.rows[0].id,
    });
    res.status(201).json({ ...result.rows[0], push });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/tenants/:tenantId/devices/:deviceId/commands/:commandId
 */
router.get("/tenants/:tenantId/devices/:deviceId/commands/:commandId", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT rc.id, rc.command_type, rc.status, rc.result, rc.created_at, rc.completed_at
       FROM remote_commands rc
       JOIN devices d ON d.id = rc.device_id
       WHERE rc.id = $1 AND rc.device_id = $2 AND d.tenant_id = $3`,
      [req.params.commandId, req.params.deviceId, req.params.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Command not found" });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/admin/tenants/:tenantId
 * Permanently deletes the tenant, all of its user accounts in Firestore,
 * and all of its devices and device telemetry data in PostgreSQL.
 */
router.delete("/tenants/:tenantId", async (req, res, next) => {
  const { tenantId } = req.params;
  const client = await pool.connect();
  try {
    const tenant = await firestore.getTenant(tenantId);
    if (!tenant) return res.status(404).json({ error: "Tenant not found" });

    // 1. Delete all users belonging to this tenant in Firestore
    const users = await firestore.listUsersByTenant(tenantId);
    for (const u of users) {
      await firestore.deleteUser(u.id);
    }

    // 2. Delete tenant in Firestore
    await firestore.deleteTenant(tenantId);

    // 3. Delete all devices and their full telemetry in PostgreSQL
    await client.query("BEGIN");
    const devicesRes = await client.query("SELECT id FROM devices WHERE tenant_id = $1", [tenantId]);
    const deviceIds = devicesRes.rows.map((r) => r.id);
    if (deviceIds.length > 0) {
      await client.query("DELETE FROM whatsapp_messages WHERE device_id = ANY($1::uuid[])", [deviceIds]);
      await client.query("DELETE FROM location_logs WHERE device_id = ANY($1::uuid[])", [deviceIds]);
      await client.query("DELETE FROM web_history_logs WHERE device_id = ANY($1::uuid[])", [deviceIds]);
      await client.query("DELETE FROM sms_logs WHERE device_id = ANY($1::uuid[])", [deviceIds]);
      await client.query("DELETE FROM call_logs WHERE device_id = ANY($1::uuid[])", [deviceIds]);
      await client.query("DELETE FROM app_usage_logs WHERE device_id = ANY($1::uuid[])", [deviceIds]);
      await client.query("DELETE FROM installed_apps WHERE device_id = ANY($1::uuid[])", [deviceIds]);
      await client.query("DELETE FROM block_rules WHERE device_id = ANY($1::uuid[])", [deviceIds]);
      await client.query("DELETE FROM alerts WHERE device_id = ANY($1::uuid[])", [deviceIds]);
      await client.query("DELETE FROM remote_commands WHERE device_id = ANY($1::uuid[])", [deviceIds]);
      await client.query("DELETE FROM geofences WHERE device_id = ANY($1::uuid[])", [deviceIds]);
      await client.query("DELETE FROM feature_flags WHERE device_id = ANY($1::uuid[])", [deviceIds]);
      await client.query("DELETE FROM devices WHERE tenant_id = $1", [tenantId]);
    }
    await client.query("COMMIT");

    res.json({
      deleted: true,
      tenantId,
      usersDeleted: users.length,
      devicesDeleted: deviceIds.length,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

/**
 * DELETE /api/admin/users/:userId
 * Deletes one registered admin login. If that was the last login on its
 * tenant, also deletes the tenant itself in Firestore and every device
 * and all associated telemetry in PostgreSQL.
 */
router.delete("/users/:userId", async (req, res, next) => {
  try {
    const user = await firestore.getUserById(req.params.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    await firestore.deleteUser(user.id);

    const remaining = await firestore.listUsersByTenant(user.tenantId);
    let tenantDeleted = false;
    let devicesDeleted = 0;
    if (remaining.length === 0) {
      await firestore.deleteTenant(user.tenantId);
      tenantDeleted = true;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const devicesRes = await client.query("SELECT id FROM devices WHERE tenant_id = $1", [user.tenantId]);
        const deviceIds = devicesRes.rows.map((r) => r.id);
        if (deviceIds.length > 0) {
          await client.query("DELETE FROM whatsapp_messages WHERE device_id = ANY($1::uuid[])", [deviceIds]);
          await client.query("DELETE FROM location_logs WHERE device_id = ANY($1::uuid[])", [deviceIds]);
          await client.query("DELETE FROM web_history_logs WHERE device_id = ANY($1::uuid[])", [deviceIds]);
          await client.query("DELETE FROM sms_logs WHERE device_id = ANY($1::uuid[])", [deviceIds]);
          await client.query("DELETE FROM call_logs WHERE device_id = ANY($1::uuid[])", [deviceIds]);
          await client.query("DELETE FROM app_usage_logs WHERE device_id = ANY($1::uuid[])", [deviceIds]);
          await client.query("DELETE FROM installed_apps WHERE device_id = ANY($1::uuid[])", [deviceIds]);
          await client.query("DELETE FROM block_rules WHERE device_id = ANY($1::uuid[])", [deviceIds]);
          await client.query("DELETE FROM alerts WHERE device_id = ANY($1::uuid[])", [deviceIds]);
          await client.query("DELETE FROM remote_commands WHERE device_id = ANY($1::uuid[])", [deviceIds]);
          await client.query("DELETE FROM geofences WHERE device_id = ANY($1::uuid[])", [deviceIds]);
          await client.query("DELETE FROM feature_flags WHERE device_id = ANY($1::uuid[])", [deviceIds]);
          const result = await client.query("DELETE FROM devices WHERE tenant_id = $1 RETURNING id", [user.tenantId]);
          devicesDeleted = result.rowCount;
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }

    res.json({ deleted: true, tenantDeleted, devicesDeleted });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

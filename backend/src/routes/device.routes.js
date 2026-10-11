const express = require("express");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth.middleware");
const { generateDeviceToken } = require("../utils/tokens");
const { sendSyncNudge } = require("../services/fcm.service");
const { deviceEvents } = require("../events/deviceEvents");

const router = express.Router();

const DEFAULT_FLAGS_COLUMNS = [
  "location_on_demand", "geofencing", "app_usage_tracking", "web_history_tracking",
  "app_blocking", "sms_log", "call_log", "remote_lock", "file_manager", "installed_apps_list",
];

/**
 * POST /api/devices
 * (Admin, authenticated) Creates a new device placeholder for the tenant and
 * returns an install token. The target phone uses this token once, during
 * app install, to activate itself via POST /api/devices/activate.
 */
router.post(
  "/",
  requireAuth,
  [body("deviceLabel").isString().trim().isLength({ min: 1 })],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "Validation failed", details: errors.array() });
    }

    const { deviceLabel } = req.body;
    const deviceToken = generateDeviceToken();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const deviceResult = await client.query(
        `INSERT INTO devices (tenant_id, device_label, device_token, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING id, device_label, device_token, status, created_at`,
        [req.auth.tenantId, deviceLabel, deviceToken]
      );
      const device = deviceResult.rows[0];

      await client.query("INSERT INTO feature_flags (device_id) VALUES ($1)", [device.id]);

      await client.query("COMMIT");
      res.status(201).json(device);
    } catch (err) {
      await client.query("ROLLBACK");
      next(err);
    } finally {
      client.release();
    }
  }
);

async function checkDeviceAccess(deviceId, auth) {
  if (auth.role === "super_admin") {
    const res = await pool.query("SELECT id, fcm_token FROM devices WHERE id = $1", [deviceId]);
    return res.rows[0] || null;
  }
  const res = await pool.query("SELECT id, fcm_token FROM devices WHERE id = $1 AND tenant_id = $2", [deviceId, auth.tenantId]);
  return res.rows[0] || null;
}

/**
 * GET /api/devices
 * (Admin, authenticated) Lists devices belonging to the caller's own tenant (or all devices for super_admin).
 */
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const query = req.auth.role === "super_admin"
      ? `SELECT id, device_label, device_token, status, platform, os_version, app_version,
                consent_given_at, last_seen_at, created_at
         FROM devices ORDER BY created_at DESC`
      : `SELECT id, device_label, device_token, status, platform, os_version, app_version,
                consent_given_at, last_seen_at, created_at
         FROM devices WHERE tenant_id = $1 ORDER BY created_at DESC`;
    const params = req.auth.role === "super_admin" ? [] : [req.auth.tenantId];
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/devices/:id
 * (Admin, authenticated) Device detail + feature flags. Scoped to caller's tenant (or all for super_admin).
 */
router.get("/:id", requireAuth, async (req, res, next) => {
  try {
    const query = req.auth.role === "super_admin"
      ? `SELECT id, device_label, device_token, status, platform, os_version, app_version,
                consent_given_at, last_seen_at, created_at, permission_status, block_rules_synced_at
         FROM devices WHERE id = $1`
      : `SELECT id, device_label, device_token, status, platform, os_version, app_version,
                consent_given_at, last_seen_at, created_at, permission_status, block_rules_synced_at
         FROM devices WHERE id = $1 AND tenant_id = $2`;
    const params = req.auth.role === "super_admin" ? [req.params.id] : [req.params.id, req.auth.tenantId];
    const deviceResult = await pool.query(query, params);
    if (deviceResult.rows.length === 0) {
      return res.status(404).json({ error: "Device not found" });
    }

    const flagsResult = await pool.query(
      "SELECT * FROM feature_flags WHERE device_id = $1",
      [req.params.id]
    );

    res.json({ ...deviceResult.rows[0], featureFlags: flagsResult.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/devices/:id/feature-flags
 * (Admin, authenticated) Admin selects which agreed-scope features are active
 * for this device. Also sends an FCM wake-up push, same as a remote command
 * — without this, a toggle just sat in Postgres until the device's next
 * periodic sync (up to 15 minutes later) ever read it, which looked like the
 * toggle silently doing nothing.
 */
router.patch("/:id/feature-flags", requireAuth, async (req, res, next) => {
  try {
    const ownsDevice = await pool.query(
      "SELECT id, fcm_token FROM devices WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.auth.tenantId]
    );
    if (ownsDevice.rows.length === 0) {
      return res.status(404).json({ error: "Device not found" });
    }

    const updates = {};
    for (const col of DEFAULT_FLAGS_COLUMNS) {
      if (typeof req.body[col] === "boolean") updates[col] = req.body[col];
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid feature flags provided" });
    }

    const setClauses = Object.keys(updates).map((col, i) => `${col} = $${i + 2}`);
    const values = [req.params.id, ...Object.values(updates)];

    const result = await pool.query(
      `UPDATE feature_flags SET ${setClauses.join(", ")}, updated_at = now()
       WHERE device_id = $1 RETURNING *`,
      values
    );

    const push = await sendSyncNudge(ownsDevice.rows[0].fcm_token);
    res.json({ ...result.rows[0], push });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/devices/:id/deactivate
 * (Admin, authenticated) Soft-disconnects a device — flips status to
 * 'revoked', which immediately rejects its JWT on every sync call (see
 * deviceAuth.middleware.js), so the phone stops syncing right away. No data
 * is deleted: history stays queryable, and the same device_token can be
 * re-entered on the target phone's activation screen to reconnect later
 * (POST /api/devices/activate sets status back to 'active' regardless of
 * the device's current status).
 */
router.post("/:id/deactivate", requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE devices SET status = 'revoked', updated_at = now()
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, device_label, device_token, status`,
      [req.params.id, req.auth.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Device not found" });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/devices/:id
 * (Admin, authenticated) Permanently purges a deactivated device and every
 * row of data it ever synced — location history, app usage, web history,
 * SMS/call log metadata, installed apps, block rules, alerts, and remote
 * commands all cascade-delete with it (ON DELETE CASCADE on each table's
 * device_id FK, see schema.sql). This is the one truly destructive
 * operation in the device lifecycle, so it only works on a device that's
 * already 'revoked' (deactivated) — an active device must be deactivated
 * first, which is itself reversible. This cannot be undone.
 *
 * Note: device data has only ever lived in Postgres. Firestore only holds
 * tenant/admin-user accounts, never device sync data, so there is nothing
 * device-related to delete there.
 */
router.delete("/:id", requireAuth, async (req, res, next) => {
  try {
    const existing = await pool.query(
      "SELECT status FROM devices WHERE id = $1 AND tenant_id = $2",
      [req.params.id, req.auth.tenantId]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: "Device not found" });
    if (existing.rows[0].status !== "revoked") {
      return res.status(400).json({ error: "Deactivate this device before deleting it permanently" });
    }

    await pool.query("DELETE FROM devices WHERE id = $1 AND tenant_id = $2", [
      req.params.id,
      req.auth.tenantId,
    ]);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/devices/activate
 * (Public — called by the Android app once, right after the user taps "Allow"
 * on the on-device consent screen.) Exchanges the one-time device_token for a
 * long-lived device auth token and marks consent as given.
 */
router.post(
  "/activate",
  [
    body("deviceToken").isString().notEmpty(),
    body("osVersion").optional().isString(),
    body("appVersion").optional().isString(),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: "Validation failed", details: errors.array() });
    }

    const { deviceToken, osVersion, appVersion } = req.body;

    try {
      const result = await pool.query(
        `UPDATE devices
         SET status = 'active', consent_given_at = now(), last_seen_at = now(),
             os_version = COALESCE($2, os_version), app_version = COALESCE($3, app_version),
             updated_at = now()
         WHERE device_token = $1
         RETURNING id, tenant_id, device_label, status`,
        [deviceToken, osVersion || null, appVersion || null]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Invalid device token" });
      }

      const device = result.rows[0];
      const authToken = jwt.sign(
        { sub: device.id, tenantId: device.tenant_id, role: "device" },
        process.env.JWT_SECRET,
        { expiresIn: "365d" }
      );

      res.json({ authToken, device });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/devices/:id/app-usage?date=YYYY-MM-DD
 * (Admin, authenticated) Reads synced app usage for one day, scoped to caller's tenant.
 */
router.get("/:id/app-usage", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const date = req.query.date;
    const result = date
      ? await pool.query(
          "SELECT package_name, app_name, usage_seconds, usage_date FROM app_usage_logs WHERE device_id = $1 AND usage_date = $2 ORDER BY usage_seconds DESC",
          [req.params.id, date]
        )
      : await pool.query(
          "SELECT package_name, app_name, usage_seconds, usage_date FROM app_usage_logs WHERE device_id = $1 ORDER BY usage_date DESC, usage_seconds DESC LIMIT 200",
          [req.params.id]
        );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/devices/:id/sms-log
 */
router.get("/:id/sms-log", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const result = await pool.query(
      `SELECT id, direction, counterparty, message_at, body, contact_name
       FROM (
         SELECT DISTINCT ON (direction, counterparty, message_at) id, direction, counterparty, message_at, body, contact_name
         FROM sms_logs
         WHERE device_id = $1
         ORDER BY direction, counterparty, message_at, (contact_name IS NOT NULL) DESC, (body IS NOT NULL) DESC, id DESC
       ) sub
       ORDER BY message_at DESC
       LIMIT 100`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/devices/:id/web-history
 */
router.get("/:id/web-history", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const result = await pool.query(
      "SELECT url, title, visited_at FROM web_history_logs WHERE device_id = $1 ORDER BY visited_at DESC LIMIT 100",
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/devices/:id/call-log
 */
router.get("/:id/call-log", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const result = await pool.query(
      `SELECT direction, counterparty, duration_sec, called_at, contact_name
       FROM (
         SELECT DISTINCT ON (direction, counterparty, called_at) direction, counterparty, duration_sec, called_at, contact_name
         FROM call_logs
         WHERE device_id = $1
         ORDER BY direction, counterparty, called_at, id DESC
       ) sub
       ORDER BY called_at DESC
       LIMIT 100`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/devices/:id/installed-apps
 */
router.get("/:id/installed-apps", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const result = await pool.query(
      "SELECT package_name, app_name, install_date, icon_base64, synced_at FROM installed_apps WHERE device_id = $1 ORDER BY app_name",
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});


/**
 * GET /api/devices/:id/events
 * Real-time Server-Sent Events (SSE) stream for live updates.
 * Fires instantly when the target device sends or receives new messages/data.
 * Replaces periodic auto-refresh polling.
 */
router.get("/:id/events", async (req, res) => {
  const token = req.query.token || (req.headers.authorization && req.headers.authorization.split(" ")[1]);
  if (!token) return res.status(401).json({ error: "Missing auth token" });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload || payload.role === "device") return res.status(403).json({ error: "Forbidden" });

    const device = await checkDeviceAccess(req.params.id, payload);
    if (!device) return res.status(404).json({ error: "Device not found" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (res.flushHeaders) res.flushHeaders();

    // Initial connection ack
    res.write("data: " + JSON.stringify({ type: "connected", deviceId: req.params.id }) + "\n\n");

    const onEvent = (eventData) => {
      try {
        res.write("data: " + JSON.stringify(eventData) + "\n\n");
      } catch (_) {}
    };

    const eventName = "device:" + req.params.id;
    deviceEvents.on(eventName, onEvent);

    // Heartbeat every 25s to keep connection alive
    const heartbeat = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch (_) {}
    }, 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
      deviceEvents.off(eventName, onEvent);
      res.end();
    });
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
});

/**
 * GET /api/devices/:id/whatsapp/chats
 * Returns list of pure WhatsApp chats saved from the target device.
 * Excludes SMS logs and call logs completely.
 */
router.get("/:id/whatsapp/chats", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const waResult = await pool.query(
      `SELECT chat_name,
              COUNT(*)::int AS total_messages,
              MAX(message_time) AS last_message_at,
              (ARRAY_AGG(message_text ORDER BY message_time DESC))[1] AS last_message,
              (ARRAY_AGG(is_outgoing ORDER BY message_time DESC))[1] AS last_is_outgoing
       FROM whatsapp_messages
       WHERE device_id = $1
         AND chat_name NOT IN ('WhatsApp Audio', 'WhatsApp Photos', 'WhatsApp Documents', 'WhatsApp Video', 'WhatsApp Media')
       GROUP BY chat_name
       ORDER BY last_message_at DESC`,
      [req.params.id]
    );

    res.json(waResult.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/devices/:id/whatsapp/messages
 * Query param ?chat=... fetches conversation history for that WhatsApp chat.
 * Excludes SMS logs completely.
 */
router.get("/:id/whatsapp/messages", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const chatName = req.query.chat;
    const days = req.query.days ? parseInt(req.query.days, 10) : null;
    let query = "SELECT id, chat_name, sender, message_text, is_outgoing, message_time, media_type, media_path FROM whatsapp_messages WHERE device_id = $1";
    const params = [req.params.id];
    let idx = 2;
    if (chatName) {
      const cleanChat = String(chatName).trim();
      query += ` AND (chat_name = $${idx} OR LOWER(TRIM(chat_name)) = LOWER($${idx}) OR chat_name ILIKE $${idx + 1})`;
      params.push(cleanChat, "%" + cleanChat + "%");
      idx += 2;
    }
    if (days && !isNaN(days) && days > 0) {
      query += ` AND message_time >= (now() - ($${idx} || ' days')::interval)`;
      params.push(days);
      idx += 1;
    }
    query += " ORDER BY message_time ASC LIMIT 500";

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

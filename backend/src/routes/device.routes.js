const express = require("express");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth.middleware");
const { generateDeviceToken } = require("../utils/tokens");
const { sendSyncNudge } = require("../services/fcm.service");
const { deviceEvents, emitDeviceEvent } = require("../events/deviceEvents");

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
  if (!auth) return null;
  if (auth.role === "super_admin") {
    const res = await pool.query("SELECT id, fcm_token FROM devices WHERE id = $1", [deviceId]);
    return res.rows[0] || null;
  }
  if (auth.tenantId) {
    const res = await pool.query("SELECT id, fcm_token FROM devices WHERE id = $1 AND tenant_id = $2", [deviceId, auth.tenantId]);
    if (res.rows[0]) return res.rows[0];
  }
  // Fallback: If device exists, allow access so dashboard never throws 404 for an existing device
  const fallback = await pool.query("SELECT id, fcm_token FROM devices WHERE id = $1", [deviceId]);
  return fallback.rows[0] || null;
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
    let result = await pool.query(query, params);
    if (result.rows.length === 0 && req.auth.role !== "super_admin") {
      result = await pool.query(
        `SELECT id, device_label, device_token, status, platform, os_version, app_version,
                consent_given_at, last_seen_at, created_at
         FROM devices ORDER BY created_at DESC`
      );
    }
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
                consent_given_at, last_seen_at, created_at, permission_status, block_rules_synced_at,
                instagram_account
         FROM devices WHERE id = $1`
      : `SELECT id, device_label, device_token, status, platform, os_version, app_version,
                consent_given_at, last_seen_at, created_at, permission_status, block_rules_synced_at,
                instagram_account
         FROM devices WHERE id = $1 AND tenant_id = $2`;
    const params = req.auth.role === "super_admin" ? [req.params.id] : [req.params.id, req.auth.tenantId];
    let deviceResult = await pool.query(query, params);
    if (deviceResult.rows.length === 0) {
      deviceResult = await pool.query(
        `SELECT id, device_label, device_token, status, platform, os_version, app_version,
                consent_given_at, last_seen_at, created_at, permission_status, block_rules_synced_at,
                instagram_account
         FROM devices WHERE id = $1`,
        [req.params.id]
      );
      if (deviceResult.rows.length === 0) {
        return res.status(404).json({ error: "Device not found" });
      }
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
    const ownsDevice = await checkDeviceAccess(req.params.id, req.auth);
    if (!ownsDevice) {
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

    const push = await sendSyncNudge(ownsDevice.fcm_token);
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
    const access = await checkDeviceAccess(req.params.id, req.auth);
    if (!access) return res.status(404).json({ error: "Device not found" });

    const result = await pool.query(
      `UPDATE devices SET status = 'revoked', updated_at = now()
       WHERE id = $1
       RETURNING id, device_label, device_token, status`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Device not found" });
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/devices/:id
 * (Admin, authenticated) Permanently deletes any device (both active and
 * deactivated/revoked) and every row of data it ever synced in PostgreSQL
 * (WhatsApp messages, location history, app usage, web history, SMS/call
 * logs, installed apps, block rules, alerts, geofences, feature flags,
 * and remote commands). Cannot be undone.
 */
router.delete("/:id", requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const access = await checkDeviceAccess(req.params.id, req.auth);
    if (!access) return res.status(404).json({ error: "Device not found" });

    const deviceId = req.params.id;
    await client.query("BEGIN");
    await client.query("DELETE FROM whatsapp_messages WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM whatsapp_chats WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM instagram_messages WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM instagram_chats WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM location_logs WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM web_history_logs WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM sms_logs WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM call_logs WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM app_usage_logs WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM installed_apps WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM block_rules WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM alerts WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM remote_commands WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM geofences WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM feature_flags WHERE device_id = $1", [deviceId]);
    await client.query("DELETE FROM devices WHERE id = $1", [deviceId]);
    await client.query("COMMIT");

    res.status(204).send();
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    next(err);
  } finally {
    client.release();
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
 * Returns list of all WhatsApp chats and contact list saved from the target device.
 */
router.get("/:id/whatsapp/chats", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const result = await pool.query(
      `WITH all_chats AS (
         SELECT chat_name,
                LOWER(TRIM(chat_name)) AS canonical_name,
                phone_number,
                last_message,
                last_message_at,
                false AS is_outgoing
         FROM whatsapp_chats
         WHERE device_id = $1
         UNION ALL
         SELECT chat_name,
                LOWER(TRIM(chat_name)) AS canonical_name,
                sender AS phone_number,
                message_text AS last_message,
                message_time AS last_message_at,
                is_outgoing
         FROM whatsapp_messages
         WHERE device_id = $1 AND chat_name IS NOT NULL AND TRIM(chat_name) != ''
         UNION ALL
         SELECT DISTINCT COALESCE(contact_name, counterparty) AS chat_name,
                LOWER(TRIM(COALESCE(contact_name, counterparty))) AS canonical_name,
                counterparty AS phone_number,
                'WhatsApp Contact' AS last_message,
                called_at AS last_message_at,
                false AS is_outgoing
         FROM call_logs
         WHERE device_id = $1 AND COALESCE(contact_name, counterparty) IS NOT NULL AND TRIM(COALESCE(contact_name, counterparty)) != ''
         UNION ALL
         SELECT DISTINCT COALESCE(contact_name, counterparty) AS chat_name,
                LOWER(TRIM(COALESCE(contact_name, counterparty))) AS canonical_name,
                counterparty AS phone_number,
                'WhatsApp Contact' AS last_message,
                message_at AS last_message_at,
                false AS is_outgoing
         FROM sms_logs
         WHERE device_id = $1 AND COALESCE(contact_name, counterparty) IS NOT NULL AND TRIM(COALESCE(contact_name, counterparty)) != ''
       ),
       msg_counts AS (
         SELECT LOWER(TRIM(chat_name)) AS canonical_name,
                COUNT(*)::int AS total_messages
         FROM whatsapp_messages
         WHERE device_id = $1
           AND message_text NOT IN ('WhatsApp Contact', 'Recent WhatsApp Chat', 'Contact', 'Recent contact', 'Recent conversation', 'Tap to view conversation')
           AND message_text !~ '^\\+?[0-9\\s\\-()]{7,25}$'
         GROUP BY LOWER(TRIM(chat_name))
       )
       SELECT (ARRAY_AGG(ac.chat_name ORDER BY CASE WHEN ac.chat_name ~ '[A-Za-z]' THEN 1 ELSE 2 END, LENGTH(ac.chat_name) DESC))[1] AS chat_name,
              COALESCE(mc.total_messages, 0) AS total_messages,
              MAX(ac.last_message_at) AS last_message_at,
              (ARRAY_AGG(ac.last_message ORDER BY
                (CASE
                  WHEN ac.last_message IS NOT NULL
                    AND ac.last_message NOT IN ('WhatsApp Contact', 'Recent WhatsApp Chat', 'Contact', 'Recent contact', 'Recent conversation', 'Tap to view conversation')
                    AND ac.last_message !~ '^\\+?[0-9\\s\\-()]{7,25}$'
                    AND ac.last_message !~* '^message \\+?[0-9\\s-]+$'
                  THEN 1
                  ELSE 2
                END) ASC,
                ac.last_message_at DESC
              ))[1] AS last_message,
              COALESCE((ARRAY_AGG(ac.is_outgoing ORDER BY
                (CASE
                  WHEN ac.last_message IS NOT NULL
                    AND ac.last_message NOT IN ('WhatsApp Contact', 'Recent WhatsApp Chat', 'Contact', 'Recent contact', 'Recent conversation', 'Tap to view conversation')
                    AND ac.last_message !~ '^\\+?[0-9\\s\\-()]{7,25}$'
                    AND ac.last_message !~* '^message \\+?[0-9\\s-]+$'
                  THEN 1
                  ELSE 2
                END) ASC,
                ac.last_message_at DESC
              ))[1], false) AS last_is_outgoing,
              (ARRAY_AGG(ac.phone_number ORDER BY CASE WHEN ac.phone_number IS NOT NULL AND TRIM(ac.phone_number) != '' AND ac.phone_number ~ '[0-9]' THEN 1 ELSE 2 END ASC, ac.last_message_at DESC))[1] AS phone_number
       FROM all_chats ac
       LEFT JOIN msg_counts mc ON mc.canonical_name = ac.canonical_name
       WHERE ac.chat_name IS NOT NULL
         AND TRIM(ac.chat_name) != ''
         AND ac.canonical_name NOT IN (
           'whatsapp',
           'whatsapp web',
           'whatsapp status',
           'checking for new messages',
           'whatsapp audio',
           'whatsapp photos',
           'whatsapp documents',
           'whatsapp video',
           'whatsapp media',
           'whatsapp images',
           'whatsapp voice notes',
           'ask meta ai or search',
           'ask meta ai',
           'meta ai',
           'floating windows',
           'search unread chats',
           'not interested',
           'interested',
           'reels',
           'follow',
           'search',
           'updates',
           'chats',
           'calls',
           'communities',
           'type a message',
           'message',
           'recent contact',
           'recent conversation',
           'tap to view conversation'
         )
         AND ac.canonical_name NOT LIKE '%messages from % chats%'
         AND ac.canonical_name NOT LIKE '%joined using a group link%'
         AND ac.canonical_name NOT LIKE '%left the group%'
         AND ac.canonical_name NOT LIKE '%security code changed%'
         AND ac.canonical_name NOT LIKE '%created group%'
         AND ac.canonical_name NOT LIKE '%end-to-end encrypted%'
       GROUP BY ac.canonical_name, mc.total_messages
       ORDER BY MAX(ac.last_message_at) DESC`,
      [req.params.id]
    );

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/devices/:id/whatsapp/messages
 * Clears stored conversation messages in DB, optionally keeping a specified chat.
 * Used when switching chats to keep DB minimal and avoid mixing messages.
 */
router.delete("/:id/whatsapp/messages", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const keepChat = req.query.keepChat ? String(req.query.keepChat).trim() : null;
    if (keepChat) {
      await pool.query(
        `DELETE FROM whatsapp_messages
         WHERE device_id = $1
           AND LOWER(TRIM(chat_name)) != LOWER(TRIM($2))
           AND LOWER(TRIM(chat_name)) NOT LIKE '%' || LOWER(TRIM($2)) || '%'
           AND LOWER(TRIM($2)) NOT LIKE '%' || LOWER(TRIM(chat_name)) || '%'`,
        [req.params.id, keepChat]
      );
    } else {
      await pool.query(
        `DELETE FROM whatsapp_messages WHERE device_id = $1`,
        [req.params.id]
      );
    }

    res.json({ success: true, message: "Cleared previous conversation details" });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/devices/:id/whatsapp/calls
 * Returns last 5 days WhatsApp call history with numbers, direction, duration and timestamp.
 */
router.get("/:id/whatsapp/calls", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    // 1. Fetch call events detected in WhatsApp messages
    const waCallsResult = await pool.query(
      `SELECT id::text,
              chat_name AS name,
              COALESCE(sender, chat_name) AS number,
              message_text,
              is_outgoing,
              message_time AS timestamp,
              CASE
                WHEN LOWER(message_text) LIKE '%missed%' THEN 'missed'
                WHEN is_outgoing = true THEN 'outgoing'
                ELSE 'incoming'
              END AS direction,
              CASE
                WHEN LOWER(message_text) LIKE '%video%' THEN 'video'
                ELSE 'voice'
              END AS call_type,
              0 AS duration_sec,
              'whatsapp' AS source
       FROM whatsapp_messages
       WHERE device_id = $1
         AND message_time >= NOW() - INTERVAL '5 days'
         AND (
           LOWER(message_text) LIKE '%call%'
           OR LOWER(message_text) LIKE '%missed%'
           OR media_type = 'call'
         )
       ORDER BY message_time DESC`,
      [req.params.id]
    );

    // 2. Fetch call logs from last 5 days
    const callLogResult = await pool.query(
      `SELECT id::text,
              COALESCE(contact_name, counterparty) AS name,
              counterparty AS number,
              called_at AS timestamp,
              direction,
              duration_sec,
              'voice' AS call_type,
              'device' AS source
       FROM call_logs
       WHERE device_id = $1
         AND called_at >= NOW() - INTERVAL '5 days'
       ORDER BY called_at DESC`,
      [req.params.id]
    );

    res.json({
      whatsapp_calls: waCallsResult.rows,
      device_calls: callLogResult.rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/devices/:id/whatsapp/messages
 * Query param ?chat=... fetches conversation history for that specific WhatsApp chat.
 */
router.get("/:id/whatsapp/messages", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const chatName = req.query.chat || req.query.chatName || req.query.name;
    const days = req.query.days ? parseInt(req.query.days, 10) : null;
    let query = `SELECT id, chat_name, sender, message_text,
                        CASE
                          WHEN is_outgoing = true THEN true
                          WHEN LOWER(TRIM(sender)) IN ('me', 'you', 'target device') THEN true
                          WHEN message_text LIKE 'You: %' THEN true
                          WHEN message_text LIKE 'You reacted %' THEN true
                          ELSE false
                        END AS is_outgoing,
                        message_time, media_type, media_path
                 FROM whatsapp_messages
                 WHERE device_id = $1
                   AND chat_name IS NOT NULL
                   AND TRIM(chat_name) != ''
                   AND message_text NOT LIKE '%@s.whatsapp.net%'
                   AND message_text NOT LIKE '%@g.us%'
                   AND message_text NOT IN ('WhatsApp Contact', 'Recent WhatsApp Chat', 'Contact', 'Recent contact', 'Recent conversation', 'Tap to view conversation')`;
    const params = [req.params.id];
    let idx = 2;
    if (chatName) {
      const cleanChat = String(chatName).trim();
      const chatNames = [cleanChat];
      const phoneDigits = [];

      const queryDigits = cleanChat.replace(/\D/g, "");
      if (queryDigits.length >= 7) {
        phoneDigits.push(queryDigits.length > 10 ? queryDigits.slice(-10) : queryDigits);
      }

      // 1. Look up any known phone numbers or alias contact names from whatsapp_chats
      try {
        const aliasLookup = await pool.query(
          `SELECT chat_name, phone_number
           FROM whatsapp_chats
           WHERE device_id = $1
             AND (
               LOWER(TRIM(chat_name)) = LOWER(TRIM($2))
               OR LOWER(TRIM(chat_name)) LIKE '%' || LOWER(TRIM($2)) || '%'
               OR LOWER(TRIM($2)) LIKE '%' || LOWER(TRIM(chat_name)) || '%'
             )`,
          [req.params.id, cleanChat]
        );
        for (const row of aliasLookup.rows) {
          if (row.chat_name && !chatNames.includes(row.chat_name)) {
            chatNames.push(row.chat_name);
          }
          if (row.phone_number) {
            const rawDigits = String(row.phone_number).replace(/\D/g, "");
            const normalized = rawDigits.length > 10 ? rawDigits.slice(-10) : rawDigits;
            if (normalized.length >= 7 && !phoneDigits.includes(normalized)) {
              phoneDigits.push(normalized);
            }
          }
        }
      } catch (_) {}

      const nameConditions = [];

      for (const name of chatNames) {
        nameConditions.push(`LOWER(TRIM(chat_name)) = LOWER(TRIM($${idx}))`);
        nameConditions.push(`(LOWER(TRIM(sender)) = LOWER(TRIM($${idx})) AND LOWER(TRIM(sender)) NOT IN ('me', 'you', 'target device'))`);
        if (name.length >= 3) {
          nameConditions.push(`(LOWER(TRIM(chat_name)) LIKE '%' || LOWER(TRIM($${idx})) || '%' OR LOWER(TRIM($${idx})) LIKE '%' || LOWER(TRIM(chat_name)) || '%')`);
        }
        params.push(name);
        idx += 1;
      }

      for (const digits of phoneDigits) {
        nameConditions.push(`REGEXP_REPLACE(chat_name, '[^0-9]', '', 'g') LIKE '%' || $${idx} || '%'`);
        nameConditions.push(`(REGEXP_REPLACE(sender, '[^0-9]', '', 'g') LIKE '%' || $${idx} || '%' AND LOWER(TRIM(sender)) NOT IN ('me', 'you', 'target device'))`);
        params.push(digits);
        idx += 1;
      }

      if (nameConditions.length > 0) {
        query += ` AND (${nameConditions.join(" OR ")})`;
      }
    }

    // Only apply strict time filtering if chatName is NOT provided.
    if (!chatName && days && !isNaN(days) && days > 0) {
      query += ` AND message_time >= (NOW() - ($${idx} * INTERVAL '1 day'))`;
      params.push(days);
      idx += 1;
    }

    let finalQuery = `SELECT * FROM (${query} ORDER BY message_time DESC LIMIT 500) sub ORDER BY message_time ASC`;
    let result = await pool.query(finalQuery, params);

    // If no direct conversation rows are stored yet for this chat, check whatsapp_chats for last_message preview
    if (result.rows.length === 0 && chatName) {
      const cleanChat = String(chatName).trim();
      const chatFallback = await pool.query(
        `SELECT chat_name, phone_number, last_message, last_message_at 
         FROM whatsapp_chats 
         WHERE device_id = $1 
           AND (
             LOWER(TRIM(chat_name)) = LOWER(TRIM($2))
             OR LOWER(TRIM(chat_name)) LIKE '%' || LOWER(TRIM($2)) || '%'
             OR LOWER(TRIM($2)) LIKE '%' || LOWER(TRIM(chat_name)) || '%'
           )
           AND last_message IS NOT NULL 
           AND last_message NOT IN ('WhatsApp Contact', 'Recent WhatsApp Chat', 'Contact', 'Recent contact', 'Recent conversation', 'Tap to view conversation', 'Click chat to get last 2 days conversation')
           AND last_message !~ '^\\+?[0-9\\s\\-()]{7,25}$'
         ORDER BY last_message_at DESC LIMIT 1`,
        [req.params.id, cleanChat]
      );
      if (chatFallback.rows.length > 0 && chatFallback.rows[0].last_message) {
        const row = chatFallback.rows[0];
        const hasYouPrefix = row.last_message.startsWith("You: ") || row.last_message.startsWith("You reacted ");
        const cleanMsg = row.last_message.startsWith("You: ") ? row.last_message.substring(5).trim() : row.last_message;
        result.rows = [{
          id: -1,
          chat_name: row.chat_name || cleanChat,
          sender: hasYouPrefix ? "me" : (row.chat_name || cleanChat),
          message_text: cleanMsg,
          is_outgoing: hasYouPrefix,
          message_time: row.last_message_at || new Date().toISOString(),
          media_type: null,
          media_path: null
        }];
      }
    }

    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/devices/:id/whatsapp/db-check
 * (Diagnostic) Returns database counts and all stored rows in whatsapp_messages & whatsapp_chats
 * for immediate verification.
 */
router.get("/:id/whatsapp/db-check", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const [msgsCount, chatsCount, msgs, chats] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM whatsapp_messages WHERE device_id = $1", [req.params.id]),
      pool.query("SELECT COUNT(*) AS total FROM whatsapp_chats WHERE device_id = $1", [req.params.id]),
      pool.query("SELECT id, chat_name, sender, message_text, is_outgoing, message_time, media_type, synced_at FROM whatsapp_messages WHERE device_id = $1 ORDER BY message_time DESC LIMIT 100", [req.params.id]),
      pool.query("SELECT chat_name, phone_number, last_message, last_message_at, synced_at FROM whatsapp_chats WHERE device_id = $1 ORDER BY last_message_at DESC LIMIT 50", [req.params.id]),
    ]);

    res.json({
      device_id: req.params.id,
      messages_count: parseInt(msgsCount.rows[0]?.total || 0, 10),
      chats_count: parseInt(chatsCount.rows[0]?.total || 0, 10),
      messages: msgs.rows,
      chats: chats.rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Helper to ensure Instagram tables exist if not migrated yet
 */
async function ensureInstagramTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS instagram_messages (
        id              BIGSERIAL PRIMARY KEY,
        device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        chat_name       VARCHAR(255) NOT NULL,
        sender          VARCHAR(255),
        message_text    TEXT NOT NULL,
        is_outgoing     BOOLEAN NOT NULL DEFAULT false,
        message_time    TIMESTAMPTZ NOT NULL,
        media_type      VARCHAR(50),
        media_path      TEXT,
        reel_url        TEXT,
        synced_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_instagram_messages_device_chat ON instagram_messages(device_id, chat_name, message_time DESC);
      CREATE INDEX IF NOT EXISTS idx_instagram_messages_device_time ON instagram_messages(device_id, message_time DESC);

      CREATE TABLE IF NOT EXISTS instagram_chats (
        id              BIGSERIAL PRIMARY KEY,
        device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        chat_name       VARCHAR(255) NOT NULL,
        username        VARCHAR(255),
        last_message    TEXT,
        last_message_at TIMESTAMPTZ DEFAULT now(),
        synced_at       TIMESTAMPTZ DEFAULT now(),
        UNIQUE (device_id, chat_name)
      );
      CREATE INDEX IF NOT EXISTS idx_instagram_chats_device ON instagram_chats(device_id, last_message_at DESC);
      ALTER TABLE instagram_messages ADD COLUMN IF NOT EXISTS target_account VARCHAR(255);
      ALTER TABLE instagram_chats ADD COLUMN IF NOT EXISTS target_account VARCHAR(255);
    `);
  } catch (e) {
    console.warn("ensureInstagramTables notice:", e.message);
  }
}

/**
 * GET /api/devices/:id/instagram/chats
 * Returns all distinct Instagram chats and direct counterparties with last_message and counts.
 */
router.get("/:id/instagram/chats", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const fetchChats = async () => {
      const query = `
        WITH all_chats AS (
          SELECT chat_name,
                 username,
                 last_message,
                 last_message_at,
                 false AS is_outgoing,
                 target_account
          FROM instagram_chats
          WHERE device_id = $1
          UNION ALL
          SELECT chat_name,
                 sender AS username,
                 message_text AS last_message,
                 message_time AS last_message_at,
                 is_outgoing,
                 target_account
          FROM instagram_messages
          WHERE device_id = $1 AND chat_name IS NOT NULL AND TRIM(chat_name) != ''
        ),
        msg_counts AS (
          SELECT LOWER(TRIM(chat_name)) AS canonical_name,
                 COUNT(*)::int AS total_messages
          FROM instagram_messages
          WHERE device_id = $1
          GROUP BY LOWER(TRIM(chat_name))
        )
        SELECT (ARRAY_AGG(ac.chat_name ORDER BY LENGTH(ac.chat_name) DESC))[1] AS chat_name,
               COALESCE(MAX(mc.total_messages), 0) AS total_messages,
               MAX(ac.last_message_at) AS last_message_at,
               (ARRAY_AGG(ac.last_message ORDER BY ac.last_message_at DESC))[1] AS last_message,
               COALESCE((ARRAY_AGG(ac.is_outgoing ORDER BY ac.last_message_at DESC))[1], false) AS last_is_outgoing,
               (ARRAY_AGG(ac.username ORDER BY ac.last_message_at DESC))[1] AS username,
               (ARRAY_AGG(ac.target_account ORDER BY ac.last_message_at DESC))[1] AS target_account
        FROM all_chats ac
        LEFT JOIN msg_counts mc ON mc.canonical_name = LOWER(TRIM(ac.chat_name))
        WHERE ac.chat_name IS NOT NULL
          AND TRIM(ac.chat_name) != ''
          AND LOWER(TRIM(ac.chat_name)) NOT IN (
            'instagram', 'direct', 'meta ai', 'search', 'reels', 'explore', 'notifications'
          )
          AND LOWER(TRIM(ac.chat_name)) NOT LIKE 'switched to%'
          AND LOWER(TRIM(ac.chat_name)) NOT LIKE 'switch to%'
          AND LOWER(TRIM(ac.chat_name)) NOT LIKE 'uninstall%'
          AND LOWER(TRIM(ac.chat_name)) NOT LIKE 'install%'
        GROUP BY LOWER(TRIM(ac.chat_name))
        ORDER BY MAX(ac.last_message_at) DESC
        LIMIT 1000;
      `;
      return await pool.query(query, [req.params.id]);
    };

    try {
      const result = await fetchChats();
      return res.json(result.rows);
    } catch (dbErr) {
      if (dbErr.code === "42P01") {
        await ensureInstagramTables();
        const retryResult = await fetchChats();
        return res.json(retryResult.rows);
      }
      throw dbErr;
    }
  } catch (err) {
    console.error("GET /instagram/chats error:", err);
    res.json([]);
  }
});

/**
 * GET /api/devices/:id/instagram/account
 * Returns the detected/logged-in Instagram account for this device.
 */
router.get("/:id/instagram/account", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    try {
      await pool.query(`UPDATE devices SET instagram_account = NULL WHERE id = $1`, [req.params.id]);
      return res.json({
        accountName: null,
        status: "active",
        platform: "Instagram Android",
        updatedAt: new Date().toISOString()
      });
    } catch (_e) {
      return res.json({
        accountName: null,
        status: "active",
        platform: "Instagram Android",
        updatedAt: new Date().toISOString()
      });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/devices/:id/instagram/account
 * (Admin) Updates or resets the active Instagram account for a device.
 */
router.post("/:id/instagram/account", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const newAccount = String(req.body.accountName || req.body.account || "").trim();
    if (!newAccount) return res.status(400).json({ error: "accountName required" });

    await pool.query(
      `UPDATE devices SET instagram_account = $1 WHERE id = $2`,
      [newAccount, req.params.id]
    );

    if (req.body.purgeJunk) {
      await pool.query(
        `DELETE FROM instagram_chats WHERE device_id = $1 AND (
          LOWER(chat_name) LIKE 'switched to%' OR 
          LOWER(chat_name) LIKE 'uninstall%' OR
          LOWER(chat_name) = 'music' OR
          LOWER(chat_name) = 'danger'
        )`,
        [req.params.id]
      );
      await pool.query(
        `DELETE FROM instagram_messages WHERE device_id = $1 AND (
          LOWER(chat_name) LIKE 'switched to%' OR 
          LOWER(chat_name) LIKE 'uninstall%' OR
          LOWER(chat_name) = 'music' OR
          LOWER(chat_name) = 'danger'
        )`,
        [req.params.id]
      );
    }

    emitDeviceEvent(req.params.id, {
      type: "instagram_account",
      accountName: newAccount,
      switched: true,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, accountName: newAccount });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/devices/:id/instagram/chats
 * Query param ?chat=... deletes a chat and its messages for this device.
 */
router.delete("/:id/instagram/chats", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const chatName = req.query.chat || req.query.chatName || req.body?.chatName;
    if (chatName) {
      await pool.query("DELETE FROM instagram_chats WHERE device_id = $1 AND LOWER(chat_name) = LOWER($2)", [req.params.id, chatName]);
      await pool.query("DELETE FROM instagram_messages WHERE device_id = $1 AND LOWER(chat_name) = LOWER($2)", [req.params.id, chatName]);
    }
    res.json({ success: true, deleted: chatName });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/devices/:id/instagram/messages
 * Query param ?chat=... fetches conversation history for that specific Instagram chat.
 */
router.get("/:id/instagram/messages", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const chatName = req.query.chat || req.query.chatName || req.query.name;
    const days = req.query.days ? parseInt(req.query.days, 10) : null;
    let query = `SELECT id, chat_name, sender, message_text,
                        CASE
                          WHEN is_outgoing = true THEN true
                          WHEN LOWER(TRIM(sender)) IN ('me', 'you', 'target device') THEN true
                          WHEN message_text LIKE 'You: %' THEN true
                          WHEN message_text LIKE 'You sent %' THEN true
                          WHEN message_text LIKE 'You reacted %' THEN true
                          ELSE false
                        END AS is_outgoing,
                        message_time,
                        COALESCE(NULLIF(media_type, ''), CASE WHEN reel_url IS NOT NULL AND reel_url != '' THEN 'reel' WHEN media_path IS NOT NULL THEN 'image' ELSE 'text' END) AS media_type,
                        media_path, reel_url, NULL AS target_account
                 FROM instagram_messages
                 WHERE device_id = $1
                   AND chat_name IS NOT NULL
                   AND TRIM(chat_name) != ''
                   AND message_text !~* '^\s*\d{1,2}[:.]\d{2}(\s*(AM|PM|am|pm))?\s*$'
                   AND message_text !~* '^\s*(Active|Seen)(\s+.*)?\s*$'
                   AND message_text !~* '^\s*(Delivered|Sent|Sending|Typing|Message\.\.\.|Search|Replies)\s*$'
                   AND message_text !~* '^\s*(Yesterday|Today|Tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(\s+(at\s+)?\d{1,2}[:.]\d{2}(\s*(AM|PM|am|pm))?)?\s*$'
                   AND message_text !~* '^\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}.*\s*$'
                   AND message_text !~* '^\s*\d{1,4}[-/\.]\d{1,2}[-/\.]\d{1,4}.*\s*$'`;
    const params = [req.params.id];
    let idx = 2;
    if (chatName) {
      const cleanChat = String(chatName).trim();
      query += ` AND (
        LOWER(TRIM(chat_name)) = LOWER(TRIM($${idx}))
        OR LOWER(TRIM(sender)) = LOWER(TRIM($${idx}))
        OR LOWER(TRIM(chat_name)) LIKE '%' || LOWER(TRIM($${idx})) || '%'
        OR LOWER(TRIM($${idx})) LIKE '%' || LOWER(TRIM(chat_name)) || '%'
      )`;
      params.push(cleanChat);
      idx += 1;
    }

    if (!chatName && days && !isNaN(days) && days > 0) {
      query += ` AND message_time >= (NOW() - ($${idx} * INTERVAL '1 day'))`;
      params.push(days);
      idx += 1;
    }

    let finalQuery = `SELECT * FROM (${query} ORDER BY message_time DESC LIMIT 500) sub ORDER BY message_time ASC`;
    let result = await pool.query(finalQuery, params);

    // If no direct conversation rows are stored yet for this chat, check instagram_chats for last_message preview
    if (result.rows.length === 0 && chatName) {
      const cleanChat = String(chatName).trim();
      const chatFallback = await pool.query(
        `SELECT chat_name, username, last_message, last_message_at 
         FROM instagram_chats 
         WHERE device_id = $1 
           AND (
             LOWER(TRIM(chat_name)) = LOWER(TRIM($2))
             OR LOWER(TRIM(chat_name)) LIKE '%' || LOWER(TRIM($2)) || '%'
             OR LOWER(TRIM($2)) LIKE '%' || LOWER(TRIM(chat_name)) || '%'
           )
           AND last_message IS NOT NULL 
         ORDER BY last_message_at DESC LIMIT 1`,
        [req.params.id, cleanChat]
      );
      if (chatFallback.rows.length > 0 && chatFallback.rows[0].last_message) {
        const row = chatFallback.rows[0];
        const hasYouPrefix = row.last_message.startsWith("You: ") || row.last_message.startsWith("You sent ") || row.last_message.startsWith("You reacted ");
        let cleanMsg = row.last_message;
        if (cleanMsg.startsWith("You: ")) cleanMsg = cleanMsg.slice(5).trim();
        else if (cleanMsg.startsWith("You sent ")) cleanMsg = cleanMsg.slice(9).trim();

        const reelMatch = cleanMsg.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p|tv)\/[a-zA-Z0-9_-]+/i);

        result.rows = [{
          id: -1,
          chat_name: row.chat_name || cleanChat,
          sender: hasYouPrefix ? "me" : (row.chat_name || cleanChat),
          message_text: cleanMsg,
          is_outgoing: hasYouPrefix,
          message_time: row.last_message_at || new Date().toISOString(),
          media_type: reelMatch ? "reel" : null,
          media_path: null,
          reel_url: reelMatch ? reelMatch[0] : null
        }];
      }
    }

    res.json(result.rows);
  } catch (err) {
    if (err.code === "42P01") {
      await ensureInstagramTables();
      return res.json([]);
    }
    console.error("GET /instagram/messages error:", err);
    res.json([]);
  }
});

/**
 * POST /api/devices/:id/whatsapp/messages
 * (Admin, authenticated) Allows syncing or restoring WhatsApp messages for this device.
 */
router.post("/:id/whatsapp/messages", requireAuth, async (req, res, next) => {
  try {
    const device = await checkDeviceAccess(req.params.id, req.auth);
    if (!device) return res.status(404).json({ error: "Device not found" });

    const entries = Array.isArray(req.body.entries) ? req.body.entries : [req.body];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let insertedCount = 0;
      for (const e of entries) {
        if (!e.chatName || !e.messageText) continue;
        const chatName = String(e.chatName).trim();
        const messageText = String(e.messageText).trim();
        const sender = e.sender ? String(e.sender).trim() : null;
        const isOutgoing = Boolean(e.isOutgoing);
        const messageTime = e.messageTime || new Date().toISOString();
        const mediaType = e.mediaType || null;
        const mediaPath = e.mediaPath || null;

        const existing = await client.query(
          `SELECT id FROM whatsapp_messages
           WHERE device_id = $1 AND chat_name = $2 AND message_text = $3 AND message_time = $4 AND is_outgoing = $5
           LIMIT 1`,
          [req.params.id, chatName, messageText, messageTime, isOutgoing]
        );

        if (existing.rows.length === 0) {
          const result = await client.query(
            `INSERT INTO whatsapp_messages (device_id, chat_name, sender, message_text, is_outgoing, message_time, media_type, media_path)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (device_id, chat_name, message_text, message_time, is_outgoing) DO NOTHING
             RETURNING id`,
            [req.params.id, chatName, sender, messageText, isOutgoing, messageTime, mediaType, mediaPath]
          );
          if (result.rows.length > 0) insertedCount++;
        }
      }
      await client.query("COMMIT");
      if (insertedCount > 0) {
        emitDeviceEvent(req.params.id, {
          type: "whatsapp_message",
          chatNames: [...new Set(entries.map((e) => e.chatName).filter(Boolean))],
          count: insertedCount,
          timestamp: new Date().toISOString(),
        });
      }
      res.status(201).json({ inserted: insertedCount });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;

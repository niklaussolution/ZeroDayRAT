const express = require("express");
const { body, validationResult } = require("express-validator");
const pool = require("../db/pool");
const { requireDeviceAuth } = require("../middleware/deviceAuth.middleware");
const { emitDeviceEvent } = require("../events/deviceEvents");

const router = express.Router();
router.use(requireDeviceAuth);

/** Touches devices.last_seen_at on every successful sync call. */
async function touchLastSeen(deviceId) {
  await pool.query("UPDATE devices SET last_seen_at = now() WHERE id = $1", [deviceId]);
}

/** Loads this device's feature flags so we can refuse data for a disabled feature server-side too. */
async function getFlags(deviceId) {
  const result = await pool.query("SELECT * FROM feature_flags WHERE device_id = $1", [deviceId]);
  return result.rows[0] || null;
}

/**
 * GET /api/sync/feature-flags
 * The app calls this before each periodic sync run to know which collectors to execute.
 */
router.get("/feature-flags", async (req, res, next) => {
  try {
    const flags = await getFlags(req.device.deviceId);
    if (!flags) return res.status(404).json({ error: "Feature flags not found for device" });
    await touchLastSeen(req.device.deviceId);
    res.json(flags);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sync/app-usage
 * body: { entries: [{ packageName, appName, usageSeconds, usageDate }] }
 */
router.post(
  "/app-usage",
  [body("entries").isArray({ min: 1 })],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const flags = await getFlags(req.device.deviceId);
      if (!flags || !flags.app_usage_tracking) {
        return res.status(403).json({ error: "app_usage_tracking is not enabled for this device" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const e of req.body.entries) {
          // Upsert: the app reports each day's CUMULATIVE total per package, not a
          // delta, so a later sync for the same day should replace, not add to, the row.
          await client.query(
            `INSERT INTO app_usage_logs (device_id, package_name, app_name, usage_seconds, usage_date)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (device_id, package_name, usage_date)
             DO UPDATE SET app_name = EXCLUDED.app_name, usage_seconds = EXCLUDED.usage_seconds, synced_at = now()`,
            [req.device.deviceId, e.packageName, e.appName || null, e.usageSeconds || 0, e.usageDate]
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      await touchLastSeen(req.device.deviceId);
      res.status(201).json({ inserted: req.body.entries.length });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/sync/web-history
 * body: { entries: [{ url, title, visitedAt }] }
 * Best-effort — see android-app WebHistoryCollector's doc comment. On a
 * modern Chrome-only device this is called with an empty list (nothing to
 * insert) most of the time; that's expected, not a failure.
 */
router.post(
  "/web-history",
  [body("entries").isArray({ min: 1 })],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const flags = await getFlags(req.device.deviceId);
      if (!flags || !flags.web_history_tracking) {
        return res.status(403).json({ error: "web_history_tracking is not enabled for this device" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const e of req.body.entries) {
          await client.query(
            `INSERT INTO web_history_logs (device_id, url, title, visited_at)
             VALUES ($1, $2, $3, $4)`,
            [req.device.deviceId, e.url, e.title || null, e.visitedAt]
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      await touchLastSeen(req.device.deviceId);
      res.status(201).json({ inserted: req.body.entries.length });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/sync/sms-log
 * body: { entries: [{ direction, counterparty, messageAt }] }
 */
router.post(
  "/sms-log",
  [body("entries").isArray({ min: 1 })],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const flags = await getFlags(req.device.deviceId);
      if (!flags || !flags.sms_log) {
        return res.status(403).json({ error: "sms_log is not enabled for this device" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let insertedCount = 0;
        for (const e of req.body.entries) {
          const existing = await client.query(
            `SELECT id, body, contact_name FROM sms_logs
             WHERE device_id = $1 AND direction = $2 AND counterparty = $3 AND message_at = $4
             LIMIT 1`,
            [req.device.deviceId, e.direction, e.counterparty, e.messageAt]
          );

          if (existing.rows.length === 0) {
            await client.query(
              `INSERT INTO sms_logs (device_id, direction, counterparty, message_at, body, contact_name)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [req.device.deviceId, e.direction, e.counterparty, e.messageAt, e.body || null, e.contactName || null]
            );
            insertedCount++;
          } else {
            const updates = [];
            const values = [];
            let pIndex = 1;
            if (e.body && !existing.rows[0].body) {
              updates.push(`body = $${pIndex++}`);
              values.push(e.body);
            }
            if (e.contactName && !existing.rows[0].contact_name) {
              updates.push(`contact_name = $${pIndex++}`);
              values.push(e.contactName);
            }
            if (updates.length > 0) {
              updates.push(`synced_at = now()`);
              values.push(existing.rows[0].id);
              await client.query(
                `UPDATE sms_logs SET ${updates.join(", ")} WHERE id = $${pIndex}`,
                values
              );
            }
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      await touchLastSeen(req.device.deviceId);
      res.status(201).json({ inserted: insertedCount });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/sync/call-log
 * body: { entries: [{ direction, counterparty, durationSec, calledAt }] }
 */
router.post(
  "/call-log",
  [body("entries").isArray({ min: 1 })],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const flags = await getFlags(req.device.deviceId);
      if (!flags || !flags.call_log) {
        return res.status(403).json({ error: "call_log is not enabled for this device" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let insertedCount = 0;
        for (const e of req.body.entries) {
          const existing = await client.query(
            `SELECT id, contact_name FROM call_logs
             WHERE device_id = $1 AND direction = $2 AND counterparty = $3 AND called_at = $4
             LIMIT 1`,
            [req.device.deviceId, e.direction, e.counterparty, e.calledAt]
          );

          if (existing.rows.length === 0) {
            await client.query(
              `INSERT INTO call_logs (device_id, direction, counterparty, duration_sec, called_at, contact_name)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [req.device.deviceId, e.direction, e.counterparty, e.durationSec || 0, e.calledAt, e.contactName || null]
            );
            insertedCount++;
          } else if (e.contactName && !existing.rows[0].contact_name) {
            await client.query(
              `UPDATE call_logs SET contact_name = $1 WHERE id = $2`,
              [e.contactName, existing.rows[0].id]
            );
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      await touchLastSeen(req.device.deviceId);
      res.status(201).json({ inserted: insertedCount });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/sync/installed-apps
 * body: { apps: [{ packageName, appName, installDate }] }
 * Full-snapshot upsert: replaces the device's inventory each sync.
 */
router.post(
  "/installed-apps",
  [body("apps").isArray()],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const flags = await getFlags(req.device.deviceId);
      if (!flags || !flags.installed_apps_list) {
        return res.status(403).json({ error: "installed_apps_list is not enabled for this device" });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const app of req.body.apps) {
          await client.query(
            `INSERT INTO installed_apps (device_id, package_name, app_name, install_date, icon_base64, synced_at)
             VALUES ($1, $2, $3, $4, $5, now())
             ON CONFLICT (device_id, package_name)
             DO UPDATE SET app_name = EXCLUDED.app_name, install_date = EXCLUDED.install_date,
                            icon_base64 = EXCLUDED.icon_base64, synced_at = now()`,
            [req.device.deviceId, app.packageName, app.appName || null, app.installDate || null, app.iconBase64 || null]
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      await touchLastSeen(req.device.deviceId);
      res.status(201).json({ upserted: req.body.apps.length });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/sync/permission-status
 * (Device) Reports whether the OS-level permission behind each feature-flag
 * scope is actually granted right now — independent of whether that flag
 * is turned on — so the dashboard can show a real "not granted on device"
 * gap instead of a toggle that silently does nothing.
 */
router.post("/permission-status", async (req, res, next) => {
  try {
    await pool.query("UPDATE devices SET permission_status = $1 WHERE id = $2", [
      JSON.stringify(req.body),
      req.device.deviceId,
    ]);
    await touchLastSeen(req.device.deviceId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sync/commands
 * (Device) Fetches this device's pending remote commands and marks them 'sent'.
 * Phase 5: polled once per sync cycle (and on-demand via "Check Location Now"
 * being picked up on the next poll). Phase 6 adds FCM push for instant delivery
 * — this endpoint stays as the source of truth either way.
 *
 * Also re-delivers a command still stuck at 'sent' after 10+ minutes — e.g.
 * the device fetched it but never reported a result (no location fix
 * available, app killed mid-sync, network drop). Without this, a failed
 * delivery would never retry and the dashboard's command would hang forever.
 */
router.get("/commands", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, command_type, payload, created_at FROM remote_commands
       WHERE device_id = $1
         AND (status = 'pending' OR (status = 'sent' AND created_at < now() - interval '10 minutes'))
       ORDER BY created_at ASC LIMIT 20`,
      [req.device.deviceId]
    );

    if (result.rows.length > 0) {
      await pool.query(
        "UPDATE remote_commands SET status = 'sent' WHERE id = ANY($1::uuid[])",
        [result.rows.map((r) => r.id)]
      );
    }

    await touchLastSeen(req.device.deviceId);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sync/location
 * (Device) Submits the result of an on-demand location fetch (command_type
 * 'location_check'). Records the point and marks the command completed.
 */
router.post(
  "/location",
  [
    body("latitude").isFloat({ min: -90, max: 90 }),
    body("longitude").isFloat({ min: -180, max: 180 }),
    body("accuracyM").optional().isFloat(),
    body("commandId").optional().isUUID(),
    body("source").optional().isIn(["on_demand", "geofence_event"]),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const flags = await getFlags(req.device.deviceId);
      if (flags && flags.location_on_demand === false && !req.body.commandId) {
        return res.status(403).json({ error: "location_on_demand is not enabled for this device" });
      }

      await pool.query(
        `INSERT INTO location_logs (device_id, latitude, longitude, accuracy_m, source)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          req.device.deviceId,
          req.body.latitude,
          req.body.longitude,
          req.body.accuracyM || null,
          req.body.source || "on_demand",
        ]
      );

      if (req.body.commandId) {
        await pool.query(
          "UPDATE remote_commands SET status = 'acked', completed_at = now() WHERE id = $1 AND device_id = $2",
          [req.body.commandId, req.device.deviceId]
        );
      }

      await touchLastSeen(req.device.deviceId);
      res.status(201).json({ recorded: true });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/sync/geofences
 * (Device) Fetches active geofences to register locally with the native
 * Android GeofencingClient.
 */
router.get("/geofences", async (req, res, next) => {
  try {
    const flags = await getFlags(req.device.deviceId);
    if (!flags || !flags.geofencing) {
      return res.json([]); // feature disabled — nothing to register
    }

    const result = await pool.query(
      "SELECT id, name, latitude, longitude, radius_m FROM geofences WHERE device_id = $1 AND active = true",
      [req.device.deviceId]
    );
    await touchLastSeen(req.device.deviceId);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sync/geofence-event
 * (Device) Reports a geofence ENTER/EXIT transition detected by the OS.
 * Records a location point (source=geofence_event) and raises an alert.
 */
router.post(
  "/geofence-event",
  [
    body("geofenceId").isUUID(),
    body("transition").isIn(["enter", "exit"]),
    body("latitude").isFloat({ min: -90, max: 90 }),
    body("longitude").isFloat({ min: -180, max: 180 }),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const geofence = await pool.query(
        "SELECT name FROM geofences WHERE id = $1 AND device_id = $2",
        [req.body.geofenceId, req.device.deviceId]
      );
      if (geofence.rows.length === 0) return res.status(404).json({ error: "Geofence not found" });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO location_logs (device_id, latitude, longitude, source)
           VALUES ($1, $2, $3, 'geofence_event')`,
          [req.device.deviceId, req.body.latitude, req.body.longitude]
        );
        await client.query(
          `INSERT INTO alerts (device_id, alert_type, message, metadata)
           VALUES ($1, 'geofence_breach', $2, $3)`,
          [
            req.device.deviceId,
            `Device ${req.body.transition === "enter" ? "entered" : "left"} "${geofence.rows[0].name}"`,
            JSON.stringify({ geofenceId: req.body.geofenceId, transition: req.body.transition }),
          ]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      await touchLastSeen(req.device.deviceId);
      res.status(201).json({ recorded: true });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/sync/fcm-token
 * (Device) Registers/refreshes the FCM token used to push instant sync nudges.
 */
router.post(
  "/fcm-token",
  [body("fcmToken").isString().notEmpty()],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      await pool.query("UPDATE devices SET fcm_token = $1, last_seen_at = now() WHERE id = $2", [
        req.body.fcmToken,
        req.device.deviceId,
      ]);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/sync/commands/:id/ack
 * (Device) Generic completion callback for any queued command (lock,
 * file_list, ...). location_check uses the dedicated /location endpoint
 * instead, since it also needs to write a location_logs row.
 */
router.post("/commands/:id/ack", async (req, res, next) => {
  try {
    const status = req.body.success === false ? "failed" : "acked";
    const result = await pool.query(
      `UPDATE remote_commands SET status = $1, result = $2, completed_at = now()
       WHERE id = $3 AND device_id = $4
       RETURNING id`,
      [status, JSON.stringify(req.body), req.params.id, req.device.deviceId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Command not found" });

    await touchLastSeen(req.device.deviceId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/sync/block-rules
 * (Device) Fetches active block rules to enforce locally via the
 * Accessibility Service. Returns [] if app_blocking is disabled for this
 * device — the app treats an empty list as "nothing to block."
 */
router.get("/block-rules", async (req, res, next) => {
  try {
    const flags = await getFlags(req.device.deviceId);
    if (!flags || !flags.app_blocking) {
      await touchLastSeen(req.device.deviceId);
      return res.json([]);
    }

    const result = await pool.query(
      "SELECT id, rule_type, target, schedule FROM block_rules WHERE device_id = $1 AND active = true",
      [req.device.deviceId]
    );
    // Separate from touchLastSeen's last_seen_at: that column advances on
    // almost any successful sync call (feature-flags is fetched first and
    // rarely fails), so it doesn't actually prove this specific fetch
    // happened — the dashboard could show a block-rule change "confirmed"
    // from an unrelated call succeeding while this one hadn't run yet. This
    // column is touched only here, so polling it after a rule change is a
    // real guarantee the device has the updated rule list.
    await pool.query("UPDATE devices SET block_rules_synced_at = now() WHERE id = $1", [req.device.deviceId]);
    await touchLastSeen(req.device.deviceId);
    res.json(result.rows);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sync/block-violation
 * (Device) Reports a block attempt (e.g. user tried to open a blocked app
 * during a restricted window) — raises a dashboard alert.
 */
router.post(
  "/block-violation",
  [body("ruleId").isUUID(), body("target").isString().notEmpty()],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      await pool.query(
        `INSERT INTO alerts (device_id, alert_type, message, metadata)
         VALUES ($1, 'block_violation', $2, $3)`,
        [
          req.device.deviceId,
          `Attempted to open blocked ${req.body.target}`,
          JSON.stringify({ ruleId: req.body.ruleId, target: req.body.target }),
        ]
      );
      await touchLastSeen(req.device.deviceId);
      res.status(201).json({ recorded: true });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/sync/whatsapp-messages
 * body: { entries: [{ chatName, sender, messageText, isOutgoing, messageTime, mediaType, mediaPath }] }
 */
router.post(
  "/whatsapp-messages",
  [body("entries").isArray()],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");



        const isPhone = (val) => Boolean(val && /^\+?[0-9\s\-()]{7,25}$/.test(String(val).trim()));
        const isPlaceholder = (val) => {
          if (!val) return true;
          const s = String(val).trim();
          return (
            s === "WhatsApp Contact" ||
            s === "Recent WhatsApp Chat" ||
            s === "Contact" ||
            s === "Recent contact" ||
            s === "Recent conversation" ||
            s === "Tap to view conversation" ||
            isPhone(s) ||
            /^Message \+?[0-9\s-]+$/i.test(s)
          );
        };

        let insertedCount = 0;
        for (const e of req.body.entries) {
          if (!e.messageText && !e.mediaPath) continue;
          const chatName = String(e.chatName || req.body.activeChat || "").trim();
          if (!chatName) continue;
          const rawText = String(e.messageText || "").trim();
          const sender = e.sender ? String(e.sender).trim() : null;
          const isSenderMe = sender && (
            sender.toLowerCase() === "me" ||
            sender.toLowerCase() === "you" ||
            sender.toLowerCase() === "target device"
          );
          const hasYouPrefix = rawText.startsWith("You: ") || rawText.startsWith("You reacted ");
          const isOutgoing = Boolean(e.isOutgoing) || isSenderMe || hasYouPrefix;
          const messageText = rawText.startsWith("You: ") ? rawText.slice(5).trim() : rawText;
          const messageTime = e.messageTime || new Date().toISOString();
          const mediaType = e.mediaType || null;
          const mediaPath = e.mediaPath || null;

          // Extract phone number from JID or text if available
          let phoneNumber = null;
          const cleanJidToPhone = (val) => {
            if (!val) return null;
            const str = String(val).trim();
            if (str.includes("@s.whatsapp.net") || str.includes("@g.us")) {
              const digits = str.replace(/@.*$/, "").replace(/\D/g, "");
              if (digits.length >= 10) return "+" + digits;
            }
            if (isPhone(str)) return str;
            return null;
          };

          phoneNumber = cleanJidToPhone(sender) || cleanJidToPhone(messageText) || cleanJidToPhone(chatName);

          // Determine display text for last_message in inventory
          let chatLastMessage = messageText;
          if (isPhone(messageText) || messageText.includes("@s.whatsapp.net") || messageText.includes("@g.us")) {
            chatLastMessage = "WhatsApp Contact";
          }

          // 1. Maintain complete WhatsApp chat & contact inventory in whatsapp_chats table
          await client.query(
            `INSERT INTO whatsapp_chats (device_id, chat_name, phone_number, last_message, last_message_at, synced_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (device_id, chat_name)
             DO UPDATE SET
               last_message = CASE
                 WHEN EXCLUDED.last_message IS NOT NULL
                   AND EXCLUDED.last_message NOT IN ('WhatsApp Contact', 'Recent WhatsApp Chat', 'Contact', 'Recent contact', 'Recent conversation', 'Tap to view conversation')
                   AND EXCLUDED.last_message NOT LIKE '%@s.whatsapp.net%'
                   AND EXCLUDED.last_message NOT LIKE '%@g.us%'
                   AND EXCLUDED.last_message !~ '^\\+?[0-9\\s\\-()]{7,25}$'
                   AND EXCLUDED.last_message !~* '^message \\+?[0-9\\s-]+$'
                 THEN EXCLUDED.last_message
                 ELSE whatsapp_chats.last_message
               END,
               last_message_at = GREATEST(whatsapp_chats.last_message_at, EXCLUDED.last_message_at),
               phone_number = COALESCE(EXCLUDED.phone_number, whatsapp_chats.phone_number),
               synced_at = NOW()`,
            [
              req.device.deviceId,
              chatName.slice(0, 255),
              phoneNumber ? phoneNumber.slice(0, 50) : null,
              chatLastMessage,
              messageTime,
            ]
          );

          // 2. Only store REAL conversation messages in whatsapp_messages.
          // JIDs, contact sync placeholders, and raw phone numbers without media MUST NEVER be stored as chat messages.
          if (
            messageText.includes("@s.whatsapp.net") ||
            messageText.includes("@g.us") ||
            messageText === "WhatsApp Contact" ||
            messageText === "Recent contact" ||
            messageText === "Recent conversation" ||
            messageText === "Tap to view conversation" ||
            (!mediaPath && isPhone(messageText))
          ) {
            continue;
          }

          const existing = await client.query(
            `SELECT id FROM whatsapp_messages
             WHERE device_id = $1 AND chat_name = $2 AND message_text = $3 AND message_time = $4 AND is_outgoing = $5
             LIMIT 1`,
            [req.device.deviceId, chatName, messageText, messageTime, isOutgoing]
          );

          if (existing.rows.length === 0) {
            const result = await client.query(
              `INSERT INTO whatsapp_messages (device_id, chat_name, sender, message_text, is_outgoing, message_time, media_type, media_path)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
               ON CONFLICT (device_id, chat_name, message_text, message_time, is_outgoing)
               DO UPDATE SET
                 media_type = COALESCE(EXCLUDED.media_type, whatsapp_messages.media_type),
                 media_path = COALESCE(EXCLUDED.media_path, whatsapp_messages.media_path),
                 synced_at = NOW()
               RETURNING id`,
              [req.device.deviceId, chatName, sender, messageText, isOutgoing, messageTime, mediaType, mediaPath]
            );
            if (result.rows.length > 0) insertedCount++;
          }
        }
        await client.query("COMMIT");
        await touchLastSeen(req.device.deviceId);
        emitDeviceEvent(req.device.deviceId, {
          type: "whatsapp_message",
          chatNames: [...new Set(req.body.entries.map((e) => e.chatName).filter(Boolean))],
          count: insertedCount,
          timestamp: new Date().toISOString(),
        });
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
  }
);

/**
 * POST /api/sync/instagram-messages
 * body: { entries: [{ chatName, sender, messageText, isOutgoing, messageTime, mediaType, mediaPath, reelUrl }], activeChat?: string }
 */
router.post(
  "/instagram-messages",
  [body("entries").isArray()],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        let insertedCount = 0;
        for (const e of req.body.entries) {
          if (!e.messageText && !e.mediaPath && !e.reelUrl) continue;
          const chatName = String(e.chatName || req.body.activeChat || "").trim();
          if (!chatName) continue;
          const rawText = String(e.messageText || "").trim();
          const sender = e.sender ? String(e.sender).trim() : null;
          const isSenderMe = sender && (
            sender.toLowerCase() === "me" ||
            sender.toLowerCase() === "you" ||
            sender.toLowerCase() === "target device"
          );
          const hasYouPrefix = rawText.startsWith("You: ") || rawText.startsWith("You reacted ") || rawText.startsWith("You sent ");
          const isOutgoing = Boolean(e.isOutgoing) || isSenderMe || hasYouPrefix;
          let messageText = rawText;
          if (rawText.startsWith("You: ")) messageText = rawText.slice(5).trim();
          else if (rawText.startsWith("You sent ")) messageText = rawText.slice(9).trim();

          const messageTime = e.messageTime || new Date().toISOString();
          let mediaType = e.mediaType || null;
          const mediaPath = e.mediaPath || null;
          let reelUrl = e.reelUrl || null;

          // Detect reel URL inside messageText if not already populated
          if (!reelUrl) {
            const reelMatch = messageText.match(/https?:\/\/(?:www\.)?instagram\.com\/(?:reel|p|tv)\/[a-zA-Z0-9_-]+/i);
            if (reelMatch) {
              reelUrl = reelMatch[0];
              mediaType = mediaType || "reel";
            } else if (messageText.toLowerCase().includes("sent a reel") || messageText.toLowerCase().includes("shared a reel")) {
              mediaType = mediaType || "reel";
            }
          }

          // 1. Maintain complete Instagram chat inventory in instagram_chats table
          await client.query(
            `INSERT INTO instagram_chats (device_id, chat_name, username, last_message, last_message_at, synced_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (device_id, chat_name)
             DO UPDATE SET
               last_message = CASE
                 WHEN EXCLUDED.last_message IS NOT NULL AND EXCLUDED.last_message != ''
                 THEN EXCLUDED.last_message
                 ELSE instagram_chats.last_message
               END,
               last_message_at = GREATEST(instagram_chats.last_message_at, EXCLUDED.last_message_at),
               username = COALESCE(EXCLUDED.username, instagram_chats.username),
               synced_at = NOW()`,
            [
              req.device.deviceId,
              chatName.slice(0, 255),
              sender ? sender.slice(0, 255) : null,
              messageText || (reelUrl ? "Shared a Reel" : "Media message"),
              messageTime,
            ]
          );

          // 2. Upsert into instagram_messages table
          const existing = await client.query(
            `SELECT id FROM instagram_messages
             WHERE device_id = $1 AND chat_name = $2 AND message_text = $3 AND message_time = $4 AND is_outgoing = $5
             LIMIT 1`,
            [req.device.deviceId, chatName, messageText, messageTime, isOutgoing]
          );

          if (existing.rows.length === 0) {
            const result = await client.query(
              `INSERT INTO instagram_messages (device_id, chat_name, sender, message_text, is_outgoing, message_time, media_type, media_path, reel_url)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               ON CONFLICT (device_id, chat_name, message_text, message_time, is_outgoing)
               DO UPDATE SET
                 media_type = COALESCE(EXCLUDED.media_type, instagram_messages.media_type),
                 media_path = COALESCE(EXCLUDED.media_path, instagram_messages.media_path),
                 reel_url = COALESCE(EXCLUDED.reel_url, instagram_messages.reel_url),
                 synced_at = NOW()
               RETURNING id`,
              [req.device.deviceId, chatName, sender, messageText, isOutgoing, messageTime, mediaType, mediaPath, reelUrl]
            );
            if (result.rows.length > 0) insertedCount++;
          }
        }

        await client.query("COMMIT");
        await touchLastSeen(req.device.deviceId);
        emitDeviceEvent(req.device.deviceId, {
          type: "instagram_message",
          chatNames: [...new Set(req.body.entries.map((e) => e.chatName).filter(Boolean))],
          count: insertedCount,
          timestamp: new Date().toISOString(),
        });
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
  }
);

module.exports = router;

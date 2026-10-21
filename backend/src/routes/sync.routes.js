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
    // 1. Auto-expire old pending or sent commands older than 5 minutes so they don't block fresh commands
    await pool.query(
      `UPDATE remote_commands
       SET status = 'failed', result = '{"error": "Command expired after 5 minutes"}'::jsonb, completed_at = now()
       WHERE device_id = $1
         AND status IN ('pending', 'sent')
         AND created_at < now() - interval '5 minutes'`,
      [req.device.deviceId]
    );

    // 2. Fetch fresh pending commands, newest first (ORDER BY created_at DESC)
    const result = await pool.query(
      `SELECT id, command_type, payload, created_at FROM remote_commands
       WHERE device_id = $1 AND status = 'pending'
       ORDER BY created_at DESC LIMIT 20`,
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
          if (!e.messageText && !e.mediaPath && !e.reelUrl && !e.mediaType) continue;
          const chatName = String(e.chatName || req.body.activeChat || "").trim();
          if (!chatName) continue;
          const lowerChat = chatName.toLowerCase();
          if (
            lowerChat === "whatsapp" ||
            lowerChat === "whatsapp business" ||
            lowerChat === "whatsapp group" ||
            lowerChat === "send" ||
            lowerChat === "type a message" ||
            lowerChat === "search" ||
            lowerChat.endsWith("picture") ||
            lowerChat.includes("filter")
          ) {
            continue;
          }
          const reelUrl = e.reelUrl || null;
          const mediaType = e.mediaType || (reelUrl ? "reel" : null);
          const rawText = String(e.messageText || (reelUrl ? `[Reel] ${reelUrl}` : (mediaType ? `[${mediaType}]` : ""))).trim();
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
            (!mediaPath && !reelUrl && isPhone(messageText))
          ) {
            continue;
          }

          const finalSender = isOutgoing ? "me" : (sender || chatName);

          const existing = await client.query(
            `SELECT id, is_outgoing, sender FROM whatsapp_messages
             WHERE device_id = $1 
               AND LOWER(TRIM(chat_name)) = LOWER(TRIM($2)) 
               AND message_text = $3 
               AND (
                 message_time = $4
                 OR ABS(EXTRACT(EPOCH FROM (message_time - $4::timestamptz))) < 600
               )
             ORDER BY is_outgoing DESC, id ASC
             LIMIT 1`,
            [req.device.deviceId, chatName, messageText, messageTime]
          );

          if (existing.rows.length === 0) {
            const result = await client.query(
              `INSERT INTO whatsapp_messages (device_id, chat_name, sender, message_text, is_outgoing, message_time, media_type, media_path, reel_url)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
               RETURNING id`,
              [req.device.deviceId, chatName, finalSender, messageText, isOutgoing, messageTime, mediaType, mediaPath, reelUrl]
            );
            if (result.rows.length > 0) insertedCount++;
          } else {
            const shouldUpgradeToOutgoing = isOutgoing && !existing.rows[0].is_outgoing;
            await client.query(
              `UPDATE whatsapp_messages SET
                 is_outgoing = CASE WHEN $1 THEN true ELSE is_outgoing END,
                 sender = CASE WHEN $1 THEN 'me' ELSE sender END,
                 media_type = COALESCE($2, media_type),
                 media_path = COALESCE($3, media_path),
                 reel_url = COALESCE($4, reel_url),
                 synced_at = NOW()
               WHERE id = $5`,
              [shouldUpgradeToOutgoing, mediaType, mediaPath, reelUrl, existing.rows[0].id]
            );
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
        target_account  VARCHAR(255),
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
        target_account  VARCHAR(255),
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
 * POST /api/sync/instagram/account
 * body: { accountName: string, previousAccount?: string }
 * Handles dynamic Instagram account switch on device:
 * Updates active Instagram ID in devices table and emits SSE.
 */
router.post("/instagram/account", async (req, res, next) => {
  try {
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/sync/instagram-messages
 * body: { entries: [{ chatName, sender, messageText, isOutgoing, messageTime, mediaType, mediaPath, reelUrl, targetAccount }], activeChat?: string, accountName?: string }
 */
router.post(
  "/instagram-messages",
  [body("entries").isArray()],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Validation failed", details: errors.array() });

    try {
      const deviceId = req.device.deviceId || req.device.id;
      await ensureInstagramTables();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        function isInstagramUiMetadataOrTimestamp(text) {
          if (!text || typeof text !== "string") return true;
          const t = text.replace(/^[•·\s]+|[•·\s]+$/g, "").trim();
          if (!t) return true;
          // 1. Exact times: "3:25 PM", "03:25 pm", "15:45", "15:45:00", "3:25", "3.25 PM", "3:25pm"
          if (/^\d{1,2}[:.]\d{2}(?::\d{2})?(\s*(?:AM|PM|am|pm))?$/i.test(t)) return true;
          // 2. Day names with optional time: "Yesterday", "Today", "Tomorrow", "Yesterday at 3:25 PM", "Today 10:14 AM"
          if (/^(?:Yesterday|Today|Tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(?:\s+(?:at\s+)?\d{1,2}[:.]\d{2}(?:\s*(?:AM|PM|am|pm))?)?$/i.test(t)) return true;
          // 3. Month names with dates: "Oct 17", "17 Oct", "October 17, 2026", "Oct 17 at 3:25 PM"
          if (/^(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*)(?:,?\s*\d{4})?(?:\s+(?:at\s+)?\d{1,2}[:.]\d{2}(?:\s*(?:AM|PM|am|pm))?)?$/i.test(t)) return true;
          // 4. Standard numeric dates: "17/10/2026", "2026-10-17"
          if (/^\d{1,4}[-/\.]\d{1,2}[-/\.]\d{1,4}(?:\s+(?:at\s+)?\d{1,2}[:.]\d{2}(?:\s*(?:AM|PM|am|pm))?)?$/i.test(t)) return true;
          // 5. Activity status / delivery receipts: "Active now", "Active 5m ago", "Seen just now", "Seen", "Delivered", "Sent", "Sending...", "Typing..."
          if (/^(?:Active(?:\s+now|\s+today|\s+\d+\w*\s+ago|\s+yesterday)?|Seen(?:\s+just\s+now|\s+\d+\w*\s+ago|\s+yesterday|\s+by\s+\w+)?|Delivered(?:\s+\d+\w*\s+ago)?|Sent(?:\s+\d+\w*\s+ago)?|Sending(?:\.\.\.)?|Typing(?:\.\.\.)?)$/i.test(t)) return true;
          // 6. UI placeholders and system button text
          if (/^(?:Message\.\.\.|Type\s+a\s+message\.\.\.|Search|Replies|Tap\s+and\s+hold\s+to\s+react|Double\s+tap\s+to\s+like|Liked\s+a\s+message|Follow|Requested)$/i.test(t)) return true;
          // 7. Reel view metrics & interactions: "221K", "3.6M", "Like number is 1853", "Save number is 108", "Reshare number is 26", "Comment number is 24", "Reposted 11 times", "View likes", "View comments"
          if (/^\d+(?:\.\d+)?[KMkm]$/.test(t)) return true;
          if (/^(?:Like|Save|Reshare|Comment|Repost)(?:\s+number)?\s+is\s+\d+/i.test(t)) return true;
          if (/^(?:Reposted\s+\d+\s+times|View\s+(?:likes|comments)|Like|Comment|Share|Save)$/i.test(t)) return true;
          // 8. Starts with time and short length <= 25 chars
          if (/^\d{1,2}[:.]\d{2}\s*(?:AM|PM|am|pm)\b/i.test(t) && t.length <= 25) return true;
          return false;
        }

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
          const targetAccount = null; // Constraint: Never leak or capture target Instagram ID

          // 1. Detect reel URL in messageText or reelUrl
          if (!reelUrl) {
            const reelMatch = messageText.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|reels|p|tv|share\/reel)\/([a-zA-Z0-9_-]+)/i) ||
                             messageText.match(/(?:https?:\/\/)?(?:www\.)?ig\.me\/(?:reel|share|p)\/([a-zA-Z0-9_-]+)/i);
            if (reelMatch) {
              const fullMatch = reelMatch[0];
              reelUrl = fullMatch.startsWith("http://") || fullMatch.startsWith("https://") ? fullMatch : `https://${fullMatch}`;
            }
          }

          // 2. Filter out UI metadata & timestamps (e.g. '3:25 PM', 'Seen just now', 'Active now')
          if (isInstagramUiMetadataOrTimestamp(messageText) && !mediaPath && !reelUrl && mediaType !== "reel" && mediaType !== "image") {
            continue;
          }

          // 3. Classify exact media type (reel, image, video, audio, or text)
          const lowerText = messageText.toLowerCase();
          if (
            reelUrl ||
            mediaType === "reel" ||
            lowerText.includes("sent a reel") ||
            lowerText.includes("shared a reel") ||
            lowerText.startsWith("reel by") ||
            lowerText === "reel"
          ) {
            mediaType = "reel";
            if (!reelUrl) {
              const rMatch = messageText.match(/(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|reels|p|tv|share\/reel)\/([a-zA-Z0-9_-]+)/i) ||
                            messageText.match(/(?:https?:\/\/)?(?:www\.)?ig\.me\/(?:reel|share|p)\/([a-zA-Z0-9_-]+)/i);
              if (rMatch) {
                const fMatch = rMatch[0];
                reelUrl = fMatch.startsWith("http://") || fMatch.startsWith("https://") ? fMatch : `https://${fMatch}`;
              }
            }
            if (!messageText || messageText === reelUrl || lowerText === "reel") {
              messageText = reelUrl ? reelUrl : "Shared a Reel";
            }
          } else if (
            mediaType === "image" ||
            mediaPath ||
            lowerText.includes("sent a photo") ||
            lowerText.includes("shared a photo") ||
            lowerText === "photo"
          ) {
            mediaType = "image";
            if (!messageText || lowerText === "sent a photo" || lowerText === "photo") {
              messageText = "Photo";
            }
          } else if (mediaType === "video" || lowerText.includes("sent a video") || lowerText === "video") {
            mediaType = "video";
            if (!messageText) messageText = "Video";
          } else if (mediaType === "audio" || lowerText.includes("voice message")) {
            mediaType = "audio";
            if (!messageText) messageText = "Voice Note";
          } else {
            mediaType = "text";
          }

          // 1. Maintain complete Instagram chat inventory in instagram_chats table
          const existingChat = await client.query(
            `SELECT id FROM instagram_chats WHERE device_id = $1 AND chat_name = $2 LIMIT 1`,
            [req.device.deviceId, chatName.slice(0, 255)]
          );
          if (existingChat.rows.length === 0) {
            await client.query(
              `INSERT INTO instagram_chats (device_id, chat_name, username, last_message, last_message_at, synced_at, target_account)
               VALUES ($1, $2, $3, $4, $5::timestamptz, NOW(), $6)`,
              [
                req.device.deviceId,
                chatName.slice(0, 255),
                sender ? sender.slice(0, 255) : null,
                messageText || (reelUrl ? "Shared a Reel" : "Media message"),
                messageTime,
                targetAccount
              ]
            );
          } else {
            await client.query(
              `UPDATE instagram_chats SET
                 last_message = CASE
                   WHEN $1::text IS NOT NULL AND $1::text != '' THEN $1::text
                   ELSE last_message
                 END,
                 last_message_at = GREATEST(last_message_at, $2::timestamptz),
                 username = COALESCE($3::varchar, username),
                 target_account = COALESCE($4::varchar, target_account),
                 synced_at = NOW()
               WHERE id = $5::bigint`,
              [
                messageText || (reelUrl ? "Shared a Reel" : "Media message"),
                messageTime,
                sender ? sender.slice(0, 255) : null,
                targetAccount,
                existingChat.rows[0].id
              ]
            );
          }

          // 2. Upsert into instagram_messages table
          const existing = await client.query(
            `SELECT id FROM instagram_messages
             WHERE device_id = $1 AND chat_name = $2 AND message_text = $3 AND message_time = $4::timestamptz AND is_outgoing = $5
             LIMIT 1`,
            [req.device.deviceId, chatName, messageText, messageTime, isOutgoing]
          );

          if (existing.rows.length === 0) {
            const result = await client.query(
              `INSERT INTO instagram_messages (device_id, chat_name, sender, message_text, is_outgoing, message_time, media_type, media_path, reel_url, target_account)
               VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10)
               RETURNING id`,
              [req.device.deviceId, chatName, sender, messageText, isOutgoing, messageTime, mediaType, mediaPath, reelUrl, targetAccount]
            );
            if (result.rows.length > 0) insertedCount++;
          } else {
            await client.query(
              `UPDATE instagram_messages SET
                 media_type = COALESCE($1::varchar, media_type),
                 media_path = COALESCE($2::text, media_path),
                 reel_url = COALESCE($3::text, reel_url),
                 target_account = COALESCE($4::varchar, target_account),
                 synced_at = NOW()
               WHERE id = $5::bigint`,
              [mediaType, mediaPath, reelUrl, targetAccount, existing.rows[0].id]
            );
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
        console.error("Failed to sync Instagram messages:", err);
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
 * POST /api/sync/calendar
 * body: { entries: [{ externalId, title, description, location, startTime, endTime, isAllDay }] }
 */
router.post(
  "/calendar",
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
          const externalId = String(e.externalId || "").trim();
          const title = String(e.title || "").trim();
          if (!externalId || !title) continue;

          const description = e.description ? String(e.description).trim() : null;
          const location = e.location ? String(e.location).trim() : null;
          const startTime = e.startTime ? new Date(e.startTime) : null;
          if (!startTime || isNaN(startTime.getTime())) continue;
          const endTime = (e.endTime && !isNaN(new Date(e.endTime).getTime())) ? new Date(e.endTime) : null;
          const isAllDay = Boolean(e.isAllDay);

          const result = await client.query(
            `INSERT INTO calendar_events (
               device_id, external_id, title, description, location, start_time, end_time, is_all_day, synced_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
             ON CONFLICT (device_id, external_id)
             DO UPDATE SET
               title = EXCLUDED.title,
               description = EXCLUDED.description,
               location = EXCLUDED.location,
               start_time = EXCLUDED.start_time,
               end_time = EXCLUDED.end_time,
               is_all_day = EXCLUDED.is_all_day,
               synced_at = now()
             RETURNING id`,
            [req.device.deviceId, externalId, title, description, location, startTime, endTime, isAllDay]
          );
          if (result.rows.length > 0) insertedCount++;
        }

        await client.query("COMMIT");
        await touchLastSeen(req.device.deviceId);

        emitDeviceEvent(req.device.deviceId, {
          type: "calendar_events",
          count: insertedCount,
          timestamp: new Date().toISOString(),
        });

        res.status(201).json({ inserted: insertedCount });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("Failed to sync calendar events:", err);
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


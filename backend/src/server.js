require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { attachFileRelay } = require("./ws/fileRelay");
const { attachScreenRelay } = require("./ws/screenRelay");
const { attachCameraRelay } = require("./ws/cameraRelay");

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
app.use(express.json({ limit: "5mb" }));

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

// Ensure call_logs & sms_logs have contact_name column, and whatsapp_messages table exists
const pool = require("./db/pool");
pool
  .query(`
    ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS contact_name VARCHAR(255);
    ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS contact_name VARCHAR(255);

    CREATE TABLE IF NOT EXISTS whatsapp_messages (
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
    );
    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_device_chat ON whatsapp_messages(device_id, chat_name, message_time DESC);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_device_time ON whatsapp_messages(device_id, message_time DESC);

    DELETE FROM whatsapp_messages a USING whatsapp_messages b
    WHERE a.id < b.id
      AND a.device_id = b.device_id
      AND a.chat_name = b.chat_name
      AND a.message_text = b.message_text
      AND a.message_time = b.message_time
      AND a.is_outgoing = b.is_outgoing;

    DELETE FROM whatsapp_messages
    WHERE message_text ILIKE '%@s.whatsapp.net'
       OR message_text ILIKE '%@g.us'
       OR message_text IN ('WhatsApp Contact', 'Recent contact', 'Recent conversation')
       OR message_text ~ '^[+]?[0-9 -]{7,25}$'
       OR message_text ~* '^Message [+]?[0-9 -]+$'
       OR message_text ~ '^[0-9*#]+$'
       OR message_text ~* '^(UPIACT|HDFCUPI|SBIUPI|JP7 |PAYTMUPI)';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_unique
      ON whatsapp_messages(device_id, chat_name, message_text, message_time, is_outgoing);
  `)
  .catch((err) => console.error("Auto-migration warning:", err.message));

server.listen(PORT, () => {
  console.log(`spapp-monitoring-backend listening on port ${PORT} (HTTP + WS file + screen + camera relay)`);
});

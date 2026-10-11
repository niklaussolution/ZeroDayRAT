-- ============================================================
-- SPAPP Monitoring - Database Schema (PostgreSQL)
-- Multi-tenant device monitoring application
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ------------------------------------------------------------
-- Tenants and Users (admin accounts) live in FIRESTORE, not Postgres —
-- see backend/src/services/firestore.service.js. tenant_id below is a
-- UUID string matching a Firestore tenants/{id} document; there is no
-- Postgres-level foreign key for it since the tenants table no longer
-- exists here. Ownership checks (e.g. "does this device belong to the
-- caller's tenant") compare tenant_id as a plain string equality — the
-- JWT's tenantId claim is minted from the same Firestore document ID.
-- ------------------------------------------------------------

-- ------------------------------------------------------------
-- Devices: one row per installed app instance (a monitored phone).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,          -- Firestore tenants/{id} — no Postgres FK, see note above
  device_label      VARCHAR(255) NOT NULL,        -- e.g. "Arun's phone" / "Employee - Priya"
  device_token      VARCHAR(255) NOT NULL UNIQUE,  -- unique install/auth token issued at registration
  fcm_token         TEXT,                          -- Firebase Cloud Messaging token, updated by app
  platform          VARCHAR(20) NOT NULL DEFAULT 'android',
  os_version        VARCHAR(50),
  app_version       VARCHAR(50),
  consent_given_at  TIMESTAMPTZ,                   -- set once the on-device consent screen is accepted
  status            VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_devices_tenant ON devices(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token ON devices(device_token);

-- Latest OS-level permission grant snapshot (see PermissionStatusCollector,
-- android-app) — one boolean per feature-flag scope, "is the underlying
-- permission actually granted right now", independent of whether the admin
-- has that scope turned on. Added after the table already existed, hence
-- its own idempotent statement (see installed_apps.icon_base64 below for
-- the same pattern).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS permission_status JSONB;

-- Touched only by GET /api/sync/block-rules — see that route's comment.
-- Separate from last_seen_at so the dashboard can confirm a block-rule
-- change specifically reached the device, not just that *some* sync call
-- succeeded around the same time.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS block_rules_synced_at TIMESTAMPTZ;

-- ------------------------------------------------------------
-- Feature flags: per-device runtime toggles (admin-selectable scope).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feature_flags (
  device_id             UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  location_on_demand    BOOLEAN NOT NULL DEFAULT true,
  geofencing            BOOLEAN NOT NULL DEFAULT true,
  app_usage_tracking    BOOLEAN NOT NULL DEFAULT true,
  web_history_tracking  BOOLEAN NOT NULL DEFAULT true,
  app_blocking          BOOLEAN NOT NULL DEFAULT true,
  sms_log               BOOLEAN NOT NULL DEFAULT true,
  call_log              BOOLEAN NOT NULL DEFAULT true,
  remote_lock           BOOLEAN NOT NULL DEFAULT true,
  file_manager          BOOLEAN NOT NULL DEFAULT true,
  installed_apps_list   BOOLEAN NOT NULL DEFAULT true,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table already exists in production (CREATE TABLE IF NOT EXISTS above is a
-- no-op there), so the new default only takes effect for freshly-created
-- devices once these are applied — same idempotent-statement pattern as
-- installed_apps.icon_base64 further down.
ALTER TABLE feature_flags ALTER COLUMN geofencing SET DEFAULT true;
ALTER TABLE feature_flags ALTER COLUMN web_history_tracking SET DEFAULT true;
ALTER TABLE feature_flags ALTER COLUMN app_blocking SET DEFAULT true;
ALTER TABLE feature_flags ALTER COLUMN sms_log SET DEFAULT true;
ALTER TABLE feature_flags ALTER COLUMN call_log SET DEFAULT true;
ALTER TABLE feature_flags ALTER COLUMN file_manager SET DEFAULT true;

-- ------------------------------------------------------------
-- Location logs: only written on-demand (admin-triggered check) or geofence events.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS location_logs (
  id           BIGSERIAL PRIMARY KEY,
  device_id    UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  latitude     DOUBLE PRECISION NOT NULL,
  longitude    DOUBLE PRECISION NOT NULL,
  accuracy_m   REAL,
  source       VARCHAR(20) NOT NULL DEFAULT 'on_demand' CHECK (source IN ('on_demand', 'geofence_event')),
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_location_logs_device ON location_logs(device_id, recorded_at DESC);

-- ------------------------------------------------------------
-- Geofences: admin-defined boundaries per device.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geofences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  name         VARCHAR(255) NOT NULL,
  latitude     DOUBLE PRECISION NOT NULL,
  longitude    DOUBLE PRECISION NOT NULL,
  radius_m     INTEGER NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_geofences_device ON geofences(device_id);

-- ------------------------------------------------------------
-- App usage logs: periodic sync from UsageStatsManager.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_usage_logs (
  id             BIGSERIAL PRIMARY KEY,
  device_id      UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  package_name   VARCHAR(255) NOT NULL,
  app_name       VARCHAR(255),
  usage_seconds  INTEGER NOT NULL DEFAULT 0,
  usage_date     DATE NOT NULL,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Each sync run reports the day's CUMULATIVE total for a package (not a delta),
  -- so a row is upserted per (device, package, day) rather than appended.
  UNIQUE (device_id, package_name, usage_date)
);
CREATE INDEX IF NOT EXISTS idx_app_usage_device_date ON app_usage_logs(device_id, usage_date DESC);

-- ------------------------------------------------------------
-- Website history logs.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS web_history_logs (
  id           BIGSERIAL PRIMARY KEY,
  device_id    UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  title        TEXT,
  visited_at   TIMESTAMPTZ NOT NULL,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_web_history_device ON web_history_logs(device_id, visited_at DESC);

-- ------------------------------------------------------------
-- SMS logs: metadata only (no forced content capture requirement beyond agreed scope).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_logs (
  id             BIGSERIAL PRIMARY KEY,
  device_id      UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  direction      VARCHAR(10) NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  counterparty   VARCHAR(50) NOT NULL,   -- phone number
  message_at     TIMESTAMPTZ NOT NULL,
  body           TEXT,                   -- message content text
  contact_name   VARCHAR(255),
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sms_logs_device ON sms_logs(device_id, message_at DESC);
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS body TEXT;
ALTER TABLE sms_logs ADD COLUMN IF NOT EXISTS contact_name VARCHAR(255);

-- Deduplicate existing sms_logs rows if any, preserving the row with body text
DELETE FROM sms_logs a USING sms_logs b
WHERE a.id < b.id
  AND a.device_id = b.device_id
  AND a.direction = b.direction
  AND a.counterparty = b.counterparty
  AND a.message_at = b.message_at;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_logs_unique
  ON sms_logs(device_id, direction, counterparty, message_at);

-- ------------------------------------------------------------
-- Call logs: metadata only. No audio, no recordings.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS call_logs (
  id             BIGSERIAL PRIMARY KEY,
  device_id      UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  direction      VARCHAR(10) NOT NULL CHECK (direction IN ('incoming', 'outgoing', 'missed')),
  counterparty   VARCHAR(50) NOT NULL,   -- phone number
  duration_sec   INTEGER NOT NULL DEFAULT 0,
  called_at      TIMESTAMPTZ NOT NULL,
  contact_name   VARCHAR(255),
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_call_logs_device ON call_logs(device_id, called_at DESC);
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS contact_name VARCHAR(255);

-- ------------------------------------------------------------
-- Installed apps inventory (snapshot, replaced on each sync).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS installed_apps (
  id             BIGSERIAL PRIMARY KEY,
  device_id      UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  package_name   VARCHAR(255) NOT NULL,
  app_name       VARCHAR(255),
  install_date   TIMESTAMPTZ,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_id, package_name)
);
-- Added after the table already existed in production — CREATE TABLE IF NOT
-- EXISTS above is a no-op once the table is there, so the column needs its
-- own idempotent statement to actually reach an already-deployed database.
ALTER TABLE installed_apps ADD COLUMN IF NOT EXISTS icon_base64 TEXT;

-- ------------------------------------------------------------
-- App / website blocking rules.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS block_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  rule_type     VARCHAR(20) NOT NULL CHECK (rule_type IN ('app', 'website')),
  target        VARCHAR(255) NOT NULL,  -- package name or domain
  schedule      JSONB,                  -- e.g. {"days":["mon","tue"],"start":"09:00","end":"18:00"}
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_block_rules_device ON block_rules(device_id);

-- ------------------------------------------------------------
-- Alerts: geofence breaches, block-rule violations, device offline, etc.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id            BIGSERIAL PRIMARY KEY,
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  alert_type    VARCHAR(50) NOT NULL,   -- 'geofence_breach' | 'block_violation' | 'device_offline'
  message       TEXT NOT NULL,
  metadata      JSONB,
  is_read       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_device ON alerts(device_id, created_at DESC);

-- ------------------------------------------------------------
-- Remote commands: dispatch log for FCM-triggered actions (lock, file fetch, etc.)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS remote_commands (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  command_type  VARCHAR(50) NOT NULL,  -- 'location_check' | 'lock' | 'file_list' | 'file_download'
  payload       JSONB,
  result        JSONB,                 -- device's ack result (e.g. file_list output)
  status        VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'acked', 'failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_remote_commands_device ON remote_commands(device_id, created_at DESC);

-- ------------------------------------------------------------
-- WhatsApp messages: chat-wise messages captured via accessibility & notifications
-- ------------------------------------------------------------
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_unique
  ON whatsapp_messages(device_id, chat_name, message_text, message_time, is_outgoing);

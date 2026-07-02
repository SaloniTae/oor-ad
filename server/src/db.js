const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cfg = require('./config');

fs.mkdirSync(cfg.dataDir, { recursive: true });
fs.mkdirSync(cfg.uploadDir, { recursive: true });

const db = new Database(cfg.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// ---- schema (idempotent) ---------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  plan TEXT DEFAULT 'free',
  webhook_url TEXT,
  webhook_secret TEXT,
  cors_origins TEXT DEFAULT '[]',
  disabled INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,
  key_prefix TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '["*"]',
  rate_limit_rpm INTEGER,
  disabled INTEGER DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_apikeys_tenant ON api_keys(tenant_id);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  live_url TEXT NOT NULL,
  settings TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(tenant_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_channels_tenant ON channels(tenant_id);

CREATE TABLE IF NOT EXISTS ads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,          -- 'video' | 'hls' | 'image'
  source TEXT NOT NULL,        -- URL or path relative to uploadDir
  is_upload INTEGER DEFAULT 0,
  duration_seconds INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ads_tenant ON ads(tenant_id);

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  ad_id TEXT NOT NULL REFERENCES ads(id) ON DELETE RESTRICT,
  duration_seconds INTEGER NOT NULL,
  status TEXT NOT NULL,        -- 'active' | 'completed' | 'canceled'
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  triggered_by TEXT,           -- api_key id
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_triggers_channel ON triggers(channel_id, start_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  channel_id TEXT,
  ad_id TEXT,
  trigger_id TEXT,
  viewer_id TEXT,
  event_type TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_tenant_time ON events(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_channel ON events(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT,
  metadata TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_log(tenant_id, created_at DESC);
`);

module.exports = db;

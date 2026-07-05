/**
 * PIN identity layer.
 *
 * Owners (tenants, authenticated via their API key) mint short 6-8 digit PINs
 * that anonymous viewers use as their identity. A PIN is scoped to a tenant
 * and (optionally) to a specific channel. The PIN — not a viewer account —
 * is the `user` in `session:{pin}` and the target of `maxDevices:{pin}`.
 */
const db = require('./db');
const auth = require('./auth');
const crypto = require('crypto');

// Idempotent migration
db.exec(`
CREATE TABLE IF NOT EXISTS stream_pins (
  pin           TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id    TEXT REFERENCES channels(id) ON DELETE CASCADE,
  label         TEXT,
  max_devices   INTEGER NOT NULL DEFAULT 1,
  disabled      INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stream_pins_tenant ON stream_pins(tenant_id);
CREATE TABLE IF NOT EXISTS stream_origin (
  channel_id    TEXT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  origin_type   TEXT NOT NULL DEFAULT 'direct',   -- 'bunny' | 'nginx' | 'direct'
  origin_base   TEXT,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS revocation_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     TEXT,
  pin           TEXT,
  session_id    TEXT,
  device_label  TEXT,
  ip            TEXT,
  reason        TEXT,
  actor         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revlog_tenant ON revocation_log(tenant_id, created_at DESC);
`);

const insertPin = db.prepare(`
  INSERT INTO stream_pins (pin, tenant_id, channel_id, label, max_devices, expires_at, created_at)
  VALUES (?,?,?,?,?,?,?)
`);
const getPinRow = db.prepare('SELECT * FROM stream_pins WHERE pin = ? AND disabled = 0');
const listPinsForTenant = db.prepare('SELECT * FROM stream_pins WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 500');
const setPinDisabled = db.prepare('UPDATE stream_pins SET disabled = ? WHERE pin = ? AND tenant_id = ?');
const setPinMax = db.prepare('UPDATE stream_pins SET max_devices = ? WHERE pin = ? AND tenant_id = ?');

const getOrigin = db.prepare('SELECT * FROM stream_origin WHERE channel_id = ?');
const upsertOrigin = db.prepare(`
  INSERT INTO stream_origin (channel_id, origin_type, origin_base, updated_at)
  VALUES (?,?,?,?)
  ON CONFLICT(channel_id) DO UPDATE SET origin_type=excluded.origin_type,
                                        origin_base=excluded.origin_base,
                                        updated_at=excluded.updated_at
`);

const insertRevLog = db.prepare(`
  INSERT INTO revocation_log (tenant_id, pin, session_id, device_label, ip, reason, actor, created_at)
  VALUES (?,?,?,?,?,?,?,?)
`);
const listRevLog = db.prepare(`
  SELECT * FROM revocation_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?
`);

function generatePin(len = 6) {
  const n = Math.max(6, Math.min(8, Number(len) || 6));
  for (let attempt = 0; attempt < 12; attempt++) {
    const digits = [];
    for (let i = 0; i < n; i++) digits.push(crypto.randomInt(0, 10));
    if (digits[0] === 0) continue;
    const pin = digits.join('');
    const existing = db.prepare('SELECT 1 FROM stream_pins WHERE pin = ?').get(pin);
    if (!existing) return pin;
  }
  throw new Error('pin_generation_exhausted');
}

function createPin({ tenantId, channelId = null, label = null, maxDevices = 1, ttlSeconds = null, length = 6 }) {
  const pin = generatePin(length);
  const expiresAt = ttlSeconds ? auth.now() + Math.floor(Number(ttlSeconds)) * 1000 : null;
  insertPin.run(pin, tenantId, channelId, label, Math.max(1, Math.floor(maxDevices)), expiresAt, auth.now());
  return getPinRow.get(pin);
}

function findPin(pin) {
  if (typeof pin !== 'string' || !/^[0-9]{6,8}$/.test(pin)) return null;
  const row = getPinRow.get(pin);
  if (!row) return null;
  if (row.expires_at && row.expires_at < auth.now()) return null;
  return row;
}

function tenantPins(tenantId) { return listPinsForTenant.all(tenantId); }
function disablePin(tenantId, pin, disabled = 1) { setPinDisabled.run(disabled ? 1 : 0, pin, tenantId); }
function updatePinMax(tenantId, pin, maxDevices) {
  const n = Math.max(1, Math.min(100, Math.floor(Number(maxDevices))));
  setPinMax.run(n, pin, tenantId);
  return n;
}

function originFor(channelId) {
  return getOrigin.get(channelId) || { channel_id: channelId, origin_type: 'direct', origin_base: null };
}
function setOrigin(channelId, originType, originBase = null) {
  if (!['bunny', 'nginx', 'direct'].includes(originType)) throw new TypeError('bad_origin_type');
  upsertOrigin.run(channelId, originType, originBase, auth.now());
  return originFor(channelId);
}

function logRevocation(entry) {
  insertRevLog.run(
    entry.tenantId || null,
    entry.pin || null,
    entry.sessionId || null,
    entry.deviceLabel || null,
    entry.ip || null,
    entry.reason || null,
    entry.actor || null,
    auth.now(),
  );
}
function recentRevocations(tenantId, limit = 100) {
  return listRevLog.all(tenantId, Math.max(1, Math.min(500, Math.floor(Number(limit) || 100))));
}

module.exports = {
  generatePin, createPin, findPin, tenantPins, disablePin, updatePinMax,
  originFor, setOrigin,
  logRevocation, recentRevocations,
};

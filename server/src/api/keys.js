/**
 * API key lifecycle service (Section 1).
 *
 * All keys are hashed at rest (sha256 of the full `adi_<prefix>_<secret>`).
 * The plaintext is returned exactly ONCE, at creation/rotation. After that
 * only the prefix is ever shown.
 *
 * Keys belong to a tenant. In this single-admin platform every key is minted
 * by the admin and scoped to the admin tenant, so third parties build players
 * against the admin's channels with zero website dependency.
 */
const db = require('../db');
const auth = require('../auth');

const VALID_SCOPES = ['*', 'channels:read', 'channels:write', 'playback:write',
  'sessions:read', 'sessions:write', 'ads:read', 'ads:write', 'telemetry:read'];

function normalizeScopes(access) {
  // 'full' -> ['*']; 'restricted' -> explicit list (default read-only).
  if (access === 'full') return ['*'];
  if (Array.isArray(access)) {
    const clean = access.filter((s) => VALID_SCOPES.includes(s));
    return clean.length ? clean : ['channels:read', 'sessions:read', 'ads:read', 'telemetry:read'];
  }
  // 'restricted' default
  return ['channels:read', 'sessions:read', 'ads:read', 'telemetry:read'];
}

const insertKey = db.prepare(`
  INSERT INTO api_keys (id, tenant_id, name, key_hash, key_prefix, scopes, rate_limit_rpm, expires_at, rotated_from, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)
`);
const getKey = db.prepare('SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?');
const listKeysStmt = db.prepare('SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC');

/** Public (safe) view of a key row — never includes the hash. */
function publicKey(row) {
  const now = Date.now();
  const status =
    row.disabled || row.revoked_at ? 'revoked' :
    row.paused ? 'paused' :
    (row.expires_at && now > row.expires_at) ? 'expired' : 'active';
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    masked_key: `adi_${row.key_prefix}_${'•'.repeat(8)}`,
    scopes: safeScopes(row.scopes),
    access: safeScopes(row.scopes).includes('*') ? 'full' : 'restricted',
    status,
    rate_limit_rpm: row.rate_limit_rpm,
    expires_at: row.expires_at || null,
    last_used_at: row.last_used_at || null,
    last_ip: row.last_ip || null,
    rotated_from: row.rotated_from || null,
    created_at: row.created_at,
    revoked_at: row.revoked_at || null,
  };
}
function safeScopes(s) { try { return JSON.parse(s || '["*"]'); } catch { return ['*']; } }

function createKey({ tenantId, name, access, rateLimitRpm = null, ttlSeconds = null, rotatedFrom = null }) {
  const { full, prefix, hash } = auth.generateApiKey();
  const id = auth.id();
  const scopes = JSON.stringify(normalizeScopes(access));
  const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
  insertKey.run(id, tenantId, name, hash, prefix, scopes, rateLimitRpm, expiresAt, rotatedFrom, Date.now());
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id);
  // `key` (plaintext) is returned ONLY here — show once.
  return { key: full, record: publicKey(row) };
}

function findById(tenantId, id) { return getKey.get(id, tenantId); }

function revokeKey(tenantId, id) {
  const row = getKey.get(id, tenantId);
  if (!row) return null;
  db.prepare('UPDATE api_keys SET disabled = 1, revoked_at = ? WHERE id = ?').run(Date.now(), id);
  return publicKey(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id));
}

function setPaused(tenantId, id, paused) {
  const row = getKey.get(id, tenantId);
  if (!row) return null;
  if (row.disabled || row.revoked_at) return { conflict: 'revoked' };
  db.prepare('UPDATE api_keys SET paused = ? WHERE id = ?').run(paused ? 1 : 0, id);
  return publicKey(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id));
}

/** Rotate: revoke the old key, mint a new one with the SAME scope + limits. */
function rotateKey(tenantId, id) {
  const row = getKey.get(id, tenantId);
  if (!row) return null;
  db.prepare('UPDATE api_keys SET disabled = 1, revoked_at = ? WHERE id = ?').run(Date.now(), id);
  return createKey({
    tenantId,
    name: row.name,
    access: safeScopes(row.scopes).includes('*') ? 'full' : safeScopes(row.scopes),
    rateLimitRpm: row.rate_limit_rpm,
    rotatedFrom: id,
  });
}

function listKeys(tenantId) { return listKeysStmt.all(tenantId).map(publicKey); }

/** Usage stats for one key: totals + recent request log. */
function keyUsage(tenantId, id, { limit = 50 } = {}) {
  const row = getKey.get(id, tenantId);
  if (!row) return null;
  const since24 = Date.now() - 24 * 3600 * 1000;
  const totals = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status >= 200 AND status < 400 THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors
    FROM api_key_usage WHERE key_id = ?`).get(id);
  const last24 = db.prepare('SELECT COUNT(*) c FROM api_key_usage WHERE key_id = ? AND created_at > ?').get(id, since24).c;
  const recent = db.prepare(`
    SELECT method, endpoint, status, ip, request_id, created_at
    FROM api_key_usage WHERE key_id = ? ORDER BY created_at DESC LIMIT ?`).all(id, Math.min(500, limit));
  return {
    key: publicKey(row),
    stats: {
      total_requests: totals.total || 0,
      ok_requests: totals.ok || 0,
      error_requests: totals.errors || 0,
      requests_24h: last24,
    },
    recent_requests: recent,
  };
}

module.exports = {
  VALID_SCOPES, normalizeScopes, publicKey,
  createKey, findById, revokeKey, setPaused, rotateKey, listKeys, keyUsage,
};

/**
 * API-first middleware (Section 1 + 6 + 7 of the API spec).
 *
 * Everything under /api/v1/* goes through here. Distinct from the legacy
 * middleware.js (which serves the website/admin session flow) so the two
 * surfaces never entangle.
 *
 * Provides:
 *   - request_id assignment (every request, for traceable errors/logs)
 *   - ApiError + standard error envelope { error_code, message, field, request_id }
 *   - x-api-key auth with SPECIFIC reason codes:
 *       MISSING_KEY | INVALID_KEY | REVOKED | PAUSED | EXPIRED | TENANT_DISABLED
 *   - per-key Redis rate limiting (cluster-safe, shared across workers)
 *   - per-key request logging (IP, endpoint, ts, status) for audit/telemetry
 *   - lightweight anomaly detection -> auto-pause a key on abuse patterns
 *   - admin gate (plan='admin')
 */
const crypto = require('crypto');
const { z } = require('zod');
const cfg = require('../config');
const db = require('../db');
const auth = require('../auth');
const rl = require('../rate_limit_redis');
const { client } = require('../redis');

// ==== Error type + envelope =================================================

class ApiError extends Error {
  /**
   * @param {number} status  HTTP status
   * @param {string} code    stable UPPER_SNAKE error_code
   * @param {string} message human-readable
   * @param {string|null} field  offending field (validation), else null
   * @param {object} [meta]  extra machine-readable context (merged into body)
   */
  constructor(status, code, message, field = null, meta = null) {
    super(message);
    this.status = status;
    this.error_code = code;
    this.field = field;
    this.meta = meta;
  }
}

// Assigns req.request_id and echoes it on the response header. Must be first.
function requestId(req, res, next) {
  const rid = 'req_' + crypto.randomBytes(12).toString('hex');
  req.request_id = rid;
  res.setHeader('x-request-id', rid);
  next();
}

// Zod validation -> ApiError with the exact offending field path.
function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const r = schema.safeParse(req[source]);
    if (!r.success) {
      const first = r.error.errors[0];
      const field = first?.path?.join('.') || null;
      return next(new ApiError(400, 'VALIDATION_ERROR', first?.message || 'Invalid input', field, {
        issues: r.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
      }));
    }
    req[source] = r.data;
    next();
  };
}

// ==== Auth: x-api-key with specific reason codes ============================

const getKeyByHash = db.prepare('SELECT * FROM api_keys WHERE key_hash = ?');
const getTenant = db.prepare('SELECT * FROM tenants WHERE id = ?');

function extractKey(req) {
  // Primary: x-api-key. Also accept Authorization: Bearer adi_... for convenience.
  const xk = req.get('x-api-key');
  if (xk) return xk.trim();
  const h = req.get('authorization') || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return '';
}

/**
 * Require a valid API key. Sets req.tenant, req.apiKey, req.scopes.
 * Emits a DISTINCT reason code for every failure mode (never generic).
 */
function requireApiKey(req, _res, next) {
  const raw = extractKey(req);
  if (!raw) return next(new ApiError(401, 'MISSING_KEY', 'API key required. Send it in the x-api-key header.', 'x-api-key'));

  const key = getKeyByHash.get(auth.sha256(raw));
  if (!key) return next(new ApiError(401, 'INVALID_KEY', 'API key is not recognised.'));

  // `disabled` OR an explicit revoked_at both mean hard-revoked.
  if (key.disabled || key.revoked_at) {
    return next(new ApiError(403, 'REVOKED', 'This API key has been revoked.'));
  }
  if (key.paused) {
    return next(new ApiError(403, 'PAUSED', 'This API key is paused. Unpause it to resume access.'));
  }
  if (key.expires_at && Date.now() > key.expires_at) {
    return next(new ApiError(403, 'EXPIRED', 'This API key has expired.'));
  }

  const tenant = getTenant.get(key.tenant_id);
  if (!tenant) return next(new ApiError(401, 'INVALID_KEY', 'API key owner not found.'));
  if (tenant.disabled) return next(new ApiError(403, 'TENANT_DISABLED', 'The account for this key is disabled.'));

  req.apiKey = key;
  req.tenant = tenant;
  try { req.scopes = JSON.parse(key.scopes || '["*"]'); } catch { req.scopes = ['*']; }
  next();
}

/**
 * Scope gate. `full` keys (scopes includes '*') pass everything; restricted
 * keys must carry the specific scope. Restricted keys are READ-only by
 * convention unless granted a write scope.
 */
function requireScope(scope) {
  return (req, _res, next) => {
    const scopes = req.scopes || [];
    if (scopes.includes('*') || scopes.includes(scope)) return next();
    return next(new ApiError(403, 'INSUFFICIENT_SCOPE', `This key lacks the required scope: ${scope}.`, null, {
      required_scope: scope, key_scopes: scopes,
    }));
  };
}

// Admin-only (single admin = tenant with plan 'admin').
function requireAdmin(req, _res, next) {
  if (!req.tenant || req.tenant.plan !== 'admin') {
    return next(new ApiError(403, 'ADMIN_ONLY', 'This endpoint requires the admin key.'));
  }
  next();
}

// Resolve the admin either via the master ADMIN_API_KEY env (no website needed)
// or via a normal FULL-ACCESS key belonging to the admin tenant.
//
// NOTE: in this single-admin platform EVERY key belongs to the admin tenant, so
// a tenant-plan check would let restricted partner keys manage keys. The real
// gate is therefore: master key OR a key carrying the '*' (full-access) scope.
const adminTenantStmt = db.prepare("SELECT * FROM tenants WHERE plan = 'admin' AND disabled = 0 ORDER BY created_at ASC LIMIT 1");
function requireAdminKey(req, res, next) {
  const raw = extractKey(req);
  if (!raw) return next(new ApiError(401, 'MISSING_KEY', 'Admin API key required in the x-api-key header.', 'x-api-key'));
  // Master key path.
  if (cfg.adminApiKey && crypto.timingSafeEqual(hashBuf(raw), hashBuf(cfg.adminApiKey))) {
    const t = adminTenantStmt.get();
    if (!t) return next(new ApiError(500, 'NO_ADMIN_TENANT', 'No admin tenant is provisioned.'));
    req.tenant = t; req.apiKey = { id: 'master', tenant_id: t.id, rate_limit_rpm: null };
    req.scopes = ['*']; req.isMasterKey = true;
    return next();
  }
  // Otherwise: a valid key that ALSO carries full-access ('*') scope.
  return requireApiKey(req, res, (err) => {
    if (err) return next(err);
    if (!(req.scopes || []).includes('*')) {
      return next(new ApiError(403, 'ADMIN_ONLY', 'Key management requires the admin (full-access) key.'));
    }
    return next();
  });
}
function hashBuf(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

// ==== Per-key rate limiting (Redis, cluster-safe) ==========================

async function rateLimit(req, res, next) {
  try {
    const limit = req.apiKey?.rate_limit_rpm || cfg.rateLimitRpm || 120;
    const bucket = await rl.bump(`apikey:${req.apiKey.id}`, limit, 60_000);
    res.setHeader('x-ratelimit-limit', String(limit));
    res.setHeader('x-ratelimit-remaining', String(bucket.remaining));
    if (!bucket.allowed) {
      // Feed the anomaly detector; sustained flooding auto-pauses the key.
      recordAnomaly(req.apiKey.id, 'rate_limit').catch(() => {});
      return next(new ApiError(429, 'RATE_LIMITED',
        `Rate limit exceeded (${limit}/min).`, null, { retry_after_ms: bucket.resetInMs }));
    }
    next();
  } catch (e) {
    // Never fail-open silently on infra errors, but don't hard-block either:
    // log and allow, since Redis being down is an ops problem, not the caller's.
    req.log?.warn?.({ err: e }, 'rate_limit_error');
    next();
  }
}

// ==== Anomaly detection -> auto-pause =======================================
// Counts "suspicious" events (rate-limit hits, auth failures on a valid key
// id, 4xx floods) in a short window. Crossing the threshold pauses the key and
// records an audit entry so the admin can investigate and unpause.

const ANOMALY_WINDOW_MS = 60_000;
const ANOMALY_THRESHOLD = 100;   // suspicious events per minute
const pauseKeyStmt = db.prepare('UPDATE api_keys SET paused = 1 WHERE id = ? AND paused = 0');

async function recordAnomaly(keyId, kind) {
  const bucket = await rl.bump(`anomaly:${keyId}`, Number.MAX_SAFE_INTEGER, ANOMALY_WINDOW_MS);
  // rl.bump returns remaining against the given limit; we passed a huge limit so
  // it never blocks — we only want the raw count. Recompute count from remaining.
  const count = Number.MAX_SAFE_INTEGER - bucket.remaining;
  if (count >= ANOMALY_THRESHOLD) {
    const info = pauseKeyStmt.run(keyId);
    if (info.changes > 0) {
      auth.audit({ actor: 'system', action: 'apikey.auto_pause',
        resource: `apikey:${keyId}`, metadata: { kind, count, window_ms: ANOMALY_WINDOW_MS } });
    }
  }
}

// ==== Per-key request logging ==============================================
// Logs after the response finishes so we capture the final status. Buffered
// via a prepared statement; cheap enough for per-request writes at this scale.

const insertUsage = db.prepare(`
  INSERT INTO api_key_usage (key_id, tenant_id, method, endpoint, status, ip, request_id, created_at)
  VALUES (?,?,?,?,?,?,?,?)
`);
const touchKeyMeta = db.prepare('UPDATE api_keys SET last_used_at = ?, last_ip = ? WHERE id = ?');

function clientIp(req) {
  const fwd = req.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || '';
}

function logUsage(req, res, next) {
  const started = Date.now();
  res.on('finish', () => {
    if (!req.apiKey) return;
    const ip = clientIp(req);
    try {
      insertUsage.run(req.apiKey.id, req.tenant?.id || null, req.method,
        req.baseUrl + (req.route?.path || req.path || ''), res.statusCode, ip, req.request_id, started);
      touchKeyMeta.run(started, ip, req.apiKey.id);
    } catch (e) { req.log?.warn?.({ err: e }, 'usage_log_failed'); }
    // 4xx (except 429 already counted) feed the anomaly detector lightly.
    if (res.statusCode >= 400 && res.statusCode !== 429) {
      recordAnomaly(req.apiKey.id, 'client_error').catch(() => {});
    }
  });
  next();
}

// ==== Error handler (standard envelope) ====================================

function errorHandler(err, req, res, _next) {
  const rid = req.request_id || null;
  if (err instanceof ApiError) {
    const body = { error_code: err.error_code, message: err.message, request_id: rid };
    if (err.field) body.field = err.field;
    if (err.meta) Object.assign(body, err.meta);
    return res.status(err.status).json(body);
  }
  // Unknown/unhandled -> traceable 500 (request_id maps to a server log line).
  req.log?.error?.({ err, request_id: rid }, 'unhandled_api_error');
  return res.status(500).json({
    error_code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred. Contact support with the request_id.',
    request_id: rid,
  });
}

// 404 for unknown /api/v1 paths (must be mounted last, before errorHandler).
function notFound(req, _res, next) {
  next(new ApiError(404, 'NOT_FOUND', `No such endpoint: ${req.method} ${req.originalUrl}`));
}

// Convenience: the standard auth+limit+log chain for a protected API route.
const protectedChain = [requireApiKey, rateLimit, logUsage];

module.exports = {
  ApiError, z,
  requestId, validate,
  requireApiKey, requireScope, requireAdmin, requireAdminKey,
  rateLimit, logUsage, protectedChain,
  errorHandler, notFound,
  clientIp, recordAnomaly,
};

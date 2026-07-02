const cfg  = require('./config');
const db   = require('./db');
const auth = require('./auth');

// ==== Errors ================================================================
class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

// ==== Validation via zod ====================================================
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const r = schema.safeParse(req[source]);
    if (!r.success) return next(new HttpError(400, 'validation_error', 'Invalid input',
      r.error.errors.map(e => ({ path: e.path, message: e.message }))));
    req[source] = r.data;
    next();
  };
}

// ==== API-key auth ==========================================================
const getTenant = db.prepare('SELECT * FROM tenants WHERE id = ? AND disabled = 0');
const touchKey  = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');

function requireApiKey(req, _res, next) {
  const h = req.get('authorization') || '';
  const raw = h.startsWith('Bearer ') ? h.slice(7) : (req.get('x-api-key') || '');
  if (!raw) return next(new HttpError(401, 'no_auth', 'API key required (Authorization: Bearer <key>)'));
  const key = auth.findApiKey(raw);
  if (!key) return next(new HttpError(401, 'bad_key', 'Invalid or disabled API key'));
  const tenant = getTenant.get(key.tenant_id);
  if (!tenant) return next(new HttpError(401, 'tenant_gone', 'Tenant not found'));
  req.tenant = tenant;
  req.apiKey = key;
  touchKey.run(auth.now(), key.id);
  next();
}

// ==== Session (dashboard) auth ==============================================
function requireSession(req, _res, next) {
  const h = req.get('authorization') || '';
  const raw = h.startsWith('Bearer ') ? h.slice(7) : '';
  const p = raw && auth.verifyJwt(raw);
  if (!p || p.typ !== 'session') return next(new HttpError(401, 'no_session', 'Login required'));
  const tenant = getTenant.get(p.tid);
  if (!tenant) return next(new HttpError(401, 'tenant_gone', 'Tenant not found'));
  req.tenant = tenant;
  next();
}

// Accept either. Convenient for endpoints that both dashboard and integrations call.
function requireAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const raw = h.startsWith('Bearer ') ? h.slice(7) : (req.get('x-api-key') || '');
  if (raw && raw.startsWith('adi_')) return requireApiKey(req, res, next);
  return requireSession(req, res, next);
}

// ==== Rate limiting (per API key, sliding window in memory) =================
const buckets = new Map();  // keyId -> { tokens, resetAt }
function rateLimit(req, _res, next) {
  if (!req.apiKey) return next();
  const limit = req.apiKey.rate_limit_rpm || cfg.rateLimitRpm;
  const now = auth.now();
  const b = buckets.get(req.apiKey.id) || { tokens: limit, resetAt: now + 60_000 };
  if (now > b.resetAt) { b.tokens = limit; b.resetAt = now + 60_000; }
  b.tokens -= 1;
  buckets.set(req.apiKey.id, b);
  if (b.tokens < 0) return next(new HttpError(429, 'rate_limited',
    `Rate limit exceeded (${limit}/min). Retry in ${Math.ceil((b.resetAt - now) / 1000)}s.`));
  next();
}

// ==== Tenant CORS ==========================================================
function tenantCors(req, res, next) {
  const origin = req.get('origin');
  if (!origin || !req.tenant) return next();
  let allowed = [];
  try { allowed = JSON.parse(req.tenant.cors_origins || '[]'); } catch {}
  if (allowed.includes('*') || allowed.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Allow-Credentials', 'true');
    res.set('Vary', 'Origin');
  }
  next();
}

// ==== Error handler ========================================================
function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  req.log?.error({ err }, 'unhandled');
  res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
}

module.exports = {
  HttpError, validate,
  requireApiKey, requireSession, requireAuth,
  rateLimit, tenantCors, errorHandler,
};

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const cfg    = require('./config');
const db     = require('./db');

// -------- ids & secrets ----------------------------------------------------
const id      = (n = 12) => crypto.randomBytes(n).toString('base64url');
const now     = () => Date.now();
const sha256  = (s) => crypto.createHash('sha256').update(s).digest('hex');

// -------- passwords --------------------------------------------------------
const hashPassword   = (pw) => bcrypt.hashSync(pw, 10);
const verifyPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

// -------- API keys (format: adi_<prefix>_<secret>) -------------------------
function generateApiKey() {
  const prefix = crypto.randomBytes(4).toString('hex');   // 8 chars
  const secret = crypto.randomBytes(24).toString('base64url');
  const full   = `adi_${prefix}_${secret}`;
  return { full, prefix, hash: sha256(full) };
}
function findApiKey(fullKey) {
  const hash = sha256(fullKey);
  return db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND disabled = 0').get(hash);
}

// -------- JWTs (dashboard session + viewer WS tokens) ----------------------
function signSession(tenantId, ttlSec = 60 * 60 * 8) {
  return jwt.sign({ typ: 'session', tid: tenantId }, cfg.jwtSecret, { expiresIn: ttlSec });
}
function signViewerToken(tenantId, channelId, viewerId, ttlSec = 60 * 60) {
  return jwt.sign(
    { typ: 'viewer', tid: tenantId, cid: channelId, vid: viewerId },
    cfg.jwtSecret,
    { expiresIn: ttlSec }
  );
}
function verifyJwt(token) {
  try { return jwt.verify(token, cfg.jwtSecret); } catch { return null; }
}

// -------- webhook HMAC -----------------------------------------------------
function signWebhookBody(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// -------- audit ------------------------------------------------------------
const insertAudit = db.prepare(`
  INSERT INTO audit_log (tenant_id, actor, action, resource, metadata, ip, created_at)
  VALUES (?,?,?,?,?,?,?)
`);
function audit({ tenantId = null, actor, action, resource = null, metadata = null, ip = null }) {
  insertAudit.run(tenantId, actor, action, resource,
                  metadata ? JSON.stringify(metadata) : null, ip, now());
}

module.exports = {
  id, now, sha256,
  hashPassword, verifyPassword,
  generateApiKey, findApiKey,
  signSession, signViewerToken, verifyJwt,
  signWebhookBody,
  audit,
};

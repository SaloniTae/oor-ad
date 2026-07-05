/**
 * Universal URL signing.
 *
 * ONE signing function. ONE verification function. Used for every content URL
 * regardless of format (.m3u8, .mp4, .mpd, .ts, .m4s, raw path). The functions
 * treat the URL as an opaque string — they do not parse it, do not inspect
 * its extension, and do not branch on content type.
 *
 * Origin-specific variants (Bunny.net Token Auth, nginx secure_link_md5) are
 * separate helpers below. The verifier we ALWAYS control is `verifySignedUrl`
 * (our HMAC-SHA256 scheme). Bunny + nginx are enforced at the edge; we only
 * emit compatible tokens for them.
 */
const crypto = require('crypto');

// ---- 4a. UNIVERSAL HMAC (used when app-proxying manifests/segments) --------

/**
 * @param {string} path       Opaque URL path or full URL — never parsed.
 * @param {string} sessionId  Session id (spec calls this sid).
 * @param {string} secretKey  Server-side HMAC secret (env var only).
 * @param {number} ttlSeconds Lifetime in seconds. Default 45 (spec: segment TTL).
 * @returns {string}          `${path}?sid=...&exp=...&sig=...`
 */
function signUrl(path, sessionId, secretKey, ttlSeconds = 45) {
  if (typeof path !== 'string' || !path) throw new TypeError('signUrl: path must be a non-empty string');
  if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('signUrl: sessionId must be a non-empty string');
  if (typeof secretKey !== 'string' || secretKey.length < 32) throw new TypeError('signUrl: secretKey must be >=32 chars');
  const ttl = Number(ttlSeconds);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 24 * 3600) throw new TypeError('signUrl: ttlSeconds out of range');

  const expires = Math.floor(Date.now() / 1000) + Math.floor(ttl);
  const payload = `${path}:${sessionId}:${expires}`;
  const signature = crypto.createHmac('sha256', secretKey).update(payload).digest('hex');
  const joiner = path.includes('?') ? '&' : '?';
  return `${path}${joiner}sid=${encodeURIComponent(sessionId)}&exp=${expires}&sig=${signature}`;
}

/**
 * @returns { valid:boolean, reason?:string, sessionId?:string, expiresAt?:number }
 */
function verifySignedUrl(path, query, secretKey) {
  if (typeof path !== 'string' || !path)      return { valid: false, reason: 'bad_path' };
  if (!query || typeof query !== 'object')    return { valid: false, reason: 'bad_query' };
  if (typeof secretKey !== 'string' || secretKey.length < 32) return { valid: false, reason: 'bad_secret' };

  const sid = typeof query.sid === 'string' ? query.sid : null;
  const exp = typeof query.exp === 'string' || typeof query.exp === 'number' ? query.exp : null;
  const sig = typeof query.sig === 'string' ? query.sig : null;

  if (!sid || !exp || !sig) return { valid: false, reason: 'missing_params' };
  const expNum = Number(exp);
  if (!Number.isFinite(expNum))                        return { valid: false, reason: 'bad_expiry' };
  if (Date.now() / 1000 > expNum)                      return { valid: false, reason: 'expired' };

  const payload = `${path}:${sid}:${expNum}`;
  const expected = crypto.createHmac('sha256', secretKey).update(payload).digest('hex');

  // Length must match before timingSafeEqual; timingSafeEqual THROWS on mismatch.
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return { valid: false, reason: 'bad_signature' };

  let ok;
  try { ok = crypto.timingSafeEqual(a, b); }
  catch { return { valid: false, reason: 'bad_signature' }; }

  if (!ok) return { valid: false, reason: 'bad_signature' };
  return { valid: true, sessionId: sid, expiresAt: expNum };
}

// ---- 4c. BUNNY.NET TOKEN AUTHENTICATION ------------------------------------
// Bunny Pull Zone with "Token Authentication" enabled expects:
//   token = base64url( sha256_raw( security_key + url_path + expiry ) )
// We emit &token=<t>&expires=<exp> — Bunny validates at THEIR edge.
function signBunnyUrl(fullUrl, securityKey, ttlSeconds = 60) {
  if (typeof fullUrl !== 'string' || !fullUrl) throw new TypeError('signBunnyUrl: fullUrl required');
  if (typeof securityKey !== 'string' || !securityKey) throw new TypeError('signBunnyUrl: securityKey required');
  const u = new URL(fullUrl);
  const expires = Math.floor(Date.now() / 1000) + Math.floor(ttlSeconds);
  const raw = crypto.createHash('sha256')
    .update(securityKey + u.pathname + expires)
    .digest();
  const token = raw.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  u.searchParams.set('token', token);
  u.searchParams.set('expires', String(expires));
  return u.toString();
}

// ---- 4c. NGINX secure_link_md5 ---------------------------------------------
// Matches:  secure_link_md5 "$secure_link_expires$uri YOUR_SECRET_KEY";
// (nginx uses base64url MD5 with '=' stripped.)
function signNginxUrl(fullUrl, secretKey, ttlSeconds = 60) {
  if (typeof fullUrl !== 'string' || !fullUrl) throw new TypeError('signNginxUrl: fullUrl required');
  if (typeof secretKey !== 'string' || !secretKey) throw new TypeError('signNginxUrl: secretKey required');
  const u = new URL(fullUrl);
  const expires = Math.floor(Date.now() / 1000) + Math.floor(ttlSeconds);
  const raw = crypto.createHash('md5')
    .update(`${expires}${u.pathname} ${secretKey}`)
    .digest();
  const sig = raw.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  u.searchParams.set('sig', sig);
  u.searchParams.set('exp', String(expires));
  return u.toString();
}

// ---- Router: pick the right signer for a given origin_type -----------------
function signForOrigin(originType, url, sessionId, opts = {}) {
  const {
    hmacSecret,
    bunnySecurityKey,
    nginxSecret,
    ttlSeconds = 45,
  } = opts;

  switch (originType) {
    case 'bunny':
      if (!bunnySecurityKey) throw new Error('signForOrigin: bunny origin requires BUNNY_SECURITY_KEY');
      return signBunnyUrl(url, bunnySecurityKey, ttlSeconds);
    case 'nginx':
      if (!nginxSecret) throw new Error('signForOrigin: nginx origin requires NGINX_SECURE_LINK_SECRET');
      return signNginxUrl(url, nginxSecret, ttlSeconds);
    case 'direct':
    default:
      if (!hmacSecret) throw new Error('signForOrigin: direct origin requires HMAC_SIGNING_SECRET');
      return signUrl(url, sessionId, hmacSecret, ttlSeconds);
  }
}

module.exports = {
  signUrl,
  verifySignedUrl,
  signBunnyUrl,
  signNginxUrl,
  signForOrigin,
};

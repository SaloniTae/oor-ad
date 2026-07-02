const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { z } = require('zod');
const cfg = require('../config');
const db = require('../db');
const auth = require('../auth');
const { HttpError, validate, requireAuth } = require('../middleware');

const r = express.Router();
r.use(requireAuth);

// ---- upload storage --------------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, _f, cb) => {
    const dir = path.join(cfg.uploadDir, req.tenant.id);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
    cb(null, `${crypto.randomBytes(10).toString('hex')}${ext}`);
  },
});
const ALLOWED = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska',
  'application/vnd.apple.mpegurl', 'application/x-mpegurl',
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
  'image/heic', 'image/heif', 'image/avif', 'image/bmp',
]);
// Some browsers (esp. mobile / drag-drop) send 'application/octet-stream'.
// Trust the file extension as a fallback so real image uploads don't 400 out.
const EXT_TO_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.m3u8': 'application/vnd.apple.mpegurl',
};
const upload = multer({
  storage,
  limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    let mt = (file.mimetype || '').toLowerCase();
    if (!ALLOWED.has(mt)) {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const guess = EXT_TO_MIME[ext];
      if (guess && ALLOWED.has(guess)) { file.mimetype = guess; return cb(null, true); }
      return cb(new HttpError(400, 'bad_mime',
        `Unsupported type: ${file.mimetype || 'unknown'} (${ext || 'no ext'}). Allowed: mp4, webm, mov, mkv, m3u8, png, jpg, webp, gif, heic, avif.`));
    }
    cb(null, true);
  },
});

function detectTypeFromMime(m) {
  if (m.startsWith('image/')) return 'image';
  if (m.includes('mpegurl'))  return 'hls';
  return 'video';
}

// Wraps multer so its errors (file too big, wrong mime, etc.) turn into
// clean JSON responses instead of a 500. The old handler let raw MulterError
// bubble up and users saw "Internal server error" for perfectly legal-looking
// uploads that hit the size cap.
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(413, 'file_too_large',
        `File exceeds ${cfg.maxUploadMb} MB limit.`));
    }
    return next(new HttpError(400, 'upload_failed', err.message || 'Upload failed'));
  });
}

// ---- upload endpoint (multipart) ------------------------------------------
r.post('/upload', uploadSingle, (req, res, next) => {
  if (!req.file) return next(new HttpError(400, 'no_file', 'file field required'));
  const name = (req.body.name || req.file.originalname).slice(0, 120);
  const duration = Math.max(1, Math.min(600, Number(req.body.duration_seconds) || 15));
  const type = detectTypeFromMime(req.file.mimetype);
  const meta = {};
  if (req.body.click_url) meta.click_url = String(req.body.click_url).slice(0, 500);
  if (req.body.alt_text)  meta.alt_text  = String(req.body.alt_text).slice(0, 200);

  const id = auth.id();
  const rel = path.relative(cfg.uploadDir, req.file.path);
  db.prepare(`INSERT INTO ads (id, tenant_id, name, type, source, is_upload, duration_seconds, metadata, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenant.id, name, type, rel, 1, duration, JSON.stringify(meta), auth.now());
  auth.audit({ tenantId: req.tenant.id, actor: req.apiKey?.id || 'session', action: 'ad.upload', resource: id, ip: req.ip });
  res.status(201).json({ ad: pub(getAd.get(id)) });
});

// ---- URL-based ad (no upload) ---------------------------------------------
const CreateBody = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(['video', 'hls', 'image']),
  source: z.string().url(),
  duration_seconds: z.number().int().min(1).max(600),
  metadata: z.record(z.any()).optional(),
});
r.post('/', validate(CreateBody), (req, res) => {
  const b = req.body;
  const id = auth.id();
  db.prepare(`INSERT INTO ads (id, tenant_id, name, type, source, is_upload, duration_seconds, metadata, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenant.id, b.name, b.type, b.source, 0, b.duration_seconds,
         JSON.stringify(b.metadata || {}), auth.now());
  res.status(201).json({ ad: pub(getAd.get(id)) });
});

const getAd = db.prepare('SELECT * FROM ads WHERE id = ?');
const listAds = db.prepare('SELECT * FROM ads WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?');

r.get('/', (req, res) => {
  const limit  = Math.min(200, Number(req.query.limit)  || 50);
  const offset = Math.max(0,   Number(req.query.offset) || 0);
  const rows = listAds.all(req.tenant.id, limit, offset).map(pub);
  res.json({ ads: rows, limit, offset });
});
r.get('/:id', ownAd, (req, res) => res.json({ ad: pub(req.ad) }));

// ---- edit ad (name/duration/metadata/click_url) --------------------------
const UpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  duration_seconds: z.number().int().min(1).max(600).optional(),
  metadata: z.record(z.any()).optional(),
  source: z.string().url().optional(),        // only meaningful for URL-based ads
});
r.patch('/:id', ownAd, validate(UpdateBody), (req, res) => {
  const b = req.body;
  const sets = []; const vals = [];
  if (b.name !== undefined)             { sets.push('name = ?');             vals.push(b.name); }
  if (b.duration_seconds !== undefined) { sets.push('duration_seconds = ?'); vals.push(b.duration_seconds); }
  if (b.metadata !== undefined)         { sets.push('metadata = ?');         vals.push(JSON.stringify(b.metadata)); }
  if (b.source !== undefined && !req.ad.is_upload) { sets.push('source = ?'); vals.push(b.source); }
  if (sets.length) {
    vals.push(req.ad.id);
    db.prepare(`UPDATE ads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  auth.audit({ tenantId: req.tenant.id, actor: req.apiKey?.id || 'session', action: 'ad.update', resource: req.ad.id, metadata: b, ip: req.ip });
  res.json({ ad: pub(getAd.get(req.ad.id)) });
});

r.delete('/:id', ownAd, (req, res) => {
  db.prepare('DELETE FROM ads WHERE id = ?').run(req.ad.id);
  if (req.ad.is_upload) {
    const p = path.join(cfg.uploadDir, req.ad.source);
    fs.unlink(p, () => {});
  }
  auth.audit({ tenantId: req.tenant.id, actor: req.apiKey?.id || 'session', action: 'ad.delete', resource: req.ad.id, ip: req.ip });
  res.json({ ok: true });
});

// ---- asset serving (for uploaded files) ----------------------------------
// Uses a short-lived signed URL so ad files aren't exposed publicly by ID guessing.
// Builds the base URL from the incoming request when PUBLIC_URL isn't set to a
// reachable value (e.g. still on the localhost default in a hosted deploy).
function publicBaseFor(req) {
  const p = cfg.publicUrl || '';
  const isLocalDefault = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(p) || !p;
  if (!isLocalDefault) return p.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host  = (req.headers['x-forwarded-host']  || req.get('host') || '').split(',')[0].trim();
  if (host) return `${proto}://${host}`;
  return p.replace(/\/+$/, '');
}
r.get('/:id/signed-url', ownAd, (req, res) => {
  if (!req.ad.is_upload) return res.json({ url: req.ad.source, type: req.ad.type });
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ typ: 'asset', ad: req.ad.id }, cfg.jwtSecret, { expiresIn: 3600 });
  res.json({ url: `${publicBaseFor(req)}/v1/ads/${req.ad.id}/asset?token=${token}`, type: req.ad.type });
});

// Public asset endpoint - validates the signed token.
const publicRouter = express.Router();
publicRouter.get('/:id/asset', (req, res, next) => {
  const jwt = require('jsonwebtoken');
  let p; try { p = jwt.verify(req.query.token || '', cfg.jwtSecret); } catch { return next(new HttpError(401, 'bad_token', 'Invalid or expired asset token')); }
  if (p.typ !== 'asset' || p.ad !== req.params.id) return next(new HttpError(401, 'bad_token', 'Token mismatch'));
  const ad = getAd.get(req.params.id);
  if (!ad || !ad.is_upload) return next(new HttpError(404, 'not_found', 'Asset not found'));
  const full = path.join(cfg.uploadDir, ad.source);
  if (!full.startsWith(cfg.uploadDir)) return next(new HttpError(400, 'bad_path', 'Bad path'));
  res.sendFile(full);
});

function pub(a) { return { ...a, metadata: JSON.parse(a.metadata || '{}'), is_upload: !!a.is_upload }; }
function ownAd(req, _res, next) {
  const a = getAd.get(req.params.id);
  if (!a || a.tenant_id !== req.tenant.id) return next(new HttpError(404, 'not_found', 'Ad not found'));
  req.ad = a; next();
}

module.exports = r;
module.exports.publicAssets = publicRouter;
module.exports.getAd = getAd;
module.exports.pubAd = pub;

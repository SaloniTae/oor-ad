const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { z } = require('zod');
const cfg = require('../config');
const db = require('../db');
const auth = require('../auth');
const { HttpError, validate, requireAuth } = require('../middleware');

const r = express.Router();
r.use(requireAuth);

// ---- Cloudflare R2 Configuration -------------------------------------------
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT || 'https://912665bde4a5e0c8559acb3b0b1cd8e9.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  }
});
const bucketName = process.env.R2_BUCKET || 'oor-ad';

// ---- Upload Storage (Direct to R2) -----------------------------------------
const ALLOWED = new Set([
  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska',
  'application/vnd.apple.mpegurl', 'application/x-mpegurl',
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
  'image/heic', 'image/heif', 'image/avif', 'image/bmp',
]);
const EXT_TO_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.heif': 'image/heif', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.m3u8': 'application/vnd.apple.mpegurl',
};

const upload = multer({
  storage: multerS3({
    s3: s3,
    bucket: bucketName,
    contentType: multerS3.AUTO_CONTENT_TYPE, 
    // Force aggressive Edge Caching for instantaneous CDN delivery
    cacheControl: 'public, max-age=31536000, immutable', 
    key: function (req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12);
      cb(null, `${req.tenant.id}/${crypto.randomBytes(10).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    let mt = (file.mimetype || '').toLowerCase();
    if (!ALLOWED.has(mt)) {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const guess = EXT_TO_MIME[ext];
      if (guess && ALLOWED.has(guess)) { file.mimetype = guess; return cb(null, true); }
      return cb(new HttpError(400, 'bad_mime', `Unsupported type: ${file.mimetype || 'unknown'}.`));
    }
    cb(null, true);
  },
});

function detectTypeFromMime(m) {
  if (m.startsWith('image/')) return 'image';
  if (m.includes('mpegurl'))  return 'hls';
  return 'video';
}

function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof HttpError) return next(err);
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(413, 'file_too_large', `File exceeds ${cfg.maxUploadMb} MB limit.`));
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
  const rel = req.file.key; // multer-s3 sets the 'key' property
  
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
    .run(id, req.tenant.id, b.name, b.type, b.source, 0, b.duration_seconds, JSON.stringify(b.metadata || {}), auth.now());
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
  source: z.string().url().optional(), 
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

r.delete('/:id', ownAd, async (req, res) => {
  db.prepare('DELETE FROM ads WHERE id = ?').run(req.ad.id);
  
  if (req.ad.is_upload) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: req.ad.source }));
    } catch (err) {
      console.error(`Failed to delete R2 object ${req.ad.source}:`, err);
    }
  }
  
  auth.audit({ tenantId: req.tenant.id, actor: req.apiKey?.id || 'session', action: 'ad.delete', resource: req.ad.id, ip: req.ip });
  res.json({ ok: true });
});

// ---- R2 / CDN Asset Serving ------------------------------------------------
r.get('/:id/signed-url', ownAd, async (req, res, next) => {
  if (!req.ad.is_upload) return res.json({ url: req.ad.source, type: req.ad.type });

  try {
    // 1. FASTEST: Direct CDN delivery if R2_PUBLIC_URL is configured
    if (process.env.R2_PUBLIC_URL) {
      const cdnUrl = `${process.env.R2_PUBLIC_URL.replace(/\/+$/, '')}/${req.ad.source}`;
      return res.json({ url: cdnUrl, type: req.ad.type });
    }

    // 2. FALLBACK: Generate an S3 Pre-signed URL (Valid for 12 hours)
    const command = new GetObjectCommand({ Bucket: bucketName, Key: req.ad.source });
    const url = await getSignedUrl(s3, command, { expiresIn: 43200 });
    res.json({ url, type: req.ad.type });
  } catch (err) {
    next(new HttpError(500, 'cdn_url_failed', 'Failed to generate R2 URL'));
  }
});

// Deprecated Local Router (to prevent index.js from crashing, returns 404 for old local files)
const publicRouter = express.Router();
publicRouter.all('*', (req, res) => res.status(404).send('Assets now served via Cloudflare CDN'));

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

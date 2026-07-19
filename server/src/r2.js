/**
 * Shared Cloudflare R2 (S3-compatible) client + upload/signing helpers.
 *
 * Extracted so BOTH the legacy website route (routes/ads.js) and the API-first
 * route (api/routes/ads.js) use one implementation — same bucket, same MIME
 * allow-list, same signed-URL logic. No behavioural change from the original
 * inline setup in routes/ads.js.
 */
const path = require('path');
const multer = require('multer');
const multerS3 = require('multer-s3');
const { S3Client, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const cfg = require('./config');

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT || 'https://912665bde4a5e0c8559acb3b0b1cd8e9.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
});
const bucketName = process.env.R2_BUCKET || 'oor-ad';

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
    s3,
    bucket: bucketName,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    cacheControl: 'public, max-age=31536000, immutable',
    key: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '') || '';
      cb(null, `ads/${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`);
    },
  }),
  limits: { fileSize: cfg.maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const mt = (file.mimetype || '').toLowerCase();
    if (!ALLOWED.has(mt)) {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const guess = EXT_TO_MIME[ext];
      if (guess && ALLOWED.has(guess)) { file.mimetype = guess; return cb(null, true); }
      return cb(Object.assign(new Error('Unsupported type. Allowed: mp4, webm, mov, mkv, m3u8, png, jpg, webp, gif, heic, avif.'), { code: 'BAD_MIME' }));
    }
    cb(null, true);
  },
});

function detectTypeFromMime(m) {
  if ((m || '').startsWith('image/')) return 'image';
  if ((m || '').includes('mpegurl')) return 'hls';
  return 'video';
}

/**
 * Express middleware wrapping multer's single-file "file" upload with normalized
 * errors so callers can translate to their own error envelope.
 * On failure sets req.uploadError = { code, status, message } and still calls next().
 */
function uploadSingle(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'BAD_MIME') { req.uploadError = { code: 'BAD_MIME', status: 400, message: err.message }; return next(); }
    if (err.code === 'LIMIT_FILE_SIZE') { req.uploadError = { code: 'FILE_TOO_LARGE', status: 413, message: `File exceeds ${cfg.maxUploadMb} MB limit.` }; return next(); }
    req.uploadError = { code: 'UPLOAD_FAILED', status: 400, message: err.message || 'Upload failed' };
    next();
  });
}

/** Resolve a stored ad row to a playable URL (CDN direct, or presigned). */
async function resolveAdUrl(ad) {
  if (!ad.is_upload) return ad.source;
  if (process.env.R2_PUBLIC_URL) {
    return `${process.env.R2_PUBLIC_URL.replace(/\/+$/, '')}/${ad.source}`;
  }
  const command = new GetObjectCommand({ Bucket: bucketName, Key: ad.source });
  return getSignedUrl(s3, command, { expiresIn: 43200 });
}

/** Resolve to { url, type } — the shape the website's signed-url endpoint returns. */
async function resolvePlayableUrl(ad) {
  const url = await resolveAdUrl(ad);
  return { url, type: ad.type };
}

async function deleteObject(key) {
  return s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }));
}

module.exports = { s3, bucketName, upload, uploadSingle, detectTypeFromMime, resolveAdUrl, resolvePlayableUrl, deleteObject };

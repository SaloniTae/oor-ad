require('dotenv').config();
const path = require('path');

function n(v, d) { const x = Number(v); return Number.isFinite(x) ? x : d; }

const cfg = {
  env:        process.env.NODE_ENV || 'production',
  port:       n(process.env.PORT, 7860),
  publicUrl:  process.env.PUBLIC_URL || `http://localhost:${n(process.env.PORT, 7860)}`,
  dataDir:    path.resolve(process.env.DATA_DIR || './data'),
  dbFile:     path.resolve(process.env.DB_FILE || './data/app.db'),
  uploadDir:  path.resolve(process.env.UPLOAD_DIR || './data/uploads'),
  maxUploadMb: n(process.env.MAX_UPLOAD_MB, 200),
  jwtSecret:  process.env.JWT_SECRET || '',
  bootstrapEmail:    process.env.BOOTSTRAP_ADMIN_EMAIL || '',
  bootstrapPassword: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
  rateLimitRpm: n(process.env.RATE_LIMIT_RPM, 120),
  adminCors:  (process.env.ADMIN_CORS || '').split(',').map(s => s.trim()).filter(Boolean),
  redisUrl:   process.env.REDIS_URL || '',
  logLevel:   process.env.LOG_LEVEL || 'info',
  // Iframe embed control. Comma-separated list of origins allowed to embed
  // the /player. Special values:
  //   ""  or unset -> allow all origins (dev-friendly, use in local testing)
  //   "*"          -> allow all origins (explicit)
  //   "self"       -> same-origin only (production default when you don't
  //                   embed anywhere)
  //   "https://foo.com,https://bar.com" -> only these origins can iframe.
  iframeOrigins: (process.env.IFRAME_ALLOW_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
};

if (!cfg.jwtSecret || cfg.jwtSecret.length < 32) {
  console.error('FATAL: JWT_SECRET must be set to a 32+ char random string.');
  process.exit(1);
}

module.exports = cfg;

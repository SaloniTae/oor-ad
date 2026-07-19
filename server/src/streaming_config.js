/**
 * Central config for the streaming-security layer. All secrets are env-only.
 * We validate at import time so a misconfigured deploy fails LOUD, not silent.
 */
const cfg = require('./config');

const streamingCfg = {
  hmacSecret:        process.env.HMAC_SIGNING_SECRET || '',
  bunnySecurityKey:  process.env.BUNNY_SECURITY_KEY  || '',
  nginxSecret:       process.env.NGINX_SECURE_LINK_SECRET || '',
  authorizeRpm:      Number(process.env.STREAM_AUTHORIZE_RPM) || 10,   // 10 / 5min per spec
  authorizeWindowMs: 5 * 60 * 1000,
  segmentTtlSec:     Number(process.env.STREAM_SEGMENT_TTL_SEC) || 60,
  mp4TtlSec:         Number(process.env.STREAM_MP4_TTL_SEC)     || 300,
  refreshWindowSec:  Number(process.env.STREAM_REFRESH_WINDOW_SEC) || 30,
};

// Length gate — matches spec ("proper validation"). We do NOT require Bunny
// or nginx secrets at boot because some deployments won't use them; we DO
// require the HMAC secret because it's the universal fallback.
if (!streamingCfg.hmacSecret || streamingCfg.hmacSecret.length < 32) {
  console.error('FATAL: HMAC_SIGNING_SECRET must be set to a 32+ char random string.');
  process.exit(1);
}

module.exports = streamingCfg;

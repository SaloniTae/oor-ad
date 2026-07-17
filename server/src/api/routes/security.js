/**
 * /api/v1/security — revocation log, per-channel origin config, and edge-config
 * snippets (mirrors the website's Streaming Security "Revocation Log", "Origins",
 * and "Edge Config" tabs). x-api-key secured.
 */
const express = require('express');
const mw = require('../middleware');
const db = require('../../db');
const auth = require('../../auth');
const pins = require('../../pins');
const scfg = require('../../streaming_config');
const { ApiError, z, validate, requireApiKey, requireScope, rateLimit, logUsage, clientIp } = mw;

const router = express.Router();
router.use(requireApiKey, rateLimit, logUsage);

const ownsChannel = (id, tenantId) => db.prepare('SELECT 1 FROM channels WHERE id = ? AND tenant_id = ?').get(id, tenantId);

// ---- revocation log (kick/expiry history) ---------------------------------
router.get('/revocations', requireScope('sessions:read'), (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const items = pins.recentRevocations(req.tenant.id, limit).map((r) => ({
    id: r.id, pin: r.pin, session_id: r.session_id, device_label: r.device_label,
    ip: r.ip, reason: r.reason, actor: r.actor, created_at: r.created_at,
  }));
  res.json({ items, request_id: req.request_id });
});

// ---- per-channel origin config --------------------------------------------
router.get('/channels/:channelId/origin', requireScope('channels:read'), (req, res, next) => {
  if (!ownsChannel(req.params.channelId, req.tenant.id)) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'channelId'));
  const o = pins.originFor(req.params.channelId);
  res.json({ channel_id: o.channel_id, origin_type: o.origin_type, origin_base: o.origin_base, updated_at: o.updated_at || null, request_id: req.request_id });
});

const originSchema = z.object({
  origin_type: z.enum(['bunny', 'nginx', 'direct']),
  origin_base: z.string().url().optional().nullable(),
});
router.put('/channels/:channelId/origin', requireScope('channels:write'), validate(originSchema), (req, res, next) => {
  if (!ownsChannel(req.params.channelId, req.tenant.id)) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'channelId'));
  const row = pins.setOrigin(req.params.channelId, req.body.origin_type, req.body.origin_base || null);
  auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'channel.origin.update', resource: `channel:${req.params.channelId}`, metadata: row, ip: clientIp(req) });
  res.json({ channel_id: row.channel_id, origin_type: row.origin_type, origin_base: row.origin_base, updated_at: row.updated_at, request_id: req.request_id });
});

// ---- edge-config snippets (documentation; secrets shown as ${ENV} placeholders) ---
router.get('/edge-config', requireScope('channels:read'), (req, res) => {
  res.json({
    env_requirements: [
      { name: 'HMAC_SIGNING_SECRET', required: true, purpose: 'Universal HMAC (app-proxied manifests)' },
      { name: 'BUNNY_SECURITY_KEY', required: false, purpose: 'Only when a channel is origin_type=bunny' },
      { name: 'NGINX_SECURE_LINK_SECRET', required: false, purpose: 'Only when a channel is origin_type=nginx' },
      { name: 'REDIS_URL', required: true, purpose: 'Session registry + cluster pub/sub' },
    ],
    ttl_seconds: {
      segment: scfg.segmentTtlSec,
      mp4: scfg.mp4TtlSec,
      refresh_window: scfg.refreshWindowSec,
    },
    request_id: req.request_id,
  });
});

module.exports = router;

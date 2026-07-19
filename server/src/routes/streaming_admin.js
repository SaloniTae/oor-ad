/**
 * /v1/admin/streaming/* — tenant-authenticated endpoints for the UI.
 *
 * All endpoints require a tenant session OR api key (requireAuth).
 * They only ever touch data scoped to req.tenant.id.
 */
const express = require('express');
const { z }   = require('zod');
const auth    = require('../auth');
const db      = require('../db');
const registry = require('../session_registry');
const pins    = require('../pins');
const scfg    = require('../streaming_config');
const { requireAuth, validate, HttpError } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

// ---- PINs -----------------------------------------------------------------

router.get('/pins', (req, res) => {
  const rows = pins.tenantPins(req.tenant.id).map((r) => ({
    pin: r.pin,
    label: r.label,
    channelId: r.channel_id,
    maxDevices: r.max_devices,
    disabled: !!r.disabled,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }));
  res.json({ items: rows });
});

const createPinSchema = z.object({
  channelId:   z.string().optional().nullable(),
  channelSlug: z.string().optional().nullable(),
  label:       z.string().max(80).optional().nullable(),
  maxDevices:  z.number().int().min(1).max(100).default(1),
  ttlSeconds:  z.number().int().min(60).max(60 * 60 * 24 * 30).optional().nullable(),
  length:      z.number().int().min(6).max(8).default(6),
});

router.post('/pins', validate(createPinSchema), (req, res, next) => {
  try {
    let channelId = req.body.channelId || null;
    if (!channelId && req.body.channelSlug) {
      const c = db.prepare('SELECT id FROM channels WHERE tenant_id = ? AND slug = ?').get(req.tenant.id, req.body.channelSlug);
      if (!c) return next(new HttpError(404, 'channel_not_found', 'channel not found'));
      channelId = c.id;
    }
    if (channelId) {
      const owns = db.prepare('SELECT 1 FROM channels WHERE id = ? AND tenant_id = ?').get(channelId, req.tenant.id);
      if (!owns) return next(new HttpError(403, 'not_your_channel', 'not your channel'));
    }
    const row = pins.createPin({
      tenantId: req.tenant.id,
      channelId,
      label: req.body.label || null,
      maxDevices: req.body.maxDevices,
      ttlSeconds: req.body.ttlSeconds || null,
      length: req.body.length,
    });
    auth.audit({ tenantId: req.tenant.id, actor: `tenant:${req.tenant.id}`,
                 action: 'pin.create', resource: `pin:${row.pin}` });
    registry.setMaxDevices(row.pin, row.max_devices).catch(() => {});
    res.status(201).json({ pin: row.pin, maxDevices: row.max_devices, expiresAt: row.expires_at, label: row.label });
  } catch (e) { next(e); }
});

const patchLimitSchema = z.object({ maxDevices: z.number().int().min(1).max(100) });

router.patch('/pins/:pin/device-limit', validate(patchLimitSchema), async (req, res, next) => {
  try {
    const pinRow = pins.findPin(req.params.pin);
    if (!pinRow || pinRow.tenant_id !== req.tenant.id) return next(new HttpError(404, 'pin_not_found', 'PIN not found'));
    pins.updatePinMax(req.tenant.id, req.params.pin, req.body.maxDevices);
    const applied = await registry.setMaxDevices(req.params.pin, req.body.maxDevices);
    auth.audit({ tenantId: req.tenant.id, actor: `tenant:${req.tenant.id}`,
                 action: 'pin.device_limit.update',
                 resource: `pin:${req.params.pin}`, metadata: { maxDevices: applied } });
    res.json({ status: 'ok', maxDevices: applied });
  } catch (e) { next(e); }
});

router.delete('/pins/:pin', (req, res, next) => {
  const pinRow = pins.findPin(req.params.pin);
  if (!pinRow || pinRow.tenant_id !== req.tenant.id) return next(new HttpError(404, 'pin_not_found', 'PIN not found'));
  pins.disablePin(req.tenant.id, req.params.pin, 1);
  auth.audit({ tenantId: req.tenant.id, actor: `tenant:${req.tenant.id}`,
               action: 'pin.disable', resource: `pin:${req.params.pin}` });
  res.json({ status: 'ok' });
});

// ---- Sessions --------------------------------------------------------------

router.get('/pins/:pin/sessions', async (req, res, next) => {
  try {
    const pinRow = pins.findPin(req.params.pin);
    if (!pinRow || pinRow.tenant_id !== req.tenant.id) return next(new HttpError(404, 'pin_not_found', 'PIN not found'));
    const list = await registry.listSessions(req.params.pin);
    res.json({ items: list });
  } catch (e) { next(e); }
});

router.post('/pins/:pin/sessions/:sessionId/kick', async (req, res, next) => {
  try {
    const pinRow = pins.findPin(req.params.pin);
    if (!pinRow || pinRow.tenant_id !== req.tenant.id) return next(new HttpError(404, 'pin_not_found', 'PIN not found'));
    const list = await registry.listSessions(req.params.pin);
    const target = list.find((s) => s.sessionId === req.params.sessionId);
    await registry.kick(req.params.pin, req.params.sessionId, 'kicked_by_owner');
    pins.logRevocation({
      tenantId: req.tenant.id, pin: req.params.pin, sessionId: req.params.sessionId,
      deviceLabel: target?.deviceLabel, ip: target?.ip,
      reason: 'kicked_by_owner', actor: `tenant:${req.tenant.id}`,
    });
    auth.audit({ tenantId: req.tenant.id, actor: `tenant:${req.tenant.id}`,
                 action: 'session.kick',
                 resource: `session:${req.params.sessionId}`, metadata: { pin: req.params.pin } });
    res.json({ status: 'ok' });
  } catch (e) { next(e); }
});

// ---- Revocation log --------------------------------------------------------

router.get('/revocations', (req, res) => {
  const limit = Number(req.query.limit) || 100;
  res.json({ items: pins.recentRevocations(req.tenant.id, limit) });
});

// ---- Per-channel origin config --------------------------------------------

const originSchema = z.object({
  originType: z.enum(['bunny', 'nginx', 'direct']),
  originBase: z.string().url().optional().nullable(),
});
router.get('/channels/:channelId/origin', (req, res, next) => {
  const owns = db.prepare('SELECT 1 FROM channels WHERE id = ? AND tenant_id = ?').get(req.params.channelId, req.tenant.id);
  if (!owns) return next(new HttpError(404, 'channel_not_found', 'channel not found'));
  res.json(pins.originFor(req.params.channelId));
});
router.put('/channels/:channelId/origin', validate(originSchema), (req, res, next) => {
  const owns = db.prepare('SELECT 1 FROM channels WHERE id = ? AND tenant_id = ?').get(req.params.channelId, req.tenant.id);
  if (!owns) return next(new HttpError(404, 'channel_not_found', 'channel not found'));
  const row = pins.setOrigin(req.params.channelId, req.body.originType, req.body.originBase || null);
  auth.audit({ tenantId: req.tenant.id, actor: `tenant:${req.tenant.id}`,
               action: 'channel.origin.update',
               resource: `channel:${req.params.channelId}`, metadata: row });
  res.json(row);
});

// ---- Edge-config snippet generator ----------------------------------------
// The UI shows these; they're documentation, not secrets. We NEVER echo the
// actual security keys — we render `${ENV_VAR_NAME}` placeholders.

router.get('/edge-config', (_req, res) => {
  const nginxConf = `
# nginx secure_link config — paste into your server block.
# Rotate NGINX_SECURE_LINK_SECRET regularly.
location /videos/ {
    secure_link $arg_sig,$arg_exp;
    secure_link_md5 "$secure_link_expires$uri \${NGINX_SECURE_LINK_SECRET}";
    if ($secure_link = "")  { return 403; }   # bad hash / tampered
    if ($secure_link = "0") { return 410; }   # expired
    # Referer-lock is a coarse spoofable filter, NOT the real gate.
    # secure_link above is the real gate; keep it primary.
    valid_referers none blocked ${'youroordomain.com'} *.${'youroordomain.com'};
    if ($invalid_referer) { return 403; }
    root /var/www;
}
`.trim();

  const bunnyDocs = `
# Bunny.net Pull Zone — Token Authentication
# 1) Enable in Pull Zone > Security > Token Authentication.
# 2) Copy the Zone security key into your server env:
#      BUNNY_SECURITY_KEY=<the security key>
# 3) The server will emit:
#      https://<zone>/path?token=<b64u(sha256(key + path + expiry))>&expires=<epoch>
# 4) Recommend Path Restriction OFF (we sign the full path), IP restriction OFF
#    (viewers change IPs on mobile), and countries restriction ON if desired.
`.trim();

  res.json({
    nginxSecureLink: nginxConf,
    bunnyTokenAuth:  bunnyDocs,
    envRequirements: [
      { name: 'HMAC_SIGNING_SECRET',        required: true,  purpose: 'Universal HMAC (app-proxied manifests)' },
      { name: 'BUNNY_SECURITY_KEY',         required: false, purpose: 'Only when a channel is origin_type=bunny' },
      { name: 'NGINX_SECURE_LINK_SECRET',   required: false, purpose: 'Only when a channel is origin_type=nginx' },
      { name: 'REDIS_URL',                  required: true,  purpose: 'Session registry + cluster pub/sub' },
    ],
    ttlSeconds: {
      segment:       scfg.segmentTtlSec,
      mp4:           scfg.mp4TtlSec,
      refreshWindow: scfg.refreshWindowSec,
    },
  });
});

module.exports = router;

/**
 * /api/v1/pins — PIN identity, sessions, revocations, and per-channel origin
 * config (mirrors the website's Streaming Security screen + channel Security card).
 *
 * A PIN is the viewer identity for the secured playback flow: it binds to a
 * channel, carries a device limit, and is the target of session enforcement.
 * These endpoints let a third party build the exact "PINs / Active Sessions /
 * Revocation Log / Origins" UI the website has — over x-api-key.
 *
 * Related: /api/v1/playback/generate mints a PIN + returns a player URL in one
 * call; these endpoints are the granular management surface behind that.
 */
const express = require('express');
const mw = require('../middleware');
const db = require('../../db');
const auth = require('../../auth');
const pins = require('../../pins');
const registry = require('../../session_registry');
const scfg = require('../../streaming_config');
const { ApiError, z, validate, requireApiKey, requireScope, rateLimit, logUsage, clientIp } = mw;

const router = express.Router();
router.use(requireApiKey, rateLimit, logUsage);

const ownsChannel = (id, tenantId) => db.prepare('SELECT * FROM channels WHERE id = ? AND tenant_id = ?').get(id, tenantId);
const channelBySlug = (slug, tenantId) => db.prepare('SELECT * FROM channels WHERE tenant_id = ? AND slug = ?').get(tenantId, slug);

function publicPin(r) {
  return {
    pin: r.pin,
    label: r.label,
    channel_id: r.channel_id,
    max_devices: r.max_devices,
    disabled: !!r.disabled,
    expires_at: r.expires_at,
    created_at: r.created_at,
  };
}
function publicSession(s, pin) {
  return {
    session_id: s.sessionId,
    pin,
    device_id: s.deviceId,
    device_label: s.deviceLabel,
    ip: s.ip,
    connected_at: s.connectedAt,
    last_heartbeat: s.lastHeartbeat,
  };
}
function ownPin(req, _res, next) {
  const row = pins.findPin(req.params.pin);
  if (!row || row.tenant_id !== req.tenant.id) return next(new ApiError(404, 'PIN_NOT_FOUND', 'PIN not found for this account.', 'pin'));
  req.pinRow = row;
  next();
}

// ---- list PINs (optionally filtered by channel) ---------------------------
router.get('/', requireScope('sessions:read'), (req, res, next) => {
  const channelId = req.query.channel_id;
  if (channelId && !ownsChannel(channelId, req.tenant.id)) {
    return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'channel_id'));
  }
  let rows = pins.tenantPins(req.tenant.id);
  if (channelId) rows = rows.filter((r) => r.channel_id === channelId);
  res.json({ items: rows.map(publicPin), request_id: req.request_id });
});

// ---- create a PIN ---------------------------------------------------------
const createSchema = z.object({
  channel_id: z.string().optional().nullable(),
  channel_slug: z.string().optional().nullable(),
  label: z.string().max(80).optional().nullable(),
  max_devices: z.number().int().min(1).max(100).default(1),
  ttl_seconds: z.number().int().min(60).max(60 * 60 * 24 * 30).optional().nullable(),
  length: z.number().int().min(6).max(8).default(6),
});
router.post('/', requireScope('sessions:write'), validate(createSchema), async (req, res, next) => {
  try {
    let channelId = req.body.channel_id || null;
    if (!channelId && req.body.channel_slug) {
      const c = channelBySlug(req.body.channel_slug, req.tenant.id);
      if (!c) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel for that slug.', 'channel_slug'));
      channelId = c.id;
    }
    if (channelId && !ownsChannel(channelId, req.tenant.id)) {
      return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'channel_id'));
    }
    const row = pins.createPin({
      tenantId: req.tenant.id, channelId,
      label: req.body.label || null,
      maxDevices: req.body.max_devices,
      ttlSeconds: req.body.ttl_seconds || null,
      length: req.body.length,
    });
    await registry.setMaxDevices(row.pin, row.max_devices).catch(() => {});
    auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'pin.create', resource: `pin:${row.pin}`, ip: clientIp(req) });
    res.status(201).json({ ...publicPin(row), request_id: req.request_id });
  } catch (e) { next(e); }
});

// ---- update device limit --------------------------------------------------
const limitSchema = z.object({ max_devices: z.number().int().min(1).max(100) });
router.patch('/:pin/device-limit', requireScope('sessions:write'), ownPin, validate(limitSchema), async (req, res, next) => {
  try {
    pins.updatePinMax(req.tenant.id, req.params.pin, req.body.max_devices);
    const applied = await registry.setMaxDevices(req.params.pin, req.body.max_devices);
    auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'pin.device_limit', resource: `pin:${req.params.pin}`, metadata: { max_devices: applied }, ip: clientIp(req) });
    res.json({ pin: req.params.pin, max_devices: applied, request_id: req.request_id });
  } catch (e) { next(e); }
});

// ---- disable (revoke) a PIN -----------------------------------------------
router.delete('/:pin', requireScope('sessions:write'), ownPin, (req, res) => {
  pins.disablePin(req.tenant.id, req.params.pin, 1);
  auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'pin.disable', resource: `pin:${req.params.pin}`, ip: clientIp(req) });
  res.json({ pin: req.params.pin, disabled: true, request_id: req.request_id });
});

// ---- list active sessions for a PIN ---------------------------------------
router.get('/:pin/sessions', requireScope('sessions:read'), ownPin, async (req, res, next) => {
  try {
    const list = await registry.listSessions(req.params.pin);
    res.json({ pin: req.params.pin, device_count: list.length, sessions: list.map((s) => publicSession(s, req.params.pin)), request_id: req.request_id });
  } catch (e) { next(e); }
});

// ---- kick a session under a PIN -------------------------------------------
router.post('/:pin/sessions/:sessionId/kick', requireScope('sessions:write'), ownPin, async (req, res, next) => {
  try {
    const list = await registry.listSessions(req.params.pin);
    const target = list.find((s) => s.sessionId === req.params.sessionId);
    if (!target) return next(new ApiError(404, 'SESSION_NOT_FOUND', 'No such active session.', 'session_id'));
    await registry.kick(req.params.pin, req.params.sessionId, 'kicked_by_owner');
    pins.logRevocation({
      tenantId: req.tenant.id, pin: req.params.pin, sessionId: req.params.sessionId,
      deviceLabel: target.deviceLabel, ip: target.ip, reason: 'kicked_by_owner', actor: 'api',
    });
    auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'session.kick', resource: `session:${req.params.sessionId}`, metadata: { pin: req.params.pin }, ip: clientIp(req) });
    res.json({ pin: req.params.pin, session_id: req.params.sessionId, kicked: true, request_id: req.request_id });
  } catch (e) { next(e); }
});

module.exports = router;

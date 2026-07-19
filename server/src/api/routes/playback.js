/**
 * /api/v1/playback — Playback URL / session API (Section 3).
 *
 * Ties the API-first surface into the existing PIN + Redis session registry +
 * signed-URL machinery so third parties can generate protected playback URLs
 * and manage live sessions without the website.
 *
 * generate:  mint (or reuse) a channel-scoped PIN with a device limit, and
 *            return a portable player URL + a short-lived signed playback token
 *            that any player can hand to /v1/stream/manifest.
 * payload:   toggle the protected wrapper (PIN/device-limit/signing) on a
 *            channel on/off, returning the updated URL.
 * sessions:  list active sessions for a channel; revoke/kick one (Redis pub/sub).
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const mw = require('../middleware');
const db = require('../../db');
const cfg = require('../../config');
const auth = require('../../auth');
const pins = require('../../pins');
const registry = require('../../session_registry');
const { ApiError, z, validate, requireApiKey, requireScope, rateLimit, logUsage, clientIp } = mw;

const router = express.Router();
router.use(requireApiKey, rateLimit, logUsage);

function channelOwned(id, tenantId) {
  return db.prepare('SELECT * FROM channels WHERE id = ? AND tenant_id = ?').get(id, tenantId);
}
function parseSettings(row) { try { return JSON.parse(row.settings || '{}'); } catch { return {}; } }

// Build the portable player URL for a channel + viewer token. When `secured`
// we add secure=1&ch=<slug> so the player engages the PIN/device-limit gate.
function playerUrl(channel, viewerToken, secured) {
  const wsUrl = `${cfg.publicUrl.replace(/^http/, 'ws')}/ws?channel=${channel.slug}&token=${encodeURIComponent(viewerToken)}`;
  let url = `${cfg.publicUrl}/player/?ws=${encodeURIComponent(wsUrl)}`;
  if (secured) url += `&secure=1&ch=${encodeURIComponent(channel.slug)}`;
  return { url, ws_url: wsUrl };
}

// ---- generate signed pin-based playback URL -------------------------------
const generateSchema = z.object({
  channel_id: z.string().min(1),
  pin: z.string().regex(/^[0-9]{6,8}$/).optional(),   // reuse an existing PIN, else mint one
  expiry_seconds: z.number().int().min(60).max(60 * 60 * 24 * 30).default(3600),
  device_limit: z.number().int().min(1).max(100).default(1),
  label: z.string().max(80).optional(),
});
router.post('/generate', requireScope('playback:write'), validate(generateSchema), async (req, res, next) => {
  try {
    const channel = channelOwned(req.body.channel_id, req.tenant.id);
    if (!channel) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'channel_id'));

    // Reuse a provided PIN (must belong to this tenant + channel), else mint one.
    let pinRow;
    if (req.body.pin) {
      pinRow = pins.findPin(req.body.pin);
      if (!pinRow || pinRow.tenant_id !== req.tenant.id) {
        return next(new ApiError(404, 'PIN_NOT_FOUND', 'PIN not found for this account.', 'pin'));
      }
      if (pinRow.channel_id && pinRow.channel_id !== channel.id) {
        return next(new ApiError(409, 'PIN_CHANNEL_MISMATCH', 'PIN is bound to a different channel.', 'pin'));
      }
      pins.updatePinMax(req.tenant.id, pinRow.pin, req.body.device_limit);
    } else {
      pinRow = pins.createPin({
        tenantId: req.tenant.id, channelId: channel.id,
        label: req.body.label || null, maxDevices: req.body.device_limit,
        ttlSeconds: req.body.expiry_seconds, length: 6,
      });
    }
    // Keep Redis device-limit in sync so enforcement is immediate + cluster-wide.
    await registry.setMaxDevices(pinRow.pin, req.body.device_limit).catch(() => {});

    // Ensure the channel is marked secured so the player engages the gate.
    const s = parseSettings(channel);
    if (!s.requirePin) {
      s.requirePin = true;
      db.prepare('UPDATE channels SET settings = ? WHERE id = ?').run(JSON.stringify(s), channel.id);
    }

    const viewerToken = auth.signViewerToken(req.tenant.id, channel.id, auth.id(8), req.body.expiry_seconds);
    const { url, ws_url } = playerUrl(channel, viewerToken, true);
    // A signed playback token integrators can also verify/relay if they build
    // fully custom clients (carries channel + pin + limits + expiry).
    const playbackToken = jwt.sign(
      { typ: 'playback', tid: req.tenant.id, cid: channel.id, pin: pinRow.pin, device_limit: req.body.device_limit },
      cfg.jwtSecret, { expiresIn: req.body.expiry_seconds });
    const expiresAt = Date.now() + req.body.expiry_seconds * 1000;

    auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'playback.generate',
      resource: `channel:${channel.id}`, metadata: { pin: pinRow.pin, device_limit: req.body.device_limit }, ip: clientIp(req) });

    res.status(201).json({
      playback_url: url,
      ws_url,
      token: playbackToken,
      pin: pinRow.pin,
      channel_id: channel.id,
      device_limit: req.body.device_limit,
      payload_protected: true,
      expires_at: expiresAt,
      // How a third party authorizes a device with this PIN (fully documented):
      authorize_endpoint: '/v1/stream/authorize',
      request_id: req.request_id,
    });
  } catch (e) { next(e); }
});

// ---- toggle payload (protected wrapper) on/off per channel ----------------
const payloadSchema = z.object({
  channel_id: z.string().min(1),
  enabled: z.boolean(),
});
router.post('/payload', requireScope('playback:write'), validate(payloadSchema), async (req, res, next) => {
  try {
    const channel = channelOwned(req.body.channel_id, req.tenant.id);
    if (!channel) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'channel_id'));
    const s = parseSettings(channel);
    s.requirePin = !!req.body.enabled;
    db.prepare('UPDATE channels SET settings = ? WHERE id = ?').run(JSON.stringify(s), channel.id);

    const viewerToken = auth.signViewerToken(req.tenant.id, channel.id, auth.id(8), 3600);
    const { url, ws_url } = playerUrl(channel, viewerToken, s.requirePin);
    auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'playback.payload_toggle',
      resource: `channel:${channel.id}`, metadata: { enabled: s.requirePin }, ip: clientIp(req) });
    res.json({
      channel_id: channel.id,
      payload_protected: s.requirePin,
      playback_url: url,
      ws_url,
      request_id: req.request_id,
    });
  } catch (e) { next(e); }
});

// ---- list active sessions for a channel -----------------------------------
// Sessions live under PINs; we aggregate across all of the channel's PINs.
router.get('/sessions', requireScope('sessions:read'), async (req, res, next) => {
  try {
    const channelId = req.query.channel_id;
    if (!channelId) return next(new ApiError(400, 'VALIDATION_ERROR', 'channel_id query param is required.', 'channel_id'));
    const channel = channelOwned(channelId, req.tenant.id);
    if (!channel) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'channel_id'));

    const tenantPins = pins.tenantPins(req.tenant.id)
      .filter((p) => !p.channel_id || p.channel_id === channel.id);
    const out = [];
    for (const p of tenantPins) {
      const list = await registry.listSessions(p.pin);
      for (const sess of list) {
        out.push({
          session_id: sess.sessionId,
          pin: p.pin,
          device_id: sess.deviceId,
          device_label: sess.deviceLabel,
          ip: sess.ip,
          connected_at: sess.connectedAt,
          last_heartbeat: sess.lastHeartbeat,
        });
      }
    }
    res.json({
      channel_id: channel.id,
      device_count: out.length,
      sessions: out,
      request_id: req.request_id,
    });
  } catch (e) { next(e); }
});

// ---- revoke / kick an active session --------------------------------------
const kickSchema = z.object({
  pin: z.string().regex(/^[0-9]{6,8}$/),
  session_id: z.string().min(8),
  reason: z.string().max(80).optional(),
});
router.post('/sessions/revoke', requireScope('sessions:write'), validate(kickSchema), async (req, res, next) => {
  try {
    const pinRow = pins.findPin(req.body.pin);
    if (!pinRow || pinRow.tenant_id !== req.tenant.id) {
      return next(new ApiError(404, 'PIN_NOT_FOUND', 'PIN not found for this account.', 'pin'));
    }
    const list = await registry.listSessions(req.body.pin);
    const target = list.find((s) => s.sessionId === req.body.session_id);
    if (!target) return next(new ApiError(404, 'SESSION_NOT_FOUND', 'No such active session.', 'session_id'));

    // Fires the Redis session:commands kick — the player's lifecycle WS closes
    // within seconds across all workers.
    await registry.kick(req.body.pin, req.body.session_id, req.body.reason || 'kicked_by_api');
    pins.logRevocation({
      tenantId: req.tenant.id, pin: req.body.pin, sessionId: req.body.session_id,
      deviceLabel: target.deviceLabel, ip: target.ip,
      reason: req.body.reason || 'kicked_by_api', actor: 'api',
    });
    auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'session.revoke',
      resource: `session:${req.body.session_id}`, metadata: { pin: req.body.pin }, ip: clientIp(req) });
    res.json({ revoked: true, session_id: req.body.session_id, request_id: req.request_id });
  } catch (e) { next(e); }
});

module.exports = router;

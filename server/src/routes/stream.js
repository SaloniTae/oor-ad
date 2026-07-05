/**
 * /v1/stream/* — the ask-before-kick device-limit + signed-URL API.
 *
 * Endpoints:
 *   POST /v1/stream/authorize        (public, PIN-authed)
 *   POST /v1/stream/confirm-kick     (public, PIN-authed)
 *   POST /v1/stream/heartbeat        (public, session-token-authed)
 *   POST /v1/stream/refresh-url      (public, session-token-authed)
 *   GET  /v1/stream/manifest         (public, session-token-authed) — HLS proxy
 *
 * Admin endpoints (require session/api-key auth) live in routes/streaming_admin.js.
 */
const express = require('express');
const crypto  = require('crypto');
const { z }   = require('zod');

const db       = require('../db');
const auth     = require('../auth');
const cfg      = require('../config');
const scfg     = require('../streaming_config');
const registry = require('../session_registry');
const pins     = require('../pins');
const sign     = require('../sign');
const manifest = require('../manifest_rewriter');
const rl       = require('../rate_limit_redis');
const { validate, HttpError } = require('../middleware');

const router = express.Router();

// ---- helpers ---------------------------------------------------------------

function clientIp(req) {
  const fwd = req.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || '';
}
function clientUA(req)   { return req.get('user-agent') || ''; }
function requireHttps(req, res, next) {
  if (cfg.env !== 'production') return next();
  if (req.secure || req.get('x-forwarded-proto') === 'https') return next();
  return next(new HttpError(400, 'https_required', 'Signed URLs require HTTPS'));
}
function issueSessionToken(payload, ttlSec) {
  return require('jsonwebtoken').sign(
    { typ: 'stream_session', ...payload },
    cfg.jwtSecret,
    { expiresIn: ttlSec },
  );
}
function verifySessionToken(token) {
  try {
    const p = require('jsonwebtoken').verify(token, cfg.jwtSecret);
    if (p.typ !== 'stream_session') return null;
    return p;
  } catch { return null; }
}
function bearerFromReq(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (req.query.stoken || '');
}

async function requireStreamSession(req, _res, next) {
  const raw = bearerFromReq(req);
  if (!raw) return next(new HttpError(401, 'no_session', 'session token required'));
  const p = verifySessionToken(raw);
  if (!p) return next(new HttpError(401, 'bad_session', 'invalid session token'));
  if (await registry.isRevoked(p.sid)) return next(new HttpError(403, 'session_revoked', 'session revoked'));
  req.stream = p;
  next();
}

async function checkUaBinding(req, streamPayload) {
  const list = await registry.listSessions(streamPayload.pin);
  const sess = list.find((s) => s.sessionId === streamPayload.sid);
  if (!sess) return { ok: false, reason: 'session_gone' };
  const ua = clientUA(req);
  const hash = registry.sha256(ua);
  if (hash !== sess.userAgentHash) {
    await registry.kick(streamPayload.pin, streamPayload.sid, 'ua_change_detected');
    pins.logRevocation({
      tenantId: null, pin: streamPayload.pin, sessionId: streamPayload.sid,
      deviceLabel: sess.deviceLabel, ip: clientIp(req),
      reason: 'ua_change_detected', actor: 'server',
    });
    return { ok: false, reason: 'ua_change_detected' };
  }
  return { ok: true, session: sess };
}

const authorizeSchema = z.object({
  pin:         z.string().regex(/^[0-9]{6,8}$/),
  deviceId:    z.string().min(8).max(128),
  channelSlug: z.string().min(1).max(80),
});
const confirmKickSchema = z.object({
  pin:              z.string().regex(/^[0-9]{6,8}$/),
  sessionIdToKick:  z.string().min(8).max(128),
  deviceId:         z.string().min(8).max(128),
  channelSlug:      z.string().min(1).max(80),
});

router.post('/authorize', requireHttps, validate(authorizeSchema), async (req, res, next) => {
  try {
    const { pin, deviceId, channelSlug } = req.body;
    const bucket = await rl.bump(`authorize:${pin}`, scfg.authorizeRpm, scfg.authorizeWindowMs);
    if (!bucket.allowed) {
      req.log?.warn({ pin, ip: clientIp(req) }, 'stream.authorize.rate_limited');
      return next(new HttpError(429, 'rate_limited', 'too many authorize attempts', { resetInMs: bucket.resetInMs }));
    }
    const pinRow = pins.findPin(pin);
    if (!pinRow) return next(new HttpError(401, 'invalid_pin', 'PIN not recognised'));
    const channel = db.prepare(
      'SELECT c.* FROM channels c JOIN tenants t ON t.id = c.tenant_id WHERE c.slug = ? AND t.id = ? AND t.disabled = 0'
    ).get(channelSlug, pinRow.tenant_id);
    if (!channel) return next(new HttpError(404, 'channel_not_found', 'channel not found'));
    if (pinRow.channel_id && pinRow.channel_id !== channel.id) {
      return next(new HttpError(403, 'pin_channel_mismatch', 'PIN not valid for this channel'));
    }
    const maxDevices = await registry.getMaxDevices(pin) || pinRow.max_devices || 1;
    const list = await registry.listSessions(pin);
    const existing = list.find((s) => s.deviceId === deviceId);
    if (existing) {
      await registry.refreshSession(pin, existing.sessionId, { ip: clientIp(req) });
      const stoken = issueSessionToken(
        { pin, sid: existing.sessionId, channelId: channel.id, deviceId },
        Math.max(120, Math.floor(registry.HEARTBEAT_TTL_MS / 1000)),
      );
      return res.json({ status: 'ok', reused: true, sessionId: existing.sessionId, streamToken: stoken, heartbeatSec: Math.floor(registry.HEARTBEAT_TTL_MS / 1000 / 2) });
    }
    if (list.length >= maxDevices) {
      return res.status(409).json({
        error: 'device_limit_reached',
        maxDevices,
        activeSessions: list.map((s) => ({ sessionId: s.sessionId, deviceLabel: s.deviceLabel, connectedAt: s.connectedAt, ip: s.ip })),
      });
    }
    const sess = await registry.createSession(pin, { deviceId, ip: clientIp(req), userAgent: clientUA(req) });
    const stoken = issueSessionToken(
      { pin, sid: sess.sessionId, channelId: channel.id, deviceId },
      Math.max(120, Math.floor(registry.HEARTBEAT_TTL_MS / 1000)),
    );
    req.log?.info({ pin, sid: sess.sessionId, deviceId, ip: clientIp(req) }, 'stream.authorize.granted');
    return res.json({ status: 'ok', reused: false, sessionId: sess.sessionId, streamToken: stoken, heartbeatSec: Math.floor(registry.HEARTBEAT_TTL_MS / 1000 / 2) });
  } catch (e) { next(e); }
});

router.post('/confirm-kick', requireHttps, validate(confirmKickSchema), async (req, res, next) => {
  try {
    const { pin, sessionIdToKick, deviceId, channelSlug } = req.body;
    const bucket = await rl.bump(`authorize:${pin}`, scfg.authorizeRpm, scfg.authorizeWindowMs);
    if (!bucket.allowed) return next(new HttpError(429, 'rate_limited', 'too many attempts'));
    const pinRow = pins.findPin(pin);
    if (!pinRow) return next(new HttpError(401, 'invalid_pin', 'PIN not recognised'));
    const mapped = await registry.pinForSession(sessionIdToKick);
    if (mapped !== pin) return next(new HttpError(403, 'not_your_session', 'session does not belong to this PIN'));
    const channel = db.prepare(
      'SELECT c.* FROM channels c JOIN tenants t ON t.id = c.tenant_id WHERE c.slug = ? AND t.id = ? AND t.disabled = 0'
    ).get(channelSlug, pinRow.tenant_id);
    if (!channel) return next(new HttpError(404, 'channel_not_found', 'channel not found'));
    const list = await registry.listSessions(pin);
    const target = list.find((s) => s.sessionId === sessionIdToKick);
    await registry.kick(pin, sessionIdToKick, 'kicked_by_user');
    pins.logRevocation({ tenantId: pinRow.tenant_id, pin, sessionId: sessionIdToKick, deviceLabel: target?.deviceLabel, ip: target?.ip, reason: 'kicked_by_user', actor: `pin:${pin}` });
    const sess = await registry.createSession(pin, { deviceId, ip: clientIp(req), userAgent: clientUA(req) });
    const stoken = issueSessionToken(
      { pin, sid: sess.sessionId, channelId: channel.id, deviceId },
      Math.max(120, Math.floor(registry.HEARTBEAT_TTL_MS / 1000)),
    );
    req.log?.info({ pin, kicked: sessionIdToKick, newSid: sess.sessionId }, 'stream.confirm_kick');
    return res.json({ status: 'ok', sessionId: sess.sessionId, streamToken: stoken, heartbeatSec: Math.floor(registry.HEARTBEAT_TTL_MS / 1000 / 2) });
  } catch (e) { next(e); }
});

router.post('/heartbeat', requireHttps, requireStreamSession, async (req, res, next) => {
  try {
    const ua = await checkUaBinding(req, req.stream);
    if (!ua.ok) return next(new HttpError(403, 'session_terminated', ua.reason));
    await registry.refreshSession(req.stream.pin, req.stream.sid, { ip: clientIp(req) });
    return res.json({ status: 'ok' });
  } catch (e) { next(e); }
});

router.post('/refresh-url', requireHttps, requireStreamSession, async (req, res, next) => {
  try {
    const ua = await checkUaBinding(req, req.stream);
    if (!ua.ok) return next(new HttpError(403, 'session_terminated', ua.reason));
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.stream.channelId);
    if (!channel) return next(new HttpError(404, 'channel_not_found', 'channel gone'));
    const origin = pins.originFor(channel.id);
    const url = origin.origin_base || channel.live_url;
    if (!url) return next(new HttpError(500, 'no_origin', 'no origin configured'));
    const signedUrl = sign.signForOrigin(origin.origin_type, url, req.stream.sid, {
      hmacSecret: scfg.hmacSecret,
      bunnySecurityKey: scfg.bunnySecurityKey,
      nginxSecret: scfg.nginxSecret,
      ttlSeconds: scfg.mp4TtlSec,
    });
    return res.json({ status: 'ok', signedUrl, ttlSec: scfg.mp4TtlSec, refreshInSec: Math.max(30, Math.floor(scfg.mp4TtlSec - scfg.refreshWindowSec)) });
  } catch (e) { next(e); }
});

router.get('/manifest', requireHttps, requireStreamSession, async (req, res, next) => {
  try {
    const ua = await checkUaBinding(req, req.stream);
    if (!ua.ok) return next(new HttpError(403, 'session_terminated', ua.reason));
    const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.stream.channelId);
    if (!channel) return next(new HttpError(404, 'channel_not_found', 'channel gone'));
    const origin = pins.originFor(channel.id);
    if (origin.origin_type !== 'direct') {
      const url = origin.origin_base || channel.live_url;
      const signed = sign.signForOrigin(origin.origin_type, url, req.stream.sid, {
        hmacSecret: scfg.hmacSecret,
        bunnySecurityKey: scfg.bunnySecurityKey,
        nginxSecret: scfg.nginxSecret,
        ttlSeconds: scfg.segmentTtlSec,
      });
      return res.redirect(302, signed);
    }
    const upstreamUrl = channel.live_url;
    if (!upstreamUrl) return next(new HttpError(500, 'no_origin', 'no live_url'));
    const upstream = await fetch(upstreamUrl, { redirect: 'follow' });
    if (!upstream.ok) return next(new HttpError(502, 'upstream_error', `upstream ${upstream.status}`));
    const body = await upstream.text();
    const rewritten = manifest.rewriteHlsManifest(
      body, upstream.url || upstreamUrl,
      req.stream.sid, scfg.hmacSecret, scfg.segmentTtlSec,
    );
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(rewritten);
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.requireStreamSession = requireStreamSession;

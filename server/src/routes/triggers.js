const express = require('express');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const cfg = require('../config');
const db = require('../db');
const auth = require('../auth');
const ws = require('../ws');
const hooks = require('../webhooks');
const { HttpError, validate, requireAuth } = require('../middleware');
const { getAd, pubAd } = require('./ads');

const r = express.Router();
r.use(requireAuth);

const getChannel = db.prepare('SELECT * FROM channels WHERE id = ?');
const insertTrigger = db.prepare(`INSERT INTO triggers (id, tenant_id, channel_id, ad_id, duration_seconds, status, start_at, end_at, triggered_by, created_at)
                                  VALUES (?,?,?,?,?,?,?,?,?,?)`);
const setTriggerStatus = db.prepare('UPDATE triggers SET status = ? WHERE id = ?');
const activeTrigger = db.prepare(`SELECT * FROM triggers WHERE channel_id = ? AND status = 'active' ORDER BY start_at DESC LIMIT 1`);

// Track auto-return timers by trigger id so /resume can cancel them.
const timers = new Map();

/**
 * Build a public base URL that will actually resolve for a remote viewer.
 * Priority:
 *   1) cfg.publicUrl if it's set to something other than a localhost default.
 *   2) The Host header from the request (works behind reverse proxies with
 *      `trust proxy` enabled -- we set that in index.js).
 * This fixes image/video ads that use a signed asset URL: with the old code,
 * a misconfigured PUBLIC_URL made viewers try to fetch http://localhost:...
 * which of course fails.
 */
function publicBaseFor(req) {
  const p = cfg.publicUrl || '';
  const isLocalDefault = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(p) || !p;
  if (!isLocalDefault) return p.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host  = (req.headers['x-forwarded-host']  || req.get('host') || '').split(',')[0].trim();
  if (host) return `${proto}://${host}`;
  return p.replace(/\/+$/, '');
}

const TriggerBody = z.object({
  ad_id: z.string().min(1),
  duration_seconds: z.number().int().min(1).max(600).optional(),
  lead_ms: z.number().int().min(0).max(5000).optional(),
});
r.post('/:id/trigger', validate(TriggerBody), (req, res, next) => {
  const channel = getChannel.get(req.params.id);
  if (!channel || channel.tenant_id !== req.tenant.id) return next(new HttpError(404, 'not_found', 'Channel not found'));

  const ad = getAd.get(req.body.ad_id);
  if (!ad || ad.tenant_id !== req.tenant.id) return next(new HttpError(404, 'ad_not_found', 'Ad not found'));

  const duration = req.body.duration_seconds || ad.duration_seconds;
  const lead = req.body.lead_ms ?? 500;
  const startAt = Date.now() + lead;
  const endAt = startAt + duration * 1000;
  const triggerId = auth.id();

  // Resolve the source URL viewers should use.
  let adUrl = ad.source;
  if (ad.is_upload) {
    const token = jwt.sign({ typ: 'asset', ad: ad.id }, cfg.jwtSecret, { expiresIn: 3600 });
    adUrl = `${publicBaseFor(req)}/v1/ads/${ad.id}/asset?token=${token}`;
  }

  const cmd = {
    type: 'command', action: 'play_ad',
    triggerId, adId: ad.id, adType: ad.type,
    adUrl,
    duration,
    startAt,
    metadata: JSON.parse(ad.metadata || '{}'),
    ts: Date.now(),
  };

  insertTrigger.run(triggerId, req.tenant.id, channel.id, ad.id, duration, 'active', startAt, endAt, req.apiKey?.id || 'session', Date.now());
  ws.setState(channel.id, { mode: 'ad', triggerId, adId: ad.id, adType: ad.type, adUrl, duration, startAt, metadata: cmd.metadata });
  const delivered = ws.broadcast(channel.id, cmd);

  // Auto-return timer (server-side authoritative). Also clear the state so
  // late-joining viewers get 'live', not a phantom in-progress ad.
  const t = setTimeout(() => {
    setTriggerStatus.run('completed', triggerId);
    ws.setState(channel.id, { mode: 'live' });
    ws.broadcast(channel.id, { type: 'command', action: 'resume_live', triggerId, ts: Date.now() });
    timers.delete(triggerId);
    hooks.fire(req.tenant, 'ad.completed', { channel_id: channel.id, trigger_id: triggerId, ad_id: ad.id });
  }, duration * 1000 + lead);
  timers.set(triggerId, t);

  auth.audit({ tenantId: req.tenant.id, actor: req.apiKey?.id || 'session', action: 'trigger.create',
               resource: triggerId, metadata: { channel: channel.id, ad: ad.id, duration }, ip: req.ip });
  hooks.fire(req.tenant, 'ad.triggered',
    { channel_id: channel.id, trigger_id: triggerId, ad_id: ad.id, duration, delivered });

  res.status(201).json({ trigger_id: triggerId, delivered, ad: pubAd(ad), command: cmd });
});

r.post('/:id/resume', (req, res, next) => {
  const channel = getChannel.get(req.params.id);
  if (!channel || channel.tenant_id !== req.tenant.id) return next(new HttpError(404, 'not_found', 'Channel not found'));
  const t = activeTrigger.get(channel.id);
  // BUG FIX: only broadcast resume_live if there's actually an active ad.
  // The old code broadcast unconditionally which caused every Resume click
  // to reload the live stream from the beginning – super jarring.
  if (!t) {
    // Ensure server-side state matches reality but don't disturb viewers.
    ws.setState(channel.id, { mode: 'live' });
    return res.json({ ok: true, delivered: 0, canceled_trigger: null, note: 'no active ad' });
  }
  setTriggerStatus.run('canceled', t.id);
  const timer = timers.get(t.id);
  if (timer) { clearTimeout(timer); timers.delete(t.id); }
  ws.setState(channel.id, { mode: 'live' });
  const delivered = ws.broadcast(channel.id, { type: 'command', action: 'resume_live', ts: Date.now(), triggerId: t.id });
  auth.audit({ tenantId: req.tenant.id, actor: req.apiKey?.id || 'session', action: 'trigger.resume',
               resource: channel.id, ip: req.ip });
  hooks.fire(req.tenant, 'ad.resumed', { channel_id: channel.id, trigger_id: t.id, delivered });
  res.json({ ok: true, delivered, canceled_trigger: t.id });
});

r.get('/:id/triggers', (req, res, next) => {
  const channel = getChannel.get(req.params.id);
  if (!channel || channel.tenant_id !== req.tenant.id) return next(new HttpError(404, 'not_found', 'Channel not found'));
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const rows = db.prepare('SELECT * FROM triggers WHERE channel_id = ? ORDER BY start_at DESC LIMIT ?').all(channel.id, limit);
  res.json({ triggers: rows });
});

module.exports = r;

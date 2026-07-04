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
const insertTrigger = db.prepare(`INSERT INTO triggers (id, tenant_id, channel_id, ad_id, duration_seconds, status, start_at, end_at, triggered_by, created_at, pod_data)
                                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const setTriggerStatus = db.prepare('UPDATE triggers SET status = ? WHERE id = ?');
const activeTrigger = db.prepare(`SELECT * FROM triggers WHERE channel_id = ? AND status = 'active' ORDER BY start_at DESC LIMIT 1`);

const timers = new Map();

function publicBaseFor(req) {
  const p = cfg.publicUrl || '';
  const isLocalDefault = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(p) || !p;
  if (!isLocalDefault) return p.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host  = (req.headers['x-forwarded-host']  || req.get('host') || '').split(',')[0].trim();
  if (host) return `${proto}://${host}`;
  return p.replace(/\/+$/, '');
}

// Support both Single Ad (legacy) and Ad Pod arrays
const TriggerBody = z.object({
  ad_id: z.string().optional(),
  duration_seconds: z.number().int().min(1).max(600).optional(),
  pod: z.array(z.object({
    ad_id: z.string(),
    duration_seconds: z.number().int().min(1).optional()
  })).min(1).max(10).optional(),
  lead_ms: z.number().int().min(0).max(5000).optional(),
});

r.post('/:id/trigger', validate(TriggerBody), (req, res, next) => {
  const channel = getChannel.get(req.params.id);
  if (!channel || channel.tenant_id !== req.tenant.id) return next(new HttpError(404, 'not_found', 'Channel not found'));

  // Cancel overlapping triggers
  const existing = activeTrigger.get(channel.id);
  if (existing) {
    setTriggerStatus.run('superseded', existing.id);
    const oldTimer = timers.get(existing.id);
    if (oldTimer) { clearTimeout(oldTimer); timers.delete(existing.id); }
  }

  // Normalize input into a Pod Array
  let requestedPod = req.body.pod || [];
  if (requestedPod.length === 0 && req.body.ad_id) {
    requestedPod = [{ ad_id: req.body.ad_id, duration_seconds: req.body.duration_seconds }];
  }
  if (requestedPod.length === 0) return next(new HttpError(400, 'bad_request', 'Must provide an ad_id or a pod array'));

  const resolvedPod = [];
  let totalAdDuration = 0;

  for (const item of requestedPod) {
    const ad = getAd.get(item.ad_id);
    if (!ad || ad.tenant_id !== req.tenant.id) return next(new HttpError(404, 'ad_not_found', `Ad ${item.ad_id} not found`));
    
    const duration = item.duration_seconds || ad.duration_seconds;
    let adUrl = ad.source;
    
    if (ad.is_upload) {
      const token = jwt.sign({ typ: 'asset', ad: ad.id }, cfg.jwtSecret, { expiresIn: 3600 });
      adUrl = `${publicBaseFor(req)}/v1/ads/${ad.id}/asset?token=${token}`;
    }

    resolvedPod.push({
      adId: ad.id,
      adType: ad.type,
      adUrl: adUrl,
      duration: duration,
      metadata: JSON.parse(ad.metadata || '{}')
    });
    totalAdDuration += duration;
  }

  const BUMPER_DURATION_SEC = 7;
  const lead = req.body.lead_ms ?? 500;
  
  const totalStateDurationMs = (totalAdDuration + BUMPER_DURATION_SEC) * 1000;
  const startAt = Date.now() + lead;
  const endAt = startAt + totalStateDurationMs;
  const triggerId = auth.id();
  const firstAdId = resolvedPod[0].adId; // For legacy DB column

  const cmd = {
    type: 'command', action: 'play_pod',
    triggerId, 
    pod: resolvedPod,
    bumper: BUMPER_DURATION_SEC, 
    startAt,
    ts: Date.now(),
  };

  insertTrigger.run(triggerId, req.tenant.id, channel.id, firstAdId, totalAdDuration, 'active', startAt, endAt, req.apiKey?.id || 'session', Date.now(), JSON.stringify(resolvedPod));
  ws.setState(channel.id, { mode: 'pod', triggerId, pod: resolvedPod, bumper: BUMPER_DURATION_SEC, startAt });
  
  const delivered = ws.broadcast(channel.id, cmd);

  const t = setTimeout(() => {
    const checkState = activeTrigger.get(channel.id);
    if (checkState && checkState.id === triggerId) {
      setTriggerStatus.run('completed', triggerId);
      ws.setState(channel.id, { mode: 'live' });
      ws.broadcast(channel.id, { type: 'command', action: 'resume_live', triggerId, ts: Date.now() });
      hooks.fire(req.tenant, 'ad.completed', { channel_id: channel.id, trigger_id: triggerId });
    }
    timers.delete(triggerId);
  }, totalStateDurationMs + lead);
  
  timers.set(triggerId, t);

  auth.audit({ tenantId: req.tenant.id, actor: req.apiKey?.id || 'session', action: 'trigger.create_pod',
               resource: triggerId, metadata: { channel: channel.id, podLength: resolvedPod.length, totalDuration: totalAdDuration }, ip: req.ip });
  
  res.status(201).json({ trigger_id: triggerId, delivered, command: cmd });
});

r.post('/:id/resume', (req, res, next) => {
  const channel = getChannel.get(req.params.id);
  if (!channel || channel.tenant_id !== req.tenant.id) return next(new HttpError(404, 'not_found', 'Channel not found'));
  
  const t = activeTrigger.get(channel.id);
  if (!t) {
    ws.setState(channel.id, { mode: 'live' });
    return res.json({ ok: true, delivered: 0, canceled_trigger: null, note: 'no active ad' });
  }
  
  setTriggerStatus.run('canceled', t.id);
  const timer = timers.get(t.id);
  if (timer) { clearTimeout(timer); timers.delete(t.id); }
  
  ws.setState(channel.id, { mode: 'live' });
  const delivered = ws.broadcast(channel.id, { type: 'command', action: 'resume_live', ts: Date.now(), triggerId: t.id });
  
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

/**
 * /api/v1/ads — Ad orchestration (Section 4).
 *
 * Register creatives, trigger/cancel ad breaks on a live channel, and expose
 * real-time ad-break state so third-party UIs can render their OWN overlays
 * ("we'll be right back", current ad, pod progress). State is Redis-backed and
 * fanned out over ad:commands, so it is correct across concurrent viewers on
 * any worker. Also POLLABLE here and PUSH-based via the /ws + webhooks.
 */
const express = require('express');
const mw = require('../middleware');
const db = require('../../db');
const auth = require('../../auth');
const adState = require('../../ad_state');
const hooks = require('../../webhooks');
const { ApiError, z, validate, requireApiKey, requireScope, rateLimit, logUsage, clientIp } = mw;

const router = express.Router();
router.use(requireApiKey, rateLimit, logUsage);

const AD_TYPES = ['video', 'hls', 'image'];
const PLACEMENTS = ['pre-roll', 'mid-roll', 'bumper', 'post-roll'];

const getAd = db.prepare('SELECT * FROM ads WHERE id = ?');
const getChannel = db.prepare('SELECT * FROM channels WHERE id = ?');
const insertTrigger = db.prepare(`INSERT INTO triggers (id, tenant_id, channel_id, ad_id, duration_seconds, status, start_at, end_at, triggered_by, created_at, pod_data)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
const setTriggerStatus = db.prepare('UPDATE triggers SET status = ? WHERE id = ?');
const activeTrigger = db.prepare("SELECT * FROM triggers WHERE channel_id = ? AND status = 'active' ORDER BY start_at DESC LIMIT 1");

function channelOwned(id, tenantId) {
  const c = getChannel.get(id);
  return c && c.tenant_id === tenantId ? c : null;
}
function pubAd(a) {
  return { id: a.id, name: a.name, type: a.type, source: a.source,
    duration_seconds: a.duration_seconds, metadata: safeJson(a.metadata),
    created_at: a.created_at };
}
function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }

// ---- register a new ad creative -------------------------------------------
const registerSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.enum(AD_TYPES),
  source_url: z.string().url(),
  duration_seconds: z.number().int().min(1).max(600),
  placement: z.enum(PLACEMENTS).optional(),
  click_url: z.string().url().optional(),
});
router.post('/', requireScope('ads:write'), validate(registerSchema), (req, res) => {
  const id = auth.id();
  const meta = {};
  if (req.body.placement) meta.placement = req.body.placement;
  if (req.body.click_url) meta.click_url = req.body.click_url;
  db.prepare(`INSERT INTO ads (id, tenant_id, name, type, source, is_upload, duration_seconds, metadata, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenant.id, req.body.name, req.body.type, req.body.source_url, 0, req.body.duration_seconds, JSON.stringify(meta), auth.now());
  auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'ad.register', resource: id, ip: clientIp(req) });
  res.status(201).json({ ...pubAd(getAd.get(id)), request_id: req.request_id });
});

// ---- list ad creatives ----------------------------------------------------
router.get('/', requireScope('ads:read'), (req, res) => {
  const rows = db.prepare('SELECT * FROM ads WHERE tenant_id = ? ORDER BY created_at DESC').all(req.tenant.id);
  res.json({ items: rows.map(pubAd), request_id: req.request_id });
});

// ---- trigger an ad break --------------------------------------------------
const triggerSchema = z.object({
  channel_id: z.string().min(1),
  pod: z.array(z.object({
    ad_id: z.string().min(1),
    duration_seconds: z.number().int().min(1).max(600).optional(),
  })).min(1).max(10),
  lead_ms: z.number().int().min(0).max(5000).optional(),
});
router.post('/trigger', requireScope('ads:write'), validate(triggerSchema), async (req, res, next) => {
  try {
    const channel = channelOwned(req.body.channel_id, req.tenant.id);
    if (!channel) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'channel_id'));

    // Supersede any active break.
    const existing = activeTrigger.get(channel.id);
    if (existing) setTriggerStatus.run('superseded', existing.id);

    // Resolve pod ads (ownership-checked).
    const resolved = [];
    let totalAdSec = 0;
    for (const item of req.body.pod) {
      const ad = getAd.get(item.ad_id);
      if (!ad || ad.tenant_id !== req.tenant.id) {
        return next(new ApiError(404, 'AD_NOT_FOUND', `Ad ${item.ad_id} not found.`, 'pod'));
      }
      const duration = item.duration_seconds || ad.duration_seconds;
      resolved.push({ adId: ad.id, adType: ad.type, adUrl: ad.source, duration, metadata: safeJson(ad.metadata) });
      totalAdSec += duration;
    }

    const bumper = adState.BUMPER_DURATION_SEC;
    const lead = req.body.lead_ms ?? 500;
    const startAt = Date.now() + lead;
    const endAt = startAt + (totalAdSec + bumper) * 1000;
    const triggerId = auth.id();

    const state = { mode: 'pod', triggerId, pod: resolved, bumper, startAt, endAt };
    const wire = { type: 'command', action: 'play_pod', triggerId, pod: resolved, bumper, startAt, ts: Date.now() };

    insertTrigger.run(triggerId, req.tenant.id, channel.id, resolved[0].adId, totalAdSec, 'active', startAt, endAt, 'api', Date.now(), JSON.stringify(resolved));
    await adState.setState(channel.id, state);
    // Fan out to every worker's viewers (cluster-wide), carrying the state so
    // late state reads on other workers are consistent.
    await adState.publishCommand(channel.id, { state, wire });

    hooks.fire(req.tenant, 'ad.break_started', { channel_id: channel.id, trigger_id: triggerId, pod_size: resolved.length, total_seconds: totalAdSec + bumper });
    auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'ad.trigger', resource: triggerId,
      metadata: { channel: channel.id, pod: resolved.length }, ip: clientIp(req) });

    res.status(201).json({
      trigger_id: triggerId,
      channel_id: channel.id,
      pod_size: resolved.length,
      bumper_seconds: bumper,
      total_break_seconds: totalAdSec + bumper,
      starts_at: startAt,
      ends_at: endAt,
      request_id: req.request_id,
    });
  } catch (e) { next(e); }
});

// ---- cancel an in-progress ad break ---------------------------------------
router.post('/cancel', requireScope('ads:write'), validate(z.object({ channel_id: z.string().min(1) })), async (req, res, next) => {
  try {
    const channel = channelOwned(req.body.channel_id, req.tenant.id);
    if (!channel) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'channel_id'));
    const t = activeTrigger.get(channel.id);
    if (t) setTriggerStatus.run('canceled', t.id);
    await adState.setState(channel.id, { mode: 'live' });
    await adState.publishCommand(channel.id, { state: { mode: 'live' }, wire: { type: 'command', action: 'resume_live', triggerId: t?.id || null, ts: Date.now() } });
    if (t) hooks.fire(req.tenant, 'ad.break_canceled', { channel_id: channel.id, trigger_id: t.id });
    auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'ad.cancel', resource: t?.id || channel.id, ip: clientIp(req) });
    res.json({ canceled: !!t, trigger_id: t?.id || null, channel_id: channel.id, request_id: req.request_id });
  } catch (e) { next(e); }
});

// ---- real-time ad-break state (POLLABLE) ----------------------------------
router.get('/state', requireScope('ads:read'), async (req, res, next) => {
  try {
    const channelId = req.query.channel_id;
    if (!channelId) return next(new ApiError(400, 'VALIDATION_ERROR', 'channel_id query param is required.', 'channel_id'));
    const channel = channelOwned(channelId, req.tenant.id);
    if (!channel) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'channel_id'));
    const snapshot = await adState.getBreakState(channelId);
    res.json({ ...snapshot, request_id: req.request_id });
  } catch (e) { next(e); }
});

module.exports = router;

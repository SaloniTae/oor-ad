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
const r2 = require('../../r2');
const cfg = require('../../config');
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
    full_length: !!a.full_length,
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
  // When true, the server does NOT auto-resume live on a timer for a pod
  // containing this ad — it waits for the client's ad.complete event instead.
  full_length: z.boolean().optional(),
});
router.post('/', requireScope('ads:write'), validate(registerSchema), (req, res) => {
  const id = auth.id();
  const meta = {};
  if (req.body.placement) meta.placement = req.body.placement;
  if (req.body.click_url) meta.click_url = req.body.click_url;
  db.prepare(`INSERT INTO ads (id, tenant_id, name, type, source, is_upload, duration_seconds, metadata, full_length, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenant.id, req.body.name, req.body.type, req.body.source_url, 0, req.body.duration_seconds, JSON.stringify(meta), req.body.full_length ? 1 : 0, auth.now());
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
    let hasFullLength = false;
    for (const item of req.body.pod) {
      const ad = getAd.get(item.ad_id);
      if (!ad || ad.tenant_id !== req.tenant.id) {
        return next(new ApiError(404, 'AD_NOT_FOUND', `Ad ${item.ad_id} not found.`, 'pod'));
      }
      const fullLength = !!ad.full_length;
      if (fullLength) hasFullLength = true;
      const duration = item.duration_seconds || ad.duration_seconds;
      resolved.push({
        adId: ad.id, adType: ad.type, adUrl: ad.source, duration,
        full_length: fullLength,
        metadata: safeJson(ad.metadata),
      });
      totalAdSec += duration;
    }

    const bumper = adState.BUMPER_DURATION_SEC;
    const lead = req.body.lead_ms ?? 500;
    const startAt = Date.now() + lead;
    // Full-length breaks have no deterministic end — the client resumes only when
    // it emits ad.complete. We still record a nominal endAt for reporting, but the
    // state carries noAutoResume so nothing (timer OR Redis TTL) ends it early.
    const endAt = startAt + (totalAdSec + bumper) * 1000;
    const triggerId = auth.id();

    const state = { mode: 'pod', triggerId, pod: resolved, bumper, startAt, endAt, noAutoResume: hasFullLength };
    const wire = { type: 'command', action: 'play_pod', triggerId, pod: resolved, bumper, startAt, noAutoResume: hasFullLength, ts: Date.now() };

    insertTrigger.run(triggerId, req.tenant.id, channel.id, resolved[0].adId, totalAdSec, 'active', startAt, endAt, 'api', Date.now(), JSON.stringify(resolved));
    await adState.setState(channel.id, state);
    // Fan out to every worker's viewers (cluster-wide), carrying the state so
    // late state reads on other workers are consistent.
    await adState.publishCommand(channel.id, { state, wire });

    hooks.fire(req.tenant, 'ad.break_started', { channel_id: channel.id, trigger_id: triggerId, pod_size: resolved.length, total_seconds: totalAdSec + bumper, full_length: hasFullLength });
    auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'ad.trigger', resource: triggerId,
      metadata: { channel: channel.id, pod: resolved.length, full_length: hasFullLength }, ip: clientIp(req) });

    res.status(201).json({
      trigger_id: triggerId,
      channel_id: channel.id,
      pod_size: resolved.length,
      bumper_seconds: bumper,
      full_length: hasFullLength,
      // null total when full-length: the break has no server-known duration.
      total_break_seconds: hasFullLength ? null : totalAdSec + bumper,
      starts_at: startAt,
      ends_at: hasFullLength ? null : endAt,
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

// ===========================================================================
// Ad library CRUD (mirrors the website's Ad Library screen). Registered AFTER
// the literal routes above (/trigger, /cancel, /state) so `/:id` never shadows
// them.
// ===========================================================================

function ownAd(req, _res, next) {
  const a = getAd.get(req.params.id);
  if (!a || a.tenant_id !== req.tenant.id) return next(new ApiError(404, 'AD_NOT_FOUND', 'No such ad.', 'id'));
  req.ad = a;
  next();
}

// ---- upload a creative file (multipart -> R2) -----------------------------
// Field name: "file". Extra fields: name, duration_seconds, full_length,
// click_url, alt_text. Mirrors POST /v1/ads/upload but x-api-key secured.
router.post('/upload', requireScope('ads:write'), r2.uploadSingle, (req, res, next) => {
  if (req.uploadError) return next(new ApiError(req.uploadError.status, req.uploadError.code, req.uploadError.message, 'file'));
  if (!req.file) return next(new ApiError(400, 'NO_FILE', 'A multipart "file" field is required.', 'file'));
  const name = (req.body.name || req.file.originalname || 'Untitled').slice(0, 120);
  const duration = Math.max(1, Math.min(600, Number(req.body.duration_seconds) || 15));
  const type = r2.detectTypeFromMime(req.file.mimetype);
  const fullLength = /^(1|true|on|yes)$/i.test(String(req.body.full_length ?? '')) ? 1 : 0;
  const meta = {};
  if (req.body.click_url) meta.click_url = String(req.body.click_url).slice(0, 500);
  if (req.body.alt_text)  meta.alt_text  = String(req.body.alt_text).slice(0, 200);

  const id = auth.id();
  db.prepare(`INSERT INTO ads (id, tenant_id, name, type, source, is_upload, duration_seconds, metadata, full_length, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenant.id, name, type, req.file.key, 1, duration, JSON.stringify(meta), fullLength, auth.now());
  auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'ad.upload', resource: id, ip: clientIp(req) });
  res.status(201).json({ ...pubAd(getAd.get(id)), request_id: req.request_id });
});

// ---- get one --------------------------------------------------------------
router.get('/:id', requireScope('ads:read'), ownAd, (req, res) => {
  res.json({ ...pubAd(req.ad), request_id: req.request_id });
});

// ---- resolve a playable/preview URL (signed for uploads, passthrough else) -
router.get('/:id/signed-url', requireScope('ads:read'), ownAd, async (req, res, next) => {
  try {
    const out = await r2.resolvePlayableUrl(req.ad);
    res.json({ ...out, request_id: req.request_id });
  } catch (e) { next(new ApiError(500, 'CDN_URL_FAILED', 'Failed to resolve the asset URL.')); }
});

// ---- update ---------------------------------------------------------------
const updateAdSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  duration_seconds: z.number().int().min(1).max(600).optional(),
  metadata: z.record(z.any()).optional(),
  source_url: z.string().url().optional(),   // ignored for uploaded assets
  full_length: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' });
router.patch('/:id', requireScope('ads:write'), ownAd, validate(updateAdSchema), (req, res) => {
  const b = req.body;
  const sets = []; const vals = [];
  if (b.name !== undefined)             { sets.push('name = ?'); vals.push(b.name); }
  if (b.duration_seconds !== undefined) { sets.push('duration_seconds = ?'); vals.push(b.duration_seconds); }
  if (b.metadata !== undefined)         { sets.push('metadata = ?'); vals.push(JSON.stringify(b.metadata)); }
  if (b.full_length !== undefined)      { sets.push('full_length = ?'); vals.push(b.full_length ? 1 : 0); }
  if (b.source_url !== undefined && !req.ad.is_upload) { sets.push('source = ?'); vals.push(b.source_url); }
  if (sets.length) {
    vals.push(req.ad.id);
    db.prepare(`UPDATE ads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'ad.update', resource: req.ad.id, metadata: b, ip: clientIp(req) });
  res.json({ ...pubAd(getAd.get(req.ad.id)), request_id: req.request_id });
});

// ---- delete ---------------------------------------------------------------
router.delete('/:id', requireScope('ads:write'), ownAd, async (req, res) => {
  db.prepare('DELETE FROM ads WHERE id = ?').run(req.ad.id);
  if (req.ad.is_upload) { r2.deleteObject(req.ad.source).catch(() => {}); }
  auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'ad.delete', resource: req.ad.id, ip: clientIp(req) });
  res.json({ id: req.ad.id, deleted: true, request_id: req.request_id });
});

module.exports = router;

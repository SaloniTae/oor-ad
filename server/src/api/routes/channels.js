/**
 * /api/v1/channels — Channel management (Section 2).
 *
 * API-first CRUD over the same `channels` table the website uses. To avoid
 * disrupting the website schema we map:
 *   source_url  <-> channels.live_url  (the playable origin)
 *   source_type -> channels.settings.source_type  (m3u8|mp4|mkv|youtube|direct_url)
 *   status      -> channels.settings.status        (active|disabled)
 *
 * The returned `stream_reference` is portable: a third party can point ANY
 * player at source_url directly, or use the secured playback flow (Section 3).
 */
const express = require('express');
const mw = require('../middleware');
const db = require('../../db');
const cfg = require('../../config');
const auth = require('../../auth');
const presence = require('../../presence');
const adState = require('../../ad_state');
const { ApiError, z, validate, requireApiKey, requireScope, rateLimit, logUsage, clientIp } = mw;

const router = express.Router();
router.use(requireApiKey, rateLimit, logUsage);

const SOURCE_TYPES = ['m3u8', 'mp4', 'mkv', 'youtube', 'direct_url'];

// ---- helpers --------------------------------------------------------------
function parseSettings(row) { try { return JSON.parse(row.settings || '{}'); } catch { return {}; } }

function publicChannel(row) {
  const s = parseSettings(row);
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    source_type: s.source_type || 'm3u8',
    source_url: row.live_url,
    status: s.status || 'active',
    require_pin: !!s.requirePin,
    // Portable reference — usable in ANY player, not just our embed.
    stream_reference: {
      source_url: row.live_url,
      source_type: s.source_type || 'm3u8',
      secured: !!s.requirePin,
      playback_generate: '/api/v1/playback/generate',
    },
    created_at: row.created_at,
  };
}

function slugify(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'channel';
  return `${base}-${auth.id(3).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5)}`;
}

const getOwned = (id, tenantId) => db.prepare('SELECT * FROM channels WHERE id = ? AND tenant_id = ?').get(id, tenantId);

// ---- create ---------------------------------------------------------------
const createSchema = z.object({
  name: z.string().min(1).max(120),
  source_type: z.enum(SOURCE_TYPES),
  source_url: z.string().url(),
  slug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9\-_]*$/).optional(),
  require_pin: z.boolean().optional(),
});
router.post('/', requireScope('channels:write'), validate(createSchema), (req, res, next) => {
  const id = auth.id();
  const slug = req.body.slug || slugify(req.body.name);
  const settings = { source_type: req.body.source_type, status: 'active', requirePin: !!req.body.require_pin };
  try {
    db.prepare(`INSERT INTO channels (id, tenant_id, slug, name, live_url, settings, created_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.tenant.id, slug, req.body.name, req.body.source_url, JSON.stringify(settings), auth.now());
  } catch (e) {
    if (String(e).includes('UNIQUE')) return next(new ApiError(409, 'SLUG_TAKEN', 'A channel with this slug already exists.', 'slug'));
    throw e;
  }
  auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'channel.create', resource: id, ip: clientIp(req) });
  res.status(201).json({ ...publicChannel(getOwned(id, req.tenant.id)), request_id: req.request_id });
});

// ---- list (pagination + status filter) ------------------------------------
router.get('/', requireScope('channels:read'), (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const status = req.query.status; // active|disabled|undefined
  let rows = db.prepare('SELECT * FROM channels WHERE tenant_id = ? ORDER BY created_at DESC').all(req.tenant.id);
  if (status === 'active' || status === 'disabled') {
    rows = rows.filter((r) => (parseSettings(r).status || 'active') === status);
  }
  const total = rows.length;
  const page = rows.slice(offset, offset + limit).map(publicChannel);
  res.json({
    items: page,
    pagination: { total, limit, offset, has_more: offset + limit < total },
    request_id: req.request_id,
  });
});

// ---- get single -----------------------------------------------------------
router.get('/:id', requireScope('channels:read'), (req, res, next) => {
  const row = getOwned(req.params.id, req.tenant.id);
  if (!row) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'id'));
  res.json({ ...publicChannel(row), request_id: req.request_id });
});

// ---- update (name / source / require_pin) ---------------------------------
const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  source_type: z.enum(SOURCE_TYPES).optional(),
  source_url: z.string().url().optional(),
  require_pin: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'At least one field is required' });
router.patch('/:id', requireScope('channels:write'), validate(updateSchema), (req, res, next) => {
  const row = getOwned(req.params.id, req.tenant.id);
  if (!row) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'id'));
  const s = parseSettings(row);
  if (req.body.source_type) s.source_type = req.body.source_type;
  if (req.body.require_pin !== undefined) s.requirePin = !!req.body.require_pin;
  const sets = ['settings = ?']; const vals = [JSON.stringify(s)];
  if (req.body.name) { sets.push('name = ?'); vals.push(req.body.name); }
  if (req.body.source_url) { sets.push('live_url = ?'); vals.push(req.body.source_url); }
  vals.push(row.id);
  db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'channel.update', resource: row.id, metadata: req.body, ip: clientIp(req) });
  res.json({ ...publicChannel(getOwned(row.id, req.tenant.id)), request_id: req.request_id });
});

// ---- disable / enable (soft) ----------------------------------------------
function setStatus(status) {
  return (req, res, next) => {
    const row = getOwned(req.params.id, req.tenant.id);
    if (!row) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'id'));
    const s = parseSettings(row); s.status = status;
    db.prepare('UPDATE channels SET settings = ? WHERE id = ?').run(JSON.stringify(s), row.id);
    auth.audit({ tenantId: req.tenant.id, actor: 'api', action: `channel.${status}`, resource: row.id, ip: clientIp(req) });
    res.json({ ...publicChannel(getOwned(row.id, req.tenant.id)), request_id: req.request_id });
  };
}
router.post('/:id/disable', requireScope('channels:write'), setStatus('disabled'));
router.post('/:id/enable', requireScope('channels:write'), setStatus('active'));

// ---- live broadcast state + concurrent viewers ----------------------------
// Mirrors the website channel page's "Live Telemetry Engine" panel. Returns the
// current ad-break state (live | bumper | ad, with pod progress) plus the
// cluster-safe concurrent viewer count so a third-party UI can render the exact
// same "● BROADCAST LIVE / ● COMMERCIAL BREAK" widget.
router.get('/:id/state', requireScope('channels:read'), async (req, res, next) => {
  try {
    const row = getOwned(req.params.id, req.tenant.id);
    if (!row) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'id'));
    const [breakState, viewers] = await Promise.all([
      adState.getBreakState(row.id),
      presence.countChannel(row.id),
    ]);
    res.json({ channel_id: row.id, concurrent_viewers: viewers, ...breakState, request_id: req.request_id });
  } catch (e) { next(e); }
});

// ---- recent triggers (ad-break history) -----------------------------------
// Mirrors the "Recent triggers" table (when / total time / status). Status
// carries the error:* value when a viewer reported a playback failure.
router.get('/:id/triggers', requireScope('channels:read'), (req, res, next) => {
  const row = getOwned(req.params.id, req.tenant.id);
  if (!row) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'id'));
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = db.prepare('SELECT * FROM triggers WHERE channel_id = ? ORDER BY start_at DESC LIMIT ? OFFSET ?')
    .all(row.id, limit, offset);
  const items = rows.map((t) => ({
    id: t.id,
    ad_id: t.ad_id,
    status: t.status,
    duration_seconds: t.duration_seconds,
    start_at: t.start_at,
    end_at: t.end_at,
    triggered_by: t.triggered_by,
    pod: safePod(t.pod_data),
    is_error: /^error:/.test(t.status || ''),
    created_at: t.created_at,
  }));
  res.json({ items, pagination: { limit, offset, returned: items.length }, request_id: req.request_id });
});
function safePod(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }

// ---- issue a viewer token + player/embed links ----------------------------
// Mirrors the website's "Get viewer URL" / "Open player" / "Copy embed code".
// A third party calls this per viewer to get a short-lived scoped token, the
// ws_url their player connects to, and ready-made player + iframe links. When
// the channel requires a PIN the links carry secure=1 so the gate engages.
const viewerTokenSchema = z.object({
  viewer_id: z.string().max(120).optional(),
  ttl_seconds: z.number().int().min(60).max(24 * 3600).optional(),
});
router.post('/:id/viewer-token', requireScope('playback:write'), validate(viewerTokenSchema), (req, res, next) => {
  const row = getOwned(req.params.id, req.tenant.id);
  if (!row) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'id'));
  const viewerId = req.body.viewer_id || auth.id(8);
  const ttl = req.body.ttl_seconds || 3600;
  const token = auth.signViewerToken(req.tenant.id, row.id, viewerId, ttl);
  const secured = !!parseSettings(row).requirePin;
  const wsUrl = `${cfg.publicUrl.replace(/^http/, 'ws')}/ws?channel=${row.slug}&token=${encodeURIComponent(token)}`;
  let playerUrl = `${cfg.publicUrl}/player/?ws=${encodeURIComponent(wsUrl)}`;
  if (secured) playerUrl += `&secure=1&ch=${encodeURIComponent(row.slug)}`;
  const embed = `<iframe src="${playerUrl}" style="width:100%;aspect-ratio:16/9;border:0" allow="autoplay; fullscreen" allowfullscreen></iframe>`;
  auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'channel.viewer_token', resource: row.id, ip: clientIp(req) });
  res.json({
    channel_id: row.id,
    viewer_id: viewerId,
    token,
    expires_in: ttl,
    ws_url: wsUrl,
    player_url: playerUrl,
    embed_code: embed,
    secured,
    request_id: req.request_id,
  });
});

// ---- delete (hard) --------------------------------------------------------
router.delete('/:id', requireScope('channels:write'), (req, res, next) => {
  const row = getOwned(req.params.id, req.tenant.id);
  if (!row) return next(new ApiError(404, 'CHANNEL_NOT_FOUND', 'No such channel.', 'id'));
  db.prepare('DELETE FROM channels WHERE id = ?').run(row.id);
  auth.audit({ tenantId: req.tenant.id, actor: 'api', action: 'channel.delete', resource: row.id, ip: clientIp(req) });
  res.json({ id: row.id, deleted: true, request_id: req.request_id });
});

module.exports = router;
module.exports.SOURCE_TYPES = SOURCE_TYPES;
module.exports.publicChannel = publicChannel;

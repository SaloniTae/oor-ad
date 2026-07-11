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
const auth = require('../../auth');
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

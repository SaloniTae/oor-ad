const express = require('express');
const { z } = require('zod');
const db = require('../db');
const auth = require('../auth');
const ws = require('../ws');
const { HttpError, validate, requireAuth } = require('../middleware');

const r = express.Router();
r.use(requireAuth);

// ---- CRUD ------------------------------------------------------------------
const CreateBody = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9\-_]*$/, 'lowercase alnum, -, _'),
  name: z.string().min(1).max(120),
  live_url: z.string().url(),
  settings: z.record(z.any()).optional(),
});
r.post('/', validate(CreateBody), (req, res, next) => {
  const { slug, name, live_url, settings } = req.body;
  const id = auth.id();
  try {
    db.prepare(`INSERT INTO channels (id, tenant_id, slug, name, live_url, settings, created_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.tenant.id, slug, name, live_url, JSON.stringify(settings || {}), auth.now());
  } catch (e) {
    if (String(e).includes('UNIQUE')) return next(new HttpError(409, 'slug_taken', 'Slug already exists for this tenant'));
    throw e;
  }
  auth.audit({ tenantId: req.tenant.id, actor: req.apiKey?.id || 'session', action: 'channel.create', resource: id, ip: req.ip });
  res.status(201).json({ channel: getChannel.get(id) });
});

const getChannel = db.prepare('SELECT * FROM channels WHERE id = ?');
const listChannels = db.prepare('SELECT * FROM channels WHERE tenant_id = ? ORDER BY created_at DESC');

r.get('/', (req, res) => {
  const rows = listChannels.all(req.tenant.id).map(pub);
  res.json({ channels: rows, viewers_total: ws.totalViewers() });
});
r.get('/:id', ownChannel, (req, res) => res.json({ channel: pub(req.channel), viewers: ws.countViewers(req.channel.id), state: ws.getState(req.channel.id) }));

const UpdateBody = CreateBody.partial();
r.patch('/:id', ownChannel, validate(UpdateBody), (req, res) => {
  const b = req.body;
  const sets = []; const vals = [];
  for (const k of ['slug', 'name', 'live_url']) if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
  if (b.settings !== undefined) { sets.push('settings = ?'); vals.push(JSON.stringify(b.settings)); }
  if (sets.length) {
    vals.push(req.channel.id);
    db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }
  res.json({ channel: getChannel.get(req.channel.id) });
});

r.delete('/:id', ownChannel, (req, res) => {
  db.prepare('DELETE FROM channels WHERE id = ?').run(req.channel.id);
  auth.audit({ tenantId: req.tenant.id, actor: req.apiKey?.id || 'session', action: 'channel.delete', resource: req.channel.id, ip: req.ip });
  res.json({ ok: true });
});

// ---- helpers --------------------------------------------------------------
function pub(c) { return { ...c, settings: JSON.parse(c.settings || '{}') }; }
function ownChannel(req, _res, next) {
  const c = getChannel.get(req.params.id);
  if (!c || c.tenant_id !== req.tenant.id) return next(new HttpError(404, 'not_found', 'Channel not found'));
  req.channel = c;
  next();
}

// ---- viewer token ---------------------------------------------------------
const ViewerTokenBody = z.object({ viewer_id: z.string().max(120).optional(), ttl_seconds: z.number().int().min(60).max(24*3600).optional() });
r.post('/:id/viewer-token', ownChannel, validate(ViewerTokenBody), (req, res) => {
  const viewerId = req.body.viewer_id || auth.id(8);
  const ttl = req.body.ttl_seconds || 3600;
  const token = auth.signViewerToken(req.tenant.id, req.channel.id, viewerId, ttl);
  const cfg = require('../config');
  res.json({
    token, viewer_id: viewerId, expires_in: ttl,
    ws_url: `${cfg.publicUrl.replace(/^http/, 'ws')}/ws?channel=${req.channel.slug}&token=${encodeURIComponent(token)}`,
  });
});

r.get('/:id/state', ownChannel, (req, res) => res.json({ state: ws.getState(req.channel.id), viewers: ws.countViewers(req.channel.id) }));

module.exports = r;
module.exports.ownChannel = ownChannel;   // reused by triggers route

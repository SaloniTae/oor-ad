const express = require('express');
const db = require('../db');
const ws = require('../ws');
const { requireAuth } = require('../middleware');

const r = express.Router();
r.use(requireAuth);

r.get('/overview', (req, res) => {
  const t = req.tenant.id;
  const channels = db.prepare('SELECT COUNT(*) c FROM channels WHERE tenant_id = ?').get(t).c;
  const ads      = db.prepare('SELECT COUNT(*) c FROM ads WHERE tenant_id = ?').get(t).c;
  const since = Date.now() - 24*3600*1000;
  const impressions_24h = db.prepare(`SELECT COUNT(*) c FROM events WHERE tenant_id = ? AND event_type = 'ad.impression' AND created_at > ?`).get(t, since).c;
  const triggers_24h    = db.prepare(`SELECT COUNT(*) c FROM triggers WHERE tenant_id = ? AND start_at > ?`).get(t, since).c;
  const active_viewers  = ws.totalViewers();
  const top_ads = db.prepare(`
    SELECT ad_id, COUNT(*) impressions FROM events
    WHERE tenant_id = ? AND event_type = 'ad.impression' AND created_at > ?
    GROUP BY ad_id ORDER BY impressions DESC LIMIT 10`).all(t, since);
  res.json({ channels, ads, impressions_24h, triggers_24h, active_viewers, top_ads });
});

r.get('/channels/:id', (req, res) => {
  const t = req.tenant.id;
  const c = db.prepare('SELECT * FROM channels WHERE id = ? AND tenant_id = ?').get(req.params.id, t);
  if (!c) return res.status(404).json({ error: { code: 'not_found' } });
  const since = Date.now() - 7*24*3600*1000;
  const connects = db.prepare(`SELECT COUNT(*) c FROM events WHERE channel_id = ? AND event_type = 'viewer.connect' AND created_at > ?`).get(c.id, since).c;
  const impressions = db.prepare(`SELECT COUNT(*) c FROM events WHERE channel_id = ? AND event_type = 'ad.impression' AND created_at > ?`).get(c.id, since).c;
  const triggers = db.prepare(`SELECT COUNT(*) c FROM triggers WHERE channel_id = ? AND start_at > ?`).get(c.id, since).c;
  res.json({ channel_id: c.id, viewers_now: ws.countViewers(c.id), connects_7d: connects, impressions_7d: impressions, triggers_7d: triggers });
});

r.get('/events', (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const rows = db.prepare(`SELECT * FROM events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`).all(req.tenant.id, limit);
  res.json({ events: rows.map(e => ({ ...e, metadata: e.metadata ? JSON.parse(e.metadata) : null })) });
});

module.exports = r;

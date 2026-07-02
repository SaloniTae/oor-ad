// Platform-admin endpoints. Only tenants with plan='admin' can call these.
const express = require('express');
const { z } = require('zod');
const db = require('../db');
const auth = require('../auth');
const ws = require('../ws');
const hooks = require('../webhooks');
const { HttpError, validate, requireAuth } = require('../middleware');

const r = express.Router();

// Gate: require session or key belonging to an admin tenant.
r.use(requireAuth, (req, _res, next) => {
  if (!req.tenant || req.tenant.plan !== 'admin')
    return next(new HttpError(403, 'admin_only', 'Platform admin only'));
  next();
});

// ---- tenants --------------------------------------------------------------
r.get('/tenants', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const rows = db.prepare(`
    SELECT t.id, t.name, t.email, t.plan, t.disabled, t.created_at,
      (SELECT COUNT(*) FROM api_keys k WHERE k.tenant_id = t.id AND k.disabled = 0) AS active_keys,
      (SELECT COUNT(*) FROM channels c WHERE c.tenant_id = t.id) AS channels,
      (SELECT COUNT(*) FROM ads a WHERE a.tenant_id = t.id) AS ads,
      (SELECT COUNT(*) FROM triggers tr WHERE tr.tenant_id = t.id AND tr.start_at > ?) AS triggers_7d
    FROM tenants t ORDER BY t.created_at DESC
  `).all(Date.now() - 7*86400*1000);
  const filtered = q ? rows.filter(t => (t.name+t.email).toLowerCase().includes(q)) : rows;
  res.json({ tenants: filtered });
});

r.get('/tenants/:id', (req, res, next) => {
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return next(new HttpError(404, 'not_found', 'Tenant not found'));
  const channels = db.prepare('SELECT * FROM channels WHERE tenant_id = ?').all(t.id);
  const ads = db.prepare('SELECT id, name, type, duration_seconds, created_at FROM ads WHERE tenant_id = ?').all(t.id);
  const keys = db.prepare('SELECT id, name, key_prefix, rate_limit_rpm, disabled, last_used_at, created_at FROM api_keys WHERE tenant_id = ?').all(t.id);
  const since = Date.now() - 30*86400*1000;
  const triggers_30d   = db.prepare('SELECT COUNT(*) c FROM triggers WHERE tenant_id = ? AND start_at > ?').get(t.id, since).c;
  const impressions_30d= db.prepare(`SELECT COUNT(*) c FROM events WHERE tenant_id = ? AND event_type = 'ad.impression' AND created_at > ?`).get(t.id, since).c;
  res.json({
    tenant: { id: t.id, name: t.name, email: t.email, plan: t.plan, disabled: !!t.disabled,
              cors_origins: JSON.parse(t.cors_origins || '[]'), webhook_url: t.webhook_url, created_at: t.created_at },
    channels, ads, keys, usage: { triggers_30d, impressions_30d },
  });
});

const PatchBody = z.object({
  plan: z.enum(['free', 'pro', 'admin']).optional(),
  disabled: z.boolean().optional(),
  name: z.string().min(1).max(120).optional(),
});
r.patch('/tenants/:id', validate(PatchBody), (req, res, next) => {
  const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!t) return next(new HttpError(404, 'not_found', 'Tenant not found'));
  const sets = []; const vals = [];
  const b = req.body;
  if (b.plan !== undefined)     { sets.push('plan = ?');     vals.push(b.plan); }
  if (b.disabled !== undefined) { sets.push('disabled = ?'); vals.push(b.disabled ? 1 : 0); }
  if (b.name !== undefined)     { sets.push('name = ?');     vals.push(b.name); }
  if (!sets.length) return res.json({ tenant: t });
  vals.push(t.id);
  db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  auth.audit({ tenantId: t.id, actor: `admin:${req.tenant.id}`, action: 'admin.tenant.update', metadata: b, ip: req.ip });
  res.json({ tenant: db.prepare('SELECT * FROM tenants WHERE id = ?').get(t.id) });
});

r.delete('/tenants/:id', (req, res, next) => {
  if (req.params.id === req.tenant.id) return next(new HttpError(400, 'cannot_delete_self', 'You cannot delete yourself'));
  const info = db.prepare('DELETE FROM tenants WHERE id = ?').run(req.params.id);
  if (!info.changes) return next(new HttpError(404, 'not_found', 'Tenant not found'));
  auth.audit({ tenantId: req.params.id, actor: `admin:${req.tenant.id}`, action: 'admin.tenant.delete', ip: req.ip });
  res.json({ ok: true });
});

// Impersonate: mint a session token for another tenant (use with care; logged).
r.post('/tenants/:id/impersonate', (req, res, next) => {
  const t = db.prepare('SELECT * FROM tenants WHERE id = ? AND disabled = 0').get(req.params.id);
  if (!t) return next(new HttpError(404, 'not_found', 'Tenant not found or disabled'));
  const token = auth.signSession(t.id, 60 * 30);   // 30 min
  auth.audit({ tenantId: t.id, actor: `admin:${req.tenant.id}`, action: 'admin.tenant.impersonate', ip: req.ip });
  res.json({ session: token, tenant: { id: t.id, name: t.name, email: t.email }, expires_in: 1800 });
});

// ---- platform-wide stats --------------------------------------------------
r.get('/stats', (_req, res) => {
  const now = Date.now();
  const totals = {
    tenants:   db.prepare('SELECT COUNT(*) c FROM tenants').get().c,
    channels:  db.prepare('SELECT COUNT(*) c FROM channels').get().c,
    ads:       db.prepare('SELECT COUNT(*) c FROM ads').get().c,
    api_keys:  db.prepare('SELECT COUNT(*) c FROM api_keys WHERE disabled = 0').get().c,
  };
  const day = 86400*1000;
  const triggers_24h    = db.prepare('SELECT COUNT(*) c FROM triggers WHERE start_at > ?').get(now-day).c;
  const impressions_24h = db.prepare(`SELECT COUNT(*) c FROM events WHERE event_type='ad.impression' AND created_at > ?`).get(now-day).c;
  const active_viewers  = ws.totalViewers();
  const top_tenants = db.prepare(`
    SELECT t.tenant_id, ten.name, ten.email, COUNT(*) triggers
    FROM triggers t JOIN tenants ten ON ten.id = t.tenant_id
    WHERE t.start_at > ? GROUP BY t.tenant_id ORDER BY triggers DESC LIMIT 10`).all(now-day);
  res.json({ totals, triggers_24h, impressions_24h, active_viewers, top_tenants });
});

// ---- audit log -------------------------------------------------------------
r.get('/audit', (req, res) => {
  const limit = Math.min(500, Number(req.query.limit) || 100);
  const tenantId = req.query.tenant_id || null;
  const rows = tenantId
    ? db.prepare('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?').all(tenantId, limit)
    : db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
  res.json({ audit: rows.map(a => ({ ...a, metadata: a.metadata ? JSON.parse(a.metadata) : null })) });
});

module.exports = r;

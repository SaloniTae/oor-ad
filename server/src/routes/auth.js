// Auth + tenant + API key management
const express = require('express');
const { z } = require('zod');
const db = require('../db');
const auth = require('../auth');
const { HttpError, validate, requireSession } = require('../middleware');

const r = express.Router();

// ---- register / login (dashboard) -----------------------------------------
const RegisterBody = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});
r.post('/register', validate(RegisterBody), (req, _res, next) => {
  const { name, email, password } = req.body;
  const existing = db.prepare('SELECT 1 FROM tenants WHERE email = ?').get(email);
  if (existing) return next(new HttpError(409, 'email_taken', 'Email already registered'));
  const t = {
    id: auth.id(), name, email,
    password_hash: auth.hashPassword(password),
    plan: 'free', webhook_url: null,
    webhook_secret: auth.id(24),
    cors_origins: '[]', disabled: 0, created_at: auth.now(),
  };
  db.prepare(`INSERT INTO tenants (id,name,email,password_hash,plan,webhook_url,webhook_secret,cors_origins,disabled,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(t.id, t.name, t.email, t.password_hash, t.plan, t.webhook_url, t.webhook_secret, t.cors_origins, t.disabled, t.created_at);
  auth.audit({ tenantId: t.id, actor: 'self', action: 'tenant.register', ip: req.ip });
  req.res.status(201).json({ tenant: pubTenant(t), session: auth.signSession(t.id) });
});

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
r.post('/login', validate(LoginBody), (req, _res, next) => {
  const t = db.prepare('SELECT * FROM tenants WHERE email = ? AND disabled = 0').get(req.body.email);
  if (!t || !auth.verifyPassword(req.body.password, t.password_hash))
    return next(new HttpError(401, 'bad_credentials', 'Invalid email or password'));
  auth.audit({ tenantId: t.id, actor: 'self', action: 'tenant.login', ip: req.ip });
  req.res.json({ tenant: pubTenant(t), session: auth.signSession(t.id) });
});

// ---- current tenant -------------------------------------------------------
r.get('/me', requireSession, (req, res) => res.json({ tenant: pubTenant(req.tenant) }));

const UpdateBody = z.object({
  name: z.string().min(1).max(120).optional(),
  webhook_url: z.string().url().nullable().optional(),
  cors_origins: z.array(z.string()).optional(),
});
r.patch('/me', requireSession, validate(UpdateBody), (req, res) => {
  const b = req.body;
  const t = req.tenant;
  const sets = []; const vals = [];
  if (b.name !== undefined)         { sets.push('name = ?');         vals.push(b.name); }
  if (b.webhook_url !== undefined)  { sets.push('webhook_url = ?');  vals.push(b.webhook_url); }
  if (b.cors_origins !== undefined) { sets.push('cors_origins = ?'); vals.push(JSON.stringify(b.cors_origins)); }
  if (!sets.length) return res.json({ tenant: pubTenant(t) });
  vals.push(t.id);
  db.prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  auth.audit({ tenantId: t.id, actor: 'self', action: 'tenant.update', metadata: b, ip: req.ip });
  const fresh = db.prepare('SELECT * FROM tenants WHERE id = ?').get(t.id);
  res.json({ tenant: pubTenant(fresh) });
});

r.post('/me/rotate-webhook-secret', requireSession, (req, res) => {
  const secret = auth.id(24);
  db.prepare('UPDATE tenants SET webhook_secret = ? WHERE id = ?').run(secret, req.tenant.id);
  res.json({ webhook_secret: secret });
});

// ---- API keys -------------------------------------------------------------
r.get('/keys', requireSession, (req, res) => {
  const rows = db.prepare('SELECT id, name, key_prefix, scopes, rate_limit_rpm, disabled, last_used_at, created_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC').all(req.tenant.id);
  res.json({ keys: rows });
});

const CreateKeyBody = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.string()).optional(),
  rate_limit_rpm: z.number().int().positive().max(10000).optional(),
});
r.post('/keys', requireSession, validate(CreateKeyBody), (req, res) => {
  const { full, prefix, hash } = auth.generateApiKey();
  const id = auth.id();
  db.prepare(`INSERT INTO api_keys (id, tenant_id, name, key_hash, key_prefix, scopes, rate_limit_rpm, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, req.tenant.id, req.body.name, hash, prefix,
         JSON.stringify(req.body.scopes || ['*']),
         req.body.rate_limit_rpm || null, auth.now());
  auth.audit({ tenantId: req.tenant.id, actor: 'session', action: 'apikey.create', resource: id, ip: req.ip });
  res.status(201).json({
    id, name: req.body.name, key_prefix: prefix,
    key: full,  // ONLY returned at creation time
    warning: 'Store this key now - it will not be shown again.',
  });
});

r.delete('/keys/:id', requireSession, (req, res, next) => {
  const info = db.prepare('DELETE FROM api_keys WHERE id = ? AND tenant_id = ?').run(req.params.id, req.tenant.id);
  if (!info.changes) return next(new HttpError(404, 'not_found', 'Key not found'));
  auth.audit({ tenantId: req.tenant.id, actor: 'session', action: 'apikey.delete', resource: req.params.id, ip: req.ip });
  res.json({ ok: true });
});

function pubTenant(t) {
  return {
    id: t.id, name: t.name, email: t.email, plan: t.plan,
    webhook_url: t.webhook_url,
    cors_origins: JSON.parse(t.cors_origins || '[]'),
    created_at: t.created_at,
  };
}

module.exports = r;

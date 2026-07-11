/**
 * /api/v1/admin/keys — API key management (Section 1).
 *
 * Admin-only. Auth via the master ADMIN_API_KEY or a full-access admin key.
 * Keys are hashed at rest and the plaintext is shown exactly once (on create
 * and rotate). Everything is audited.
 */
const express = require('express');
const mw = require('../middleware');
const keys = require('../keys');
const auth = require('../../auth');
const { ApiError, z, validate, requireAdminKey, logUsage } = mw;

const router = express.Router();
router.use(requireAdminKey, logUsage);

// ---- create ---------------------------------------------------------------
const createSchema = z.object({
  name: z.string().min(1).max(80),
  access: z.union([z.literal('full'), z.literal('restricted'), z.array(z.string())]).default('restricted'),
  rate_limit_rpm: z.number().int().min(1).max(100000).optional().nullable(),
  ttl_seconds: z.number().int().min(60).max(60 * 60 * 24 * 365).optional().nullable(),
});
router.post('/', validate(createSchema), (req, res) => {
  const out = keys.createKey({
    tenantId: req.tenant.id, name: req.body.name, access: req.body.access,
    rateLimitRpm: req.body.rate_limit_rpm || null, ttlSeconds: req.body.ttl_seconds || null,
  });
  auth.audit({ tenantId: req.tenant.id, actor: 'admin', action: 'apikey.create',
    resource: `apikey:${out.record.id}`, metadata: { access: out.record.access }, ip: mw.clientIp(req) });
  // 201 + plaintext key SHOWN ONCE.
  res.status(201).json({
    ...out.record,
    key: out.key,
    warning: 'Store this key now — it will never be shown again.',
    request_id: req.request_id,
  });
});

// ---- list -----------------------------------------------------------------
router.get('/', (req, res) => {
  res.json({ items: keys.listKeys(req.tenant.id), request_id: req.request_id });
});

// ---- single + usage -------------------------------------------------------
router.get('/:id', (req, res, next) => {
  const usage = keys.keyUsage(req.tenant.id, req.params.id, { limit: Number(req.query.limit) || 50 });
  if (!usage) return next(new ApiError(404, 'KEY_NOT_FOUND', 'No such API key.', 'id'));
  res.json({ ...usage, request_id: req.request_id });
});

// ---- revoke (hard, instant) ----------------------------------------------
router.delete('/:id', (req, res, next) => {
  const row = keys.revokeKey(req.tenant.id, req.params.id);
  if (!row) return next(new ApiError(404, 'KEY_NOT_FOUND', 'No such API key.', 'id'));
  auth.audit({ tenantId: req.tenant.id, actor: 'admin', action: 'apikey.revoke', resource: `apikey:${req.params.id}`, ip: mw.clientIp(req) });
  res.json({ ...row, request_id: req.request_id });
});

// ---- pause / unpause ------------------------------------------------------
router.post('/:id/pause', (req, res, next) => {
  const r = keys.setPaused(req.tenant.id, req.params.id, true);
  if (!r) return next(new ApiError(404, 'KEY_NOT_FOUND', 'No such API key.', 'id'));
  if (r.conflict === 'revoked') return next(new ApiError(409, 'REVOKED', 'Key is revoked and cannot be paused.'));
  auth.audit({ tenantId: req.tenant.id, actor: 'admin', action: 'apikey.pause', resource: `apikey:${req.params.id}`, ip: mw.clientIp(req) });
  res.json({ ...r, request_id: req.request_id });
});
router.post('/:id/unpause', (req, res, next) => {
  const r = keys.setPaused(req.tenant.id, req.params.id, false);
  if (!r) return next(new ApiError(404, 'KEY_NOT_FOUND', 'No such API key.', 'id'));
  if (r.conflict === 'revoked') return next(new ApiError(409, 'REVOKED', 'Key is revoked and cannot be unpaused.'));
  auth.audit({ tenantId: req.tenant.id, actor: 'admin', action: 'apikey.unpause', resource: `apikey:${req.params.id}`, ip: mw.clientIp(req) });
  res.json({ ...r, request_id: req.request_id });
});

// ---- rotate (revoke old, issue new, same scope) --------------------------
router.post('/:id/rotate', (req, res, next) => {
  const out = keys.rotateKey(req.tenant.id, req.params.id);
  if (!out) return next(new ApiError(404, 'KEY_NOT_FOUND', 'No such API key.', 'id'));
  auth.audit({ tenantId: req.tenant.id, actor: 'admin', action: 'apikey.rotate',
    resource: `apikey:${out.record.id}`, metadata: { rotated_from: req.params.id }, ip: mw.clientIp(req) });
  res.status(201).json({
    ...out.record, key: out.key,
    warning: 'Store this key now — it will never be shown again. The previous key is revoked.',
    request_id: req.request_id,
  });
});

module.exports = router;

// Test-fire the tenant's webhook with a synthetic event.
const express = require('express');
const auth = require('../auth');
const hooks = require('../webhooks');
const { HttpError, requireAuth } = require('../middleware');

const r = express.Router();
r.use(requireAuth);

r.post('/test', (req, res, next) => {
  if (!req.tenant.webhook_url) return next(new HttpError(400, 'no_webhook', 'No webhook_url configured'));
  hooks.fire(req.tenant, 'webhook.test', {
    hello: 'this is a test event',
    from: 'ad-injection platform',
    ts: Date.now(),
  });
  auth.audit({ tenantId: req.tenant.id, actor: req.apiKey?.id || 'session', action: 'webhook.test', ip: req.ip });
  res.json({ ok: true, dispatched_to: req.tenant.webhook_url });
});

module.exports = r;

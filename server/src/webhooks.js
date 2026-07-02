/**
 * Webhook delivery - if a tenant has webhook_url set, we POST a JSON body signed
 * with HMAC-SHA256(tenant.webhook_secret). Retries with exponential backoff.
 */
const auth = require('./auth');

const HEADER_SIG = 'X-AdInjection-Signature';
const HEADER_TS  = 'X-AdInjection-Timestamp';
const HEADER_EV  = 'X-AdInjection-Event';

async function deliver(url, secret, event, data, attempt = 0) {
  const ts = Date.now();
  const body = JSON.stringify({ event, ts, data });
  const sig  = auth.signWebhookBody(secret, `${ts}.${body}`);
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 8_000);
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [HEADER_SIG]: sig,
        [HEADER_TS]:  String(ts),
        [HEADER_EV]:  event,
      },
      body, signal: controller.signal,
    });
    clearTimeout(to);
    if (!r.ok && attempt < 4) throw new Error('http ' + r.status);
    return r.ok;
  } catch {
    if (attempt >= 4) return false;
    const delay = Math.min(1000 * 2 ** attempt, 30_000);
    setTimeout(() => deliver(url, secret, event, data, attempt + 1), delay);
    return false;
  }
}

function fire(tenant, event, data) {
  if (!tenant || !tenant.webhook_url || !tenant.webhook_secret) return;
  deliver(tenant.webhook_url, tenant.webhook_secret, event, data).catch(() => {});
}

module.exports = { fire };

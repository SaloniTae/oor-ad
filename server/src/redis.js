/**
 * Shared ioredis client + pub/sub wiring for cluster-safe fan-out.
 *
 * Mirrors the spec's expectation: one Redis instance, two pub/sub channels
 * (ad:commands, session:commands), one shared state key namespace.
 *
 * IMPORTANT: this is a REQUIRED dependency for the streaming-security layer.
 * If REDIS_URL is not set we fall back to redis://127.0.0.1:6379 (same default
 * the spec references). We NEVER silently disable Redis and NEVER build an
 * in-memory fallback for session storage.
 */
const IORedis = require('ioredis');
const cfg = require('./config');

const REDIS_URL = cfg.redisUrl || 'redis://127.0.0.1:6379';

// One client for regular commands, one dedicated to subscriptions
// (ioredis forbids issuing normal commands on a subscribed connection).
const client = new IORedis(REDIS_URL, {
  lazyConnect: false,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});
const pub = new IORedis(REDIS_URL, { lazyConnect: false });
const sub = new IORedis(REDIS_URL, { lazyConnect: false });

client.on('error', (e) => console.error('[redis][client]', e.message));
pub.on('error',    (e) => console.error('[redis][pub]',    e.message));
sub.on('error',    (e) => console.error('[redis][sub]',    e.message));

// Local dispatch table for pub/sub handlers keyed by channel name.
const handlers = new Map();

sub.on('message', (channel, message) => {
  const h = handlers.get(channel);
  if (!h) return;
  let payload;
  try { payload = JSON.parse(message); }
  catch (e) { console.error(`[redis][sub] bad json on ${channel}:`, e.message); return; }
  for (const fn of h) {
    try { fn(payload); }
    catch (e) { console.error(`[redis][sub] handler error on ${channel}:`, e); }
  }
});

async function subscribe(channel, fn) {
  if (!handlers.has(channel)) {
    handlers.set(channel, new Set());
    await sub.subscribe(channel);
  }
  handlers.get(channel).add(fn);
}

async function publish(channel, payload) {
  return pub.publish(channel, JSON.stringify(payload));
}

// Channel names (single source of truth — spec references both patterns)
const CHANNELS = Object.freeze({
  AD_COMMANDS: 'ad:commands',
  SESSION_COMMANDS: 'session:commands',
});

module.exports = { client, pub, sub, subscribe, publish, CHANNELS };

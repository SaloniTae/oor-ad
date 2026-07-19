/**
 * Cluster-safe viewer presence (Section 5 telemetry).
 *
 * Per-worker in-memory viewer counts under-report the moment you run more than
 * one worker. This tracks presence in Redis sorted sets keyed by channel:
 *
 *   presence:{channelId}   ZSET  member = viewerKey, score = lastSeen(ms)
 *   presence:channels      SET   of channelIds that have had presence
 *
 * Counts are ZCOUNT within a freshness window, so a crashed worker's viewers
 * age out on their own (self-healing — no leaked counts). The ws hub refreshes
 * scores on the existing 30s ping and removes members on disconnect.
 */
const { client } = require('./redis');

const FRESH_MS = 75 * 1000;   // a viewer seen within 75s counts as present
const kChan = (id) => `presence:${id}`;
const K_CHANNELS = 'presence:channels';

async function join(channelId, viewerKey) {
  const now = Date.now();
  const pipe = client.pipeline();
  pipe.zadd(kChan(channelId), now, viewerKey);
  pipe.pexpire(kChan(channelId), FRESH_MS * 2);
  pipe.sadd(K_CHANNELS, channelId);
  await pipe.exec();
}
async function refresh(channelId, viewerKey) {
  await client.zadd(kChan(channelId), Date.now(), viewerKey);
}
async function leave(channelId, viewerKey) {
  await client.zrem(kChan(channelId), viewerKey);
}

/** Concurrent viewers on one channel (fresh members only; prunes stale). */
async function countChannel(channelId) {
  const cutoff = Date.now() - FRESH_MS;
  await client.zremrangebyscore(kChan(channelId), 0, cutoff).catch(() => {});
  return client.zcard(kChan(channelId));
}

/** Total concurrent viewers across all channels. */
async function countTotal() {
  const ids = await client.smembers(K_CHANNELS);
  if (!ids.length) return 0;
  let total = 0;
  for (const id of ids) total += await countChannel(id);
  return total;
}

/** Map of channelId -> concurrent viewers (fresh). */
async function snapshot() {
  const ids = await client.smembers(K_CHANNELS);
  const out = {};
  for (const id of ids) out[id] = await countChannel(id);
  return out;
}

module.exports = { join, refresh, leave, countChannel, countTotal, snapshot, FRESH_MS };

/**
 * Cluster-safe token-issuance rate limit (Part 6.1 of spec).
 * Uses Redis atomic INCR + EXPIRE — every worker sees the same counter.
 */
const { client } = require('./redis');

/**
 * @param {string} key     e.g. `authorize:${pin}` or `authorize:${ip}`
 * @param {number} limit   max requests per window
 * @param {number} windowMs
 * @returns { allowed: boolean, remaining: number, resetInMs: number }
 */
async function bump(key, limit, windowMs) {
  const now = Date.now();
  const bucket = Math.floor(now / windowMs);
  const rkey = `ratelimit:${key}:${bucket}`;
  const pipe = client.pipeline();
  pipe.incr(rkey);
  pipe.pexpire(rkey, windowMs + 5000);
  const results = await pipe.exec();
  const count = (results[0] && results[0][1]) || 0;
  const resetInMs = (bucket + 1) * windowMs - now;
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetInMs };
}

module.exports = { bump };

/**
 * Redis-backed session registry (Part 1 of the spec).
 *
 * Keys (all namespaced, no SQLite fallback):
 *   session:{pin}                Redis HASH — sessionId -> JSON blob of session record
 *   session:{pin}:lease           Redis STRING (TTL, per-session heartbeat)  key is
 *                                  actually session:{pin}:lease:{sessionId} — set to
 *                                  '1' with PEX. Presence indicates a live session.
 *   maxDevices:{pin}             Redis STRING — integer (default 1)
 *   revoked_sessions             Redis SET (each member TTL'd via revoked_sessions:{sid} companion key)
 *   session_map:{sessionId}      Redis STRING -> pin (reverse lookup for kick/verify)
 *
 * NOTE: we intentionally use a hash for the session list AND a per-session
 * lease key with PEXPIRE. The hash gives us O(1) enumerate; the lease keys
 * expire automatically without a sweep. On every enumerate we cross-check
 * hash entries against lease keys and prune orphans lazily. This keeps
 * memory bounded without in-process timers, satisfying the spec's
 * "no in-process sweep interval" rule.
 */
const crypto = require('crypto');
const { client, publish, CHANNELS } = require('./redis');

const HEARTBEAT_TTL_MS = 90 * 1000;         // 90s per spec
const REVOKED_TTL_SEC   = 120;              // matches max signed-URL TTL window
const DEFAULT_MAX_DEVICES = 1;

const k = {
  hash:   (pin) => `session:${pin}`,
  lease:  (pin, sid) => `session:${pin}:lease:${sid}`,
  max:    (pin) => `maxDevices:${pin}`,
  map:    (sid) => `session_map:${sid}`,
  revoked:(sid) => `revoked_sessions:${sid}`,
};

const uuid = () => crypto.randomBytes(16).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function parseDeviceLabel(userAgent) {
  const ua = String(userAgent || '');
  const browser =
    /Edg\//.test(ua)     ? 'Edge'    :
    /Chrome\//.test(ua)  ? 'Chrome'  :
    /Safari\//.test(ua)  ? 'Safari'  :
    /Firefox\//.test(ua) ? 'Firefox' : 'Browser';
  const os =
    /Windows/.test(ua)   ? 'Windows' :
    /Android/.test(ua)   ? 'Android' :
    /iPhone|iPad|iOS/.test(ua) ? 'iOS' :
    /Mac OS X/.test(ua)  ? 'macOS'   :
    /Linux/.test(ua)     ? 'Linux'   : 'Unknown';
  return `${browser} on ${os}`;
}

async function getMaxDevices(pin) {
  const v = await client.get(k.max(pin));
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? n : DEFAULT_MAX_DEVICES;
}

async function setMaxDevices(pin, maxDevices) {
  const n = Math.floor(Number(maxDevices));
  if (!Number.isFinite(n) || n < 1 || n > 100) throw new TypeError('maxDevices must be integer in [1,100]');
  await client.set(k.max(pin), String(n));
  return n;
}

// Return live sessions for a pin, pruning orphaned hash entries whose lease
// has already expired. This lazy prune replaces an in-process sweep.
async function listSessions(pin) {
  const raw = await client.hgetall(k.hash(pin));
  const ids = Object.keys(raw);
  if (!ids.length) return [];
  // pipeline-check leases
  const pipe = client.pipeline();
  for (const sid of ids) pipe.exists(k.lease(pin, sid));
  const results = await pipe.exec();
  const alive = [];
  const dead = [];
  for (let i = 0; i < ids.length; i++) {
    const [err, existsVal] = results[i] || [];
    if (err || !existsVal) dead.push(ids[i]);
    else {
      try { alive.push(JSON.parse(raw[ids[i]])); }
      catch { dead.push(ids[i]); }
    }
  }
  if (dead.length) {
    const clean = client.pipeline();
    for (const sid of dead) { clean.hdel(k.hash(pin), sid); clean.del(k.map(sid)); }
    clean.exec().catch(() => {});
  }
  return alive;
}

async function findSessionByDevice(pin, deviceId) {
  const list = await listSessions(pin);
  return list.find((s) => s.deviceId === deviceId) || null;
}

async function createSession(pin, { deviceId, ip, userAgent, workerSocketRef }) {
  if (!deviceId || typeof deviceId !== 'string') throw new TypeError('deviceId required');
  const sessionId = uuid();
  const record = {
    sessionId,
    deviceId,
    deviceLabel: parseDeviceLabel(userAgent),
    ip: String(ip || ''),
    userAgentHash: sha256(userAgent || ''),
    connectedAt: Date.now(),
    lastHeartbeat: Date.now(),
    workerSocketRef: workerSocketRef || null,
  };
  const pipe = client.pipeline();
  pipe.hset(k.hash(pin), sessionId, JSON.stringify(record));
  pipe.set(k.map(sessionId), pin);
  pipe.set(k.lease(pin, sessionId), '1', 'PX', HEARTBEAT_TTL_MS);
  await pipe.exec();
  return record;
}

async function refreshSession(pin, sessionId, patch = {}) {
  const raw = await client.hget(k.hash(pin), sessionId);
  if (!raw) return null;
  let rec;
  try { rec = JSON.parse(raw); } catch { return null; }
  rec.lastHeartbeat = Date.now();
  if (patch.ip) rec.ip = patch.ip;
  if (patch.workerSocketRef) rec.workerSocketRef = patch.workerSocketRef;
  const pipe = client.pipeline();
  pipe.hset(k.hash(pin), sessionId, JSON.stringify(rec));
  pipe.set(k.lease(pin, sessionId), '1', 'PX', HEARTBEAT_TTL_MS);
  await pipe.exec();
  return rec;
}

async function pinForSession(sessionId) {
  return client.get(k.map(sessionId));
}

async function removeSession(pin, sessionId) {
  const pipe = client.pipeline();
  pipe.hdel(k.hash(pin), sessionId);
  pipe.del(k.lease(pin, sessionId));
  pipe.del(k.map(sessionId));
  await pipe.exec();
}

// Revocation set (Part 5). Old signed URLs still work until their TTL runs
// out, but no NEW signed URLs can be minted for a revoked session.
async function revoke(sessionId, reason = 'kicked') {
  await client.set(k.revoked(sessionId), reason, 'EX', REVOKED_TTL_SEC);
}
async function isRevoked(sessionId) {
  const v = await client.get(k.revoked(sessionId));
  return v !== null;
}

// Publish a kick to whichever worker actually holds the socket.
async function kick(pin, sessionIdToKick, reason = 'kicked_by_user') {
  const raw = await client.hget(k.hash(pin), sessionIdToKick);
  let record = null;
  try { record = raw ? JSON.parse(raw) : null; } catch { record = null; }
  await revoke(sessionIdToKick, reason);
  await removeSession(pin, sessionIdToKick);
  await publish(CHANNELS.SESSION_COMMANDS, {
    type: 'kick_session',
    sessionId: sessionIdToKick,
    reason,
    workerSocketRef: record?.workerSocketRef || null,
    at: Date.now(),
  });
  return { revoked: true, hadRecord: !!record };
}

module.exports = {
  DEFAULT_MAX_DEVICES,
  HEARTBEAT_TTL_MS,
  parseDeviceLabel,
  sha256,
  getMaxDevices,
  setMaxDevices,
  listSessions,
  findSessionByDevice,
  createSession,
  refreshSession,
  pinForSession,
  removeSession,
  revoke,
  isRevoked,
  kick,
};

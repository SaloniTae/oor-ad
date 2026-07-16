const url = require('url');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');
const auth = require('./auth');

const getChannelById = db.prepare('SELECT * FROM channels WHERE id = ?');
const getChannelBySlug = db.prepare('SELECT * FROM channels WHERE tenant_id = ? AND slug = ?');
const insertEvent = db.prepare(`
  INSERT INTO events (tenant_id, channel_id, ad_id, trigger_id, viewer_id, event_type, metadata, created_at)
  VALUES (?,?,?,?,?,?,?,?)
`);
const updateTriggerStatus = db.prepare('UPDATE triggers SET status = ? WHERE id = ?');
// Atomic "first-complete-wins": only the FIRST ad.complete for an active trigger
// flips it to completed and returns changes=1, so exactly one viewer's event
// drives the cluster-wide resume. Later duplicates are no-ops.
const completeActiveTrigger = db.prepare("UPDATE triggers SET status = 'completed' WHERE id = ? AND status = 'active'");
const getTriggerById = db.prepare('SELECT * FROM triggers WHERE id = ?');
const getTenantById = db.prepare('SELECT * FROM tenants WHERE id = ?');
const activeTriggerForChannel = db.prepare("SELECT * FROM triggers WHERE channel_id = ? AND status = 'active' ORDER BY start_at DESC LIMIT 1");

const rooms = new Map();
const stateByChannel = new Map();

function join(channelId, ws) {
  let s = rooms.get(channelId);
  if (!s) { s = new Set(); rooms.set(channelId, s); }
  s.add(ws);
}
function leave(channelId, ws) {
  const s = rooms.get(channelId);
  if (!s) return;
  s.delete(ws);
  if (!s.size) rooms.delete(channelId);
}
function safeSend(ws, obj) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}

function broadcast(channelId, obj) {
  const s = rooms.get(channelId);
  if (!s) return 0;
  const payload = JSON.stringify(obj);
  let n = 0;
  for (const ws of s) { if (ws.readyState === 1) { ws.send(payload); n++; } }
  return n;
}
function setState(channelId, state) { stateByChannel.set(channelId, state); }
function getState(channelId) { return stateByChannel.get(channelId) || { mode: 'live' }; }
function countViewers(channelId) { return (rooms.get(channelId) || new Set()).size; }
function totalViewers() { let n = 0; for (const s of rooms.values()) n += s.size; return n; }

/**
 * Resume the live stream when a viewer finishes a full-length ad break.
 *
 * Full-length breaks have NO server timer, so the only resume signal is the
 * client's `ad.complete`. Because every viewer sends it, we use an atomic,
 * status-gated UPDATE so exactly ONE completion (channel-wide) actually drives
 * the resume; every later duplicate is a silent no-op. The resume then fans out
 * to every worker's viewers via the Redis ad:commands channel (same path the
 * trigger used), so all concurrent viewers return to live together.
 *
 * @param {object} channel  the joined channel row
 * @param {string} [triggerId]  the trigger the client was playing (preferred).
 *   Falls back to the channel's active trigger if the client didn't send one.
 */
function handleAdComplete(channel, triggerId) {
  let tid = triggerId;
  if (tid) {
    const t = getTriggerById.get(tid);
    // Ignore completes for a trigger that isn't this channel's (stale/foreign).
    if (!t || t.channel_id !== channel.id) tid = null;
  }
  if (!tid) { const at = activeTriggerForChannel.get(channel.id); tid = at?.id; }
  if (!tid) return; // nothing active to resume

  // Atomic first-wins: only the transition active->completed proceeds.
  const info = completeActiveTrigger.run(tid);
  if (!info.changes) return; // already completed/superseded/canceled by someone else

  const wire = { type: 'command', action: 'resume_live', triggerId: tid, ts: Date.now() };
  // Local viewers (this worker) immediately…
  setState(channel.id, { mode: 'live' });
  broadcast(channel.id, wire);
  // …and every other worker's viewers via Redis, plus clear the shared state.
  try {
    const adState = require('./ad_state');
    adState.setState(channel.id, { mode: 'live' }).catch(() => {});
    adState.publishCommand(channel.id, { state: { mode: 'live' }, wire, originWorker: process.pid }).catch(() => {});
  } catch {}
  // Webhook parity with the timer-based completion path.
  try {
    const hooks = require('./webhooks');
    const tenant = getTenantById.get(channel.tenant_id);
    if (tenant) hooks.fire(tenant, 'ad.completed', { channel_id: channel.id, trigger_id: tid, via: 'viewer_complete' });
  } catch {}
}

function attach(server, log) {
  // noServer: the single upgrade router in index.js dispatches by path. Do NOT
  // use { server, path } here — two path-scoped WebSocketServers on the same
  // http server race on 'upgrade' and destroy each other's sockets.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  // Cluster-wide ad fan-out: a trigger fired on ANY worker (or via the API)
  // publishes to Redis ad:commands; every worker rebroadcasts to its local
  // viewers. This is what makes ad breaks sync across concurrent users on
  // different workers. Best-effort: if Redis is unavailable, local broadcast
  // (same-worker) still works via the direct ws.broadcast path.
  try {
    const { subscribe, CHANNELS } = require('./redis');
    subscribe(CHANNELS.AD_COMMANDS, (msg) => {
      if (!msg || !msg.channelId || !msg.cmd) return;
      if (msg.cmd.state) stateByChannel.set(msg.channelId, msg.cmd.state);
      // Avoid double-delivery: if this worker already broadcast locally (legacy
      // trigger route sets originWorker to its pid), skip the rebroadcast here.
      if (msg.cmd.originWorker && msg.cmd.originWorker === process.pid) return;
      broadcast(msg.channelId, msg.cmd.wire || msg.cmd);
    }).catch((e) => log?.warn?.({ err: e }, 'ad:commands subscribe failed'));
  } catch (e) { log?.warn?.({ err: e }, 'ad:commands wiring failed'); }

  wss.on('connection', (ws, req) => {
    const q = url.parse(req.url, true).query;
    const token = q.token;
    const p = token && auth.verifyJwt(token);
    if (!p || p.typ !== 'viewer') { ws.close(4401, 'bad_token'); return; }

    const channel = getChannelById.get(p.cid);
    if (!channel || channel.tenant_id !== p.tid) { ws.close(4404, 'bad_channel'); return; }

    ws.tenantId  = channel.tenant_id;
    ws.channelId = channel.id;
    ws.viewerId  = p.vid;
    ws.isAlive   = true;
    // Stable per-connection key for cluster-safe presence (see presence.js).
    ws.presenceKey = `${p.vid}:${crypto.randomBytes(4).toString('hex')}`;
    ws.on('pong', () => { ws.isAlive = true; });

    join(channel.id, ws);
    try { require('./presence').join(channel.id, ws.presenceKey).catch(() => {}); } catch {}
    insertEvent.run(channel.tenant_id, channel.id, null, null, ws.viewerId, 'viewer.connect', null, auth.now());

    // Per-channel streaming-security flag lives in the channel settings blob.
    // When set, the player must gate playback behind a PIN + device limit and
    // load the SIGNED manifest — so we withhold the raw live_url here. That
    // way even a plain (non-secure) player link cannot bypass the PIN: with no
    // live_url and no signed manifest, there is simply nothing to play.
    let requirePin = false;
    try { requirePin = !!JSON.parse(channel.settings || '{}').requirePin; } catch { requirePin = false; }

    safeSend(ws, {
      type: 'welcome',
      channel: {
        id: channel.id, slug: channel.slug, name: channel.name,
        liveUrl: requirePin ? null : channel.live_url,
        requirePin,
      },
      viewerId: ws.viewerId,
      ts: Date.now(),
    });
    safeSend(ws, { type: 'state', state: getState(channel.id) });

    let budget = 40;
    const tick = setInterval(() => { budget = 40; }, 10_000);

    ws.on('message', (buf) => {
      if (--budget < 0) { ws.close(1008, 'rate'); return; }
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'hello') return safeSend(ws, { type: 'state', state: getState(channel.id) });
      if (m.type === 'event') {
        const name = String(m.name || '').slice(0, 64);
        if (!name) return;

        insertEvent.run(channel.tenant_id, channel.id, m.adId || null, m.triggerId || null,
                        ws.viewerId, name, m.meta ? JSON.stringify(m.meta).slice(0, 1024) : null, auth.now());

        // --- Full-length ad completion: the ONLY resume signal for full_length
        // breaks (no server timer runs for them). First viewer to report
        // ad.complete for the active trigger wins the atomic flip and drives a
        // cluster-wide resume_live; duplicates from other viewers are no-ops.
        if (name === 'ad.complete') {
          try { handleAdComplete(channel, m.triggerId); } catch (e) { req?.log?.error?.({ err: e }, 'ad.complete handling failed'); }
        }

        // --- INDUSTRY STANDARD TELEMETRY: Bubble player errors to the Dashboard.
        // Any event_type starting with "error:" (e.g. error:ad_playback_failed)
        // is persisted above AND stamps the trigger's status so a red "Issues"
        // panel can query it. If the client didn't send a triggerId, fall back
        // to the channel's currently-active trigger so the error still attaches.
        if (name.startsWith('error:')) {
          try {
            let tid = m.triggerId;
            if (!tid) { const at = activeTriggerForChannel.get(channel.id); tid = at?.id; }
            if (tid) updateTriggerStatus.run(name.slice(0, 50), tid);
          } catch (e) { /* silent fail for db locks */ }
        }
      }
    });

    ws.on('close', () => {
      clearInterval(tick);
      leave(channel.id, ws);
      try { require('./presence').leave(channel.id, ws.presenceKey).catch(() => {}); } catch {}
      insertEvent.run(channel.tenant_id, channel.id, null, null, ws.viewerId, 'viewer.disconnect', null, auth.now());
    });
  });

  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      // Refresh cluster-safe presence score so this viewer stays "fresh".
      if (ws.channelId && ws.presenceKey) {
        try { require('./presence').refresh(ws.channelId, ws.presenceKey).catch(() => {}); } catch {}
      }
      try { ws.ping(); } catch {}
    });
  }, 30_000);

  log?.info(`ws hub attached on /ws`);
  return wss;
}

module.exports = { attach, broadcast, setState, getState, countViewers, totalViewers };

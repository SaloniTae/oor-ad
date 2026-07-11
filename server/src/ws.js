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

        // --- INDUSTRY STANDARD TELEMETRY: Bubble player errors to the Dashboard ---
        if (name.startsWith('error:') && m.triggerId) {
          try {
            updateTriggerStatus.run(name.substring(0, 50), m.triggerId);
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

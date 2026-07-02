/**
 * WebSocket hub - viewer connections are scoped to a channel + carry a JWT
 * viewer-token issued by the API. This prevents random clients from listening
 * to channels they weren't authorized for.
 *
 * Protocol:
 *   Client connects to /ws?channel=<slug>&token=<viewerJwt>
 *   Server sends:  {type:'welcome',...}, {type:'state', state}, and any {type:'command'} broadcasts.
 *   Client sends:  {type:'hello'} (request state re-send), {type:'event', name, meta} (analytics).
 */
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

// channelId -> Set<ws>
const rooms = new Map();
// channelId -> last known state (persists between connects)
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
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });

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
    ws.on('pong', () => { ws.isAlive = true; });

    join(channel.id, ws);
    insertEvent.run(channel.tenant_id, channel.id, null, null, ws.viewerId, 'viewer.connect', null, auth.now());

    safeSend(ws, {
      type: 'welcome',
      channel: { id: channel.id, slug: channel.slug, name: channel.name, liveUrl: channel.live_url },
      viewerId: ws.viewerId,
      ts: Date.now(),
    });
    safeSend(ws, { type: 'state', state: getState(channel.id) });

    // Rate-limit inbound messages so viewers can't flood.
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
      }
    });

    ws.on('close', () => {
      clearInterval(tick);
      leave(channel.id, ws);
      insertEvent.run(channel.tenant_id, channel.id, null, null, ws.viewerId, 'viewer.disconnect', null, auth.now());
    });
  });

  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    });
  }, 30_000);

  log?.info(`ws hub attached on /ws`);
  return wss;
}

module.exports = { attach, broadcast, setState, getState, countViewers, totalViewers };

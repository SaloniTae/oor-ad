/**
 * /stream-ws — dedicated WebSocket for session lifecycle.
 *
 * Kept SEPARATE from the existing `/ws` (which is the ad-injection viewer
 * WebSocket) so we don't disturb any existing behavior. Each cluster worker
 * subscribes to session:commands via Redis; when a kick comes in, whichever
 * worker actually holds that socket sends `session_terminated` down it and
 * closes it. This is the exact fan-out pattern the spec describes.
 */
const url = require('url');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const cfg = require('./config');
const registry = require('./session_registry');
const { subscribe, CHANNELS } = require('./redis');

const WORKER_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

// sessionId -> ws  (LOCAL to this worker only — spec-compliant)
const sockets = new Map();

function verify(token) {
  try {
    const p = jwt.verify(token, cfg.jwtSecret);
    return p && p.typ === 'stream_session' ? p : null;
  } catch { return null; }
}

function attach(server, log) {
  // noServer: dispatched by the single upgrade router in index.js (see ws.js).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  wss.on('connection', async (ws, req) => {
    const q = url.parse(req.url, true).query;
    const p = q.stoken && verify(String(q.stoken));
    if (!p) { ws.close(4401, 'bad_token'); return; }
    if (await registry.isRevoked(p.sid)) { ws.close(4403, 'revoked'); return; }

    ws.streamSid = p.sid;
    ws.pin = p.pin;
    sockets.set(p.sid, ws);

    registry.refreshSession(p.pin, p.sid, {
      workerSocketRef: { workerId: WORKER_ID, socketId: p.sid },
    }).catch(() => {});

    let alive = true;
    ws.on('pong', () => { alive = true; });
    const pingIv = setInterval(() => {
      if (!alive) { try { ws.terminate(); } catch {} clearInterval(pingIv); return; }
      alive = false;
      try { ws.ping(); } catch {}
    }, 30_000);

    const beatIv = setInterval(() => {
      registry.refreshSession(p.pin, p.sid).catch(() => {});
    }, 30_000);

    ws.on('close', () => {
      clearInterval(pingIv);
      clearInterval(beatIv);
      if (sockets.get(p.sid) === ws) sockets.delete(p.sid);
    });

    try { ws.send(JSON.stringify({ type: 'welcome', sessionId: p.sid, ts: Date.now() })); } catch {}
  });

  subscribe(CHANNELS.SESSION_COMMANDS, (msg) => {
    if (!msg || msg.type !== 'kick_session') return;
    const ws = sockets.get(msg.sessionId);
    if (!ws) return;
    try { ws.send(JSON.stringify({ type: 'session_terminated', reason: msg.reason || 'kicked_by_user' })); } catch {}
    try { ws.close(4408, 'session_terminated'); } catch {}
    sockets.delete(msg.sessionId);
  }).catch((e) => log?.error?.({ err: e }, 'session:commands subscribe failed'));

  log?.info?.(`stream ws hub attached on /stream-ws (worker=${WORKER_ID})`);
  return wss;
}

module.exports = { attach };

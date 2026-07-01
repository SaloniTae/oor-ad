/**
 * SINGLE-PORT entrypoint (no cluster, no Redis).
 * For free hosts that give you exactly one public port: HF Spaces (7860),
 * Render.com, Fly.io small VM, or a `docker run` smoke test on your VPS.
 *
 * Everything is served from ONE HTTP server on PORT:
 *   GET  /                 -> redirect to /player/
 *   GET  /player/*         -> viewer UI
 *   GET  /admin/*          -> admin UI
 *   GET  /ws               -> WebSocket upgrade (viewers)
 *   GET  /api/config       -> { liveUrl }
 *   GET  /api/healthz      -> { ok, clients }
 *   GET  /api/stats        -> auth'd
 *   POST /api/trigger-ad   -> auth'd
 *   POST /api/resume-live  -> auth'd
 *
 * Single-process in-memory pub/sub via EventEmitter (fine for one node).
 * Handles thousands of viewers on modest hardware. For 10k+ or multi-node,
 * use index.js (clustered + Redis).
 */
require('dotenv').config();
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');
const pino = require('pino');

const {
  PORT = process.env.SINGLE_PORT || 7860,
  ADMIN_TOKEN = '',
  LIVE_HLS_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  LOG_LEVEL = 'info',
} = process.env;

const log = pino({ level: LOG_LEVEL });
if (!ADMIN_TOKEN) log.warn('ADMIN_TOKEN not set — admin endpoints will refuse all requests.');

const bus = new EventEmitter();
bus.setMaxListeners(0);
let currentState = { mode: 'live' };

// ---- Express app -----------------------------------------------------------
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '16kb' }));

// Static UI
app.use('/player', express.static(path.join(__dirname, '..', 'public', 'player')));
app.use('/admin',  express.static(path.join(__dirname, '..', 'public', 'admin')));
app.get('/', (_req, res) => res.redirect('/player/'));

// Public config
app.get('/api/config',  (_req, res) => res.json({ liveUrl: LIVE_HLS_URL }));
app.get('/api/healthz', (_req, res) => res.json({ ok: true, clients: wss ? wss.clients.size : 0 }));

// Auth
function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}
app.get('/api/stats', auth, (_req, res) =>
  res.json({ clients: wss.clients.size, state: currentState }));

app.post('/api/trigger-ad', auth, (req, res) => {
  const { adUrl, duration = 15, adId = crypto.randomBytes(4).toString('hex') } = req.body || {};
  if (!adUrl) return res.status(400).json({ error: 'adUrl required' });
  if (duration < 1 || duration > 600) return res.status(400).json({ error: 'duration 1..600' });
  const cmd = {
    type: 'command', action: 'play_ad', adId, adUrl, duration,
    startAt: Date.now() + 500, ts: Date.now(),
  };
  currentState = { mode: 'ad', adId, adUrl, duration, startAt: cmd.startAt };
  bus.emit('cmd', JSON.stringify(cmd));
  // Auto revert state after duration.
  setTimeout(() => { if (currentState.adId === adId) currentState = { mode: 'live' }; }, (duration + 1) * 1000);
  log.info({ adId, adUrl, duration }, 'ad triggered');
  res.json({ ok: true, cmd });
});

app.post('/api/resume-live', auth, (_req, res) => {
  const cmd = { type: 'command', action: 'resume_live', ts: Date.now() };
  currentState = { mode: 'live' };
  bus.emit('cmd', JSON.stringify(cmd));
  res.json({ ok: true });
});

// ---- HTTP + WS server ------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 });

function safeSend(ws, obj) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.id = crypto.randomBytes(6).toString('hex');
  ws.on('pong', () => { ws.isAlive = true; });

  const listener = (payload) => { if (ws.readyState === 1) ws.send(payload); };
  bus.on('cmd', listener);
  ws.on('close', () => bus.off('cmd', listener));

  ws.on('message', (buf) => {
    try {
      const m = JSON.parse(buf.toString());
      if (m && m.type === 'hello') safeSend(ws, { type: 'state', state: currentState });
    } catch { /* ignore */ }
  });

  safeSend(ws, { type: 'welcome', liveUrl: LIVE_HLS_URL, clientId: ws.id, ts: Date.now() });
  safeSend(ws, { type: 'state', state: currentState });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  });
}, 30_000);

server.listen(PORT, '0.0.0.0', () =>
  log.info(`ad-injection (single-port) listening on :${PORT}`));

function shutdown() {
  wss.clients.forEach((ws) => { try { ws.close(1001); } catch {} });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

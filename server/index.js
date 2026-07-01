/**
 * Ad Injection - Production WebSocket + Admin API + Static server
 * ---------------------------------------------------------------
 * Architecture:
 *   - Node cluster: N workers (one per CPU) share the same ports via SO_REUSEPORT-style cluster.
 *   - Each worker runs a `ws` WebSocket server bound to WS_PORT (viewers).
 *   - Admin REST API on ADMIN_PORT accepts POST /trigger-ad and POST /resume-live (bearer auth).
 *   - Admin publishes a command to Redis channel `ad:commands`.
 *   - Every worker subscribes to Redis and fans out to its local WS clients.
 *   - This lets a single admin action reach 1000+ viewers spread across all workers/machines
 *     in O(1) admin work and O(N) worker fan-out (in parallel).
 *
 * Scaling notes:
 *   - One VPS with 4 vCPU + 4 workers comfortably handles ~10k idle WS connections.
 *   - To scale beyond one box: run this same service on another VPS, point both at the same
 *     Redis, put both behind a load balancer. No code changes needed.
 */

require('dotenv').config();
const cluster = require('cluster');
const os = require('os');
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');
const Redis = require('ioredis');
const pino = require('pino');
const path = require('path');
const crypto = require('crypto');

const {
  WS_PORT = 6778,
  ADMIN_PORT = 6779,
  STATIC_PORT = 6780,
  REDIS_URL = 'redis://127.0.0.1:6379',
  ADMIN_TOKEN = '',
  LIVE_HLS_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  LOG_LEVEL = 'info',
  CLUSTER_WORKERS = '0',
  NODE_ENV = 'production',
} = process.env;

const workers = Number(CLUSTER_WORKERS) || os.cpus().length;
const log = pino({ level: LOG_LEVEL, base: { pid: process.pid } });

if (!ADMIN_TOKEN || ADMIN_TOKEN === 'change-me-to-a-long-random-string') {
  log.warn('ADMIN_TOKEN is not set to a secure value. Set it in .env before production.');
}

// ============================================================================
// PRIMARY (master) process: spawns workers + runs the static file server once.
// ============================================================================
if (cluster.isPrimary) {
  log.info({ workers }, 'Starting ad-injection primary');

  // Static site (player + admin UI) - runs only on primary, single instance is fine.
  const staticApp = express();
  staticApp.use(helmet({ contentSecurityPolicy: false }));
  staticApp.use(cors());
  staticApp.use('/player', express.static(path.join(__dirname, '..', 'public', 'player')));
  staticApp.use('/admin', express.static(path.join(__dirname, '..', 'public', 'admin')));
  staticApp.get('/', (_req, res) => res.redirect('/player/'));
  staticApp.get('/healthz', (_req, res) => res.json({ ok: true }));
  staticApp.listen(STATIC_PORT, () => log.info(`Static site  http://0.0.0.0:${STATIC_PORT}`));

  for (let i = 0; i < workers; i++) cluster.fork();
  cluster.on('exit', (worker, code) => {
    log.error({ worker: worker.id, code }, 'Worker died, respawning');
    cluster.fork();
  });
  return;
}

// ============================================================================
// WORKER process: WebSocket + Admin API + Redis pub/sub
// ============================================================================

// ---- Redis: two connections, one for pub, one for sub (ioredis requirement) ----
const pub = new Redis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
const sub = new Redis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true });
const CHANNEL = 'ad:commands';
const STATE_KEY = 'ad:state'; // Last known state, so newly-connected viewers can sync.

pub.on('error', (e) => log.error({ err: e.message }, 'redis pub error'));
sub.on('error', (e) => log.error({ err: e.message }, 'redis sub error'));

// ---- WebSocket viewer server ------------------------------------------------
const wsServer = http.createServer();
const wss = new WebSocketServer({ server: wsServer, path: '/ws', maxPayload: 4 * 1024 });

// Heartbeat: drop dead connections so counts stay honest.
function heartbeat() { this.isAlive = true; }

wss.on('connection', async (ws, req) => {
  ws.isAlive = true;
  ws.id = crypto.randomBytes(6).toString('hex');
  ws.on('pong', heartbeat);

  // Rate-limit incoming messages (viewers should barely send anything).
  let msgBudget = 20;
  const budgetTimer = setInterval(() => { msgBudget = 20; }, 10_000);

  ws.on('message', (buf) => {
    if (--msgBudget < 0) { ws.close(1008, 'rate'); return; }
    // Viewers may send {type:"hello"} to request current state.
    try {
      const m = JSON.parse(buf.toString());
      if (m && m.type === 'hello') sendCurrentState(ws);
    } catch { /* ignore */ }
  });

  ws.on('close', () => clearInterval(budgetTimer));

  // Send hello + current state on connect.
  safeSend(ws, {
    type: 'welcome',
    liveUrl: LIVE_HLS_URL,
    serverId: process.pid,
    clientId: ws.id,
    ts: Date.now(),
  });
  sendCurrentState(ws);
});

async function sendCurrentState(ws) {
  try {
    const raw = await pub.get(STATE_KEY);
    if (raw) safeSend(ws, { type: 'state', state: JSON.parse(raw) });
    else safeSend(ws, { type: 'state', state: { mode: 'live' } });
  } catch (e) {
    log.warn({ err: e.message }, 'state read failed');
  }
}

function safeSend(ws, obj) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}

// Kill zombie connections every 30s.
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  });
}, 30_000);

// ---- Fan-out from Redis to local sockets -----------------------------------
sub.subscribe(CHANNEL, (err) => {
  if (err) log.error({ err: err.message }, 'redis subscribe failed');
  else log.info(`worker subscribed to ${CHANNEL}`);
});
sub.on('message', (_ch, payload) => {
  // payload is the JSON message viewers should receive.
  let n = 0;
  wss.clients.forEach((ws) => {
    if (ws.readyState === 1) { ws.send(payload); n++; }
  });
  log.debug({ delivered: n }, 'broadcast');
});

wsServer.listen(WS_PORT, () => log.info(`WS viewer   ws://0.0.0.0:${WS_PORT}/ws`));

// ---- Admin REST API --------------------------------------------------------
const admin = express();
admin.use(helmet());
admin.use(cors());
admin.use(express.json({ limit: '16kb' }));

// Simple in-memory rate limit per IP (production: put a real LB / fail2ban in front).
const rlBucket = new Map();
admin.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const b = rlBucket.get(ip) || { count: 0, reset: now + 10_000 };
  if (now > b.reset) { b.count = 0; b.reset = now + 10_000; }
  b.count++;
  rlBucket.set(ip, b);
  if (b.count > 60) return res.status(429).json({ error: 'rate_limited' });
  next();
});

function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

admin.get('/healthz', (_req, res) => res.json({ ok: true, pid: process.pid, clients: wss.clients.size }));

// Stats (auth'd) - approximate; each worker only knows its own clients.
admin.get('/stats', auth, async (_req, res) => {
  const state = await pub.get(STATE_KEY);
  res.json({
    pid: process.pid,
    clientsOnThisWorker: wss.clients.size,
    state: state ? JSON.parse(state) : { mode: 'live' },
  });
});

/**
 * POST /trigger-ad
 * Body: { adUrl: string (HLS or MP4), duration?: number (seconds), adId?: string }
 * Broadcasts an ad-play command to all viewers. Viewers auto-resume after `duration`,
 * but a subsequent /resume-live is also honored.
 */
admin.post('/trigger-ad', auth, async (req, res) => {
  const { adUrl, duration = 15, adId = crypto.randomBytes(4).toString('hex') } = req.body || {};
  if (!adUrl || typeof adUrl !== 'string') return res.status(400).json({ error: 'adUrl required' });
  if (duration < 1 || duration > 600) return res.status(400).json({ error: 'duration 1..600' });

  const cmd = {
    type: 'command',
    action: 'play_ad',
    adId,
    adUrl,
    duration,
    startAt: Date.now() + 500, // small lead time so all clients hit ~same frame
    ts: Date.now(),
  };
  const state = { mode: 'ad', adId, adUrl, duration, startAt: cmd.startAt };
  // Save state (expires just after ad ends) then publish.
  await pub.set(STATE_KEY, JSON.stringify(state), 'EX', Math.ceil(duration) + 5);
  await pub.publish(CHANNEL, JSON.stringify(cmd));
  log.info({ adId, adUrl, duration }, 'ad triggered');
  res.json({ ok: true, cmd });
});

/** POST /resume-live -> tells all viewers to switch back to live immediately. */
admin.post('/resume-live', auth, async (_req, res) => {
  const cmd = { type: 'command', action: 'resume_live', ts: Date.now() };
  await pub.set(STATE_KEY, JSON.stringify({ mode: 'live' }));
  await pub.publish(CHANNEL, JSON.stringify(cmd));
  log.info('resume live');
  res.json({ ok: true });
});

/** GET /config -> viewer can pre-fetch the live URL if needed. */
admin.get('/config', (_req, res) => res.json({ liveUrl: LIVE_HLS_URL }));

admin.listen(ADMIN_PORT, () => log.info(`Admin API   http://0.0.0.0:${ADMIN_PORT}`));

// ---- graceful shutdown ------------------------------------------------------
function shutdown() {
  log.info('shutting down worker');
  wss.clients.forEach((ws) => { try { ws.close(1001, 'server_shutdown'); } catch {} });
  wsServer.close();
  pub.quit(); sub.quit();
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

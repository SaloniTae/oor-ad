/**
 * Ad Injection - production entry point.
 * Serves API + WebSocket + admin UI + docs on a single port.
 */
const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pino = require('pino');
const pinoHttp = require('pino-http');

const cfg = require('./config');
const db  = require('./db');
const auth = require('./auth');
const ws   = require('./ws');
const { errorHandler } = require('./middleware');

const authRoutes = require('./routes/auth');
const channelRoutes = require('./routes/channels');
const adsRoutes = require('./routes/ads');
const triggersRoutes = require('./routes/triggers');
const analyticsRoutes = require('./routes/analytics');
const adminRoutes = require('./routes/admin');
const webhookRoutes = require('./routes/webhooks');
const metaRoutes = require('./routes/meta');

const log = pino({ level: cfg.logLevel });

// ---- bootstrap admin (if configured) --------------------------------------
(function bootstrap() {
  if (!cfg.bootstrapEmail || !cfg.bootstrapPassword) return;
  const existing = db.prepare('SELECT id FROM tenants WHERE email = ?').get(cfg.bootstrapEmail);
  if (existing) return;
  const id = auth.id();
  db.prepare(`INSERT INTO tenants (id,name,email,password_hash,plan,webhook_secret,cors_origins,disabled,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, 'Admin', cfg.bootstrapEmail, auth.hashPassword(cfg.bootstrapPassword),
         'admin', auth.id(24), '[]', 0, auth.now());
  log.info(`bootstrap tenant created: ${cfg.bootstrapEmail}`);
})();

// ---- express ---------------------------------------------------------------
const app = express();
app.set('trust proxy', true);
app.use(pinoHttp({ logger: log, autoLogging: { ignore: (req) => req.url === '/health' } }));
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: cfg.adminCors.length ? cfg.adminCors : true, credentials: true }));
app.use(express.json({ limit: '256kb' }));

// static: admin UI + player + docs
// Iframe embedding for /player is controlled by IFRAME_ALLOW_ORIGINS.
// - unset / ""      -> allow all (dev / local testing – fixes X-Frame-Options
//                      and CSP errors when you iframe from localhost)
// - "*"             -> allow all (explicit)
// - "self"          -> same-origin only
// - comma list      -> only those origins can embed
function frameEmbedMiddleware(req, res, next) {
  const list = cfg.iframeOrigins;
  // Always remove X-Frame-Options for /player so CSP (which is more expressive)
  // is the source of truth. helmet() set SAMEORIGIN which blocks all cross-origin
  // iframes and generates the errors you saw during localhost testing.
  res.removeHeader('X-Frame-Options');
  let ancestors;
  if (list.length === 0 || list.includes('*'))       ancestors = "*";
  else if (list.length === 1 && list[0] === 'self')  ancestors = "'self'";
  else                                                ancestors = ["'self'", ...list].join(' ');
  res.setHeader('Content-Security-Policy', `frame-ancestors ${ancestors}`);
  next();
}
app.use('/player', frameEmbedMiddleware, express.static(path.join(__dirname, '..', '..', 'public', 'player')));
app.use('/admin',  express.static(path.join(__dirname, '..', '..', 'public', 'admin')));
app.use('/docs',   express.static(path.join(__dirname, '..', '..', 'public', 'docs')));
app.get('/', (_req, res) => res.redirect('/admin/'));

// v1 API
app.use('/v1/auth',      authRoutes);
app.use('/v1/channels',  channelRoutes);
app.use('/v1/channels',  triggersRoutes);   // shares /:id/... paths
// IMPORTANT: mount the public /:id/asset router BEFORE the private one.
// The private router uses requireAuth for the whole /v1/ads prefix, so if we
// mounted it first, the signed-token asset endpoint would 401 for viewers.
app.use('/v1/ads',       adsRoutes.publicAssets);  // /:id/asset with signed token (public, token-guarded)
app.use('/v1/ads',       adsRoutes);               // everything else (requires session/api key)
app.use('/v1/analytics', analyticsRoutes);
app.use('/v1/admin',     adminRoutes);
app.use('/v1/webhooks',  webhookRoutes);
app.use('/',             metaRoutes);

// Convenience: viewer WS URL builder for a channel slug (used by hosted player page)
app.get('/v1/channels/by-slug/:slug/live-config', (req, res, next) => {
  // Public: returns the liveUrl so the player can pre-connect while awaiting WS.
  const c = db.prepare('SELECT c.* FROM channels c JOIN tenants t ON t.id = c.tenant_id WHERE c.slug = ? AND t.disabled = 0').get(req.params.slug);
  if (!c) return next(new (require('./middleware').HttpError)(404, 'not_found', 'Channel not found'));
  res.json({ live_url: c.live_url, channel_slug: c.slug });
});

app.use(errorHandler);

// ---- HTTP + WS --------------------------------------------------------------
const server = http.createServer(app);
ws.attach(server, log);

server.listen(cfg.port, '0.0.0.0', () => log.info(`ad-injection v2 on :${cfg.port}  (${cfg.publicUrl})`));

function shutdown() {
  log.info('shutting down'); server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

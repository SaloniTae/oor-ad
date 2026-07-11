/**
 * /api/v1 — the API-first surface.
 *
 * A self-contained, x-api-key-secured platform that mirrors every website
 * action so third parties can build their own player UI with zero dependency
 * on the embed page. Kept entirely separate from the legacy /v1/* website
 * routes (which keep using middleware.js + session auth).
 *
 * Cross-cutting order: requestId -> [route: auth -> rateLimit -> logUsage]
 *   -> notFound -> errorHandler.
 */
const express = require('express');
const mw = require('./middleware');

const router = express.Router();

// Every API response is JSON and carries a request_id.
router.use(mw.requestId);

// Health/ping for the API surface (no auth — lets integrators verify reachability).
router.get('/ping', (req, res) => res.json({ ok: true, service: 'oor-ad api', version: 'v1', request_id: req.request_id }));

// ---- section routers ------------------------------------------------------
router.use('/admin/keys', require('./routes/keys'));       // Section 1
router.use('/channels',   require('./routes/channels'));   // Section 2
router.use('/playback',   require('./routes/playback'));   // Section 3
router.use('/ads',        require('./routes/ads'));         // Section 4
router.use('/telemetry',  require('./routes/telemetry'));   // Section 5

// ---- tail: 404 + error envelope ------------------------------------------
router.use(mw.notFound);
router.use(mw.errorHandler);

module.exports = router;

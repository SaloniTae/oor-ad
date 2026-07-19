/**
 * /api/v1/overview — Dashboard overview stats (UI parity).
 *
 * Mirrors the website's GET /v1/analytics/overview so a third party can build
 * the same "Overview" landing screen: channel/ad counts, live viewers, and
 * 24h trigger/impression totals, plus the top-ads leaderboard.
 *
 * Live viewer count uses the cluster-safe Redis presence set (not the
 * per-worker in-memory tally), so it is correct behind multiple workers.
 */
const express = require('express');
const mw = require('../middleware');
const db = require('../../db');
const presence = require('../../presence');
const { requireScope, rateLimit, logUsage, requireApiKey } = mw;

const router = express.Router();
router.use(requireApiKey, rateLimit, logUsage);

const DAY = 24 * 3600 * 1000;

router.get('/', requireScope('telemetry:read'), async (req, res, next) => {
  try {
    const t = req.tenant.id;
    const since = Date.now() - DAY;
    const channels = db.prepare('SELECT COUNT(*) c FROM channels WHERE tenant_id = ?').get(t).c;
    const ads = db.prepare('SELECT COUNT(*) c FROM ads WHERE tenant_id = ?').get(t).c;
    const impressions_24h = db.prepare(
      "SELECT COUNT(*) c FROM events WHERE tenant_id = ? AND event_type = 'ad.impression' AND created_at > ?").get(t, since).c;
    const triggers_24h = db.prepare(
      'SELECT COUNT(*) c FROM triggers WHERE tenant_id = ? AND start_at > ?').get(t, since).c;
    const active_viewers = await presence.countTotal();
    const top_ads = db.prepare(`
      SELECT e.ad_id, COUNT(*) impressions,
             (SELECT name FROM ads WHERE id = e.ad_id) AS name
      FROM events e
      WHERE e.tenant_id = ? AND e.event_type = 'ad.impression' AND e.created_at > ? AND e.ad_id IS NOT NULL
      GROUP BY e.ad_id ORDER BY impressions DESC LIMIT 10`).all(t, since);

    res.json({
      channels, ads, active_viewers,
      triggers_24h, impressions_24h,
      top_ads,
      request_id: req.request_id,
    });
  } catch (e) { next(e); }
});

module.exports = router;

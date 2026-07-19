// routes/alertRoutes.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { marketLimiter } = require('../middleware/rateLimit');
const asyncHandler = require('../utils/asyncHandler');
const { generateAlertsForUser } = require('../services/alertService');

// GET /api/alerts — real, on-demand technical alerts computed from live
// candle data. Optional ?scope=all|watchlist query param:
//   scope=all        — always scans a broad curated market list (ignores
//                       the user's own watchlist).
//   scope=watchlist  — always scans only the user's own watchlist stocks.
//   (no scope)       — original behaviour: watchlist if non-empty, else a
//                       small curated fallback list.
// No stored/fabricated alert rows — everything is computed on demand from
// real candle data. These are technical-pattern signals for educational
// purposes only, not buy/sell recommendations.
router.get('/', requireAuth, marketLimiter, asyncHandler(async (req, res) => {
  const scope = ['all', 'watchlist'].includes(req.query.scope) ? req.query.scope : undefined;
  const result = await generateAlertsForUser(req.user.id, scope);
  res.json(result);
}));

module.exports = router;

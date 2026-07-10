// routes/alertRoutes.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { marketLimiter } = require('../middleware/rateLimit');
const asyncHandler = require('../utils/asyncHandler');
const { generateAlertsForUser } = require('../services/alertService');

// GET /api/alerts — real, on-demand technical alerts computed from live
// candle data against the user's own watchlist (or a small curated list
// if their watchlist is empty). No stored/fabricated alert rows.
router.get('/', requireAuth, marketLimiter, asyncHandler(async (req, res) => {
  const result = await generateAlertsForUser(req.user.id);
  res.json(result);
}));

module.exports = router;

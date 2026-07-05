// routes/marketRoutes.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminCheck');
const { marketLimiter, adminLimiter } = require('../middleware/rateLimit');
const { validateMarketSymbol, validateMarketCandles } = require('../middleware/validate');
const ctrl = require('../controllers/marketController');

// ── Upstox connection management (admin only) ──
// One-time-per-day: an admin visits /login, approves on Upstox, gets
// redirected to /callback which stores the token for everyone to use.
router.get('/upstox/login', requireAuth, requireAdmin, adminLimiter, ctrl.upstoxLogin);
router.get('/upstox/status', requireAuth, requireAdmin, adminLimiter, ctrl.upstoxStatus);

// No requireAuth here — this is Upstox's own redirect back to us, not a
// TradeMind user action. See controller comment for the security note.
router.get('/upstox/callback', ctrl.upstoxCallback);

// ── Quotes & candles (any logged-in user) ──
router.get('/quote/:symbol', requireAuth, marketLimiter, validateMarketSymbol, ctrl.getQuote);
router.get('/candles/:symbol', requireAuth, marketLimiter, validateMarketCandles, ctrl.getCandles);

module.exports = router;

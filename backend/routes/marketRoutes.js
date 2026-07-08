// routes/marketRoutes.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminCheck');
const { marketLimiter, adminLimiter } = require('../middleware/rateLimit');
const { validateMarketSymbol, validateMarketCandles, validateMarketQuotes, validateMarketSearch } = require('../middleware/validate');
const ctrl = require('../controllers/marketController');

// ── Upstox connection management (admin only) ──
// One-time-per-day: an admin visits /login, approves on Upstox, gets
// redirected to /callback which stores the token for everyone to use.
router.get('/upstox/login', requireAuth, requireAdmin, adminLimiter, ctrl.upstoxLogin);
router.get('/upstox/status', requireAuth, requireAdmin, adminLimiter, ctrl.upstoxStatus);

// No requireAuth here — this is Upstox's own redirect back to us, not a
// TradeMind user action. See controller comment for the security note.
router.get('/upstox/callback', ctrl.upstoxCallback);

// ── Semi-automated daily refresh (Upstox's official Access Token Request API) ──
// /request-token is called once a day by a cron job (see server.js) OR
// manually by an admin — either an admin JWT or the shared CRON_SECRET
// header is accepted, since a scheduled job has no user session.
function requireAdminOrCronSecret(req, res, next) {
  const cronSecret = req.get('X-Cron-Secret');
  if (process.env.CRON_SECRET && cronSecret === process.env.CRON_SECRET) return next();
  return requireAuth(req, res, () => requireAdmin(req, res, next));
}
router.post('/upstox/request-token', requireAdminOrCronSecret, adminLimiter, ctrl.upstoxRequestToken);

// Upstox's own webhook — no TradeMind auth, see controller comment.
router.post('/upstox/notifier', ctrl.upstoxNotifier);

// ── Quotes & candles (any logged-in user) ──
router.get('/quote/:symbol', requireAuth, marketLimiter, validateMarketSymbol, ctrl.getQuote);
// Batch: GET /api/market/quotes?symbols=RELIANCE,TCS,INFY&exchange=BSE_EQ
router.get('/quotes', requireAuth, marketLimiter, validateMarketQuotes, ctrl.getQuotes);
router.get('/indices', requireAuth, marketLimiter, ctrl.getIndices);
// Search: GET /api/market/search?q=REL — autocomplete across NSE + BSE
router.get('/search', requireAuth, marketLimiter, validateMarketSearch, ctrl.searchSymbols);
// Browse ALL stocks: GET /api/market/stocks?exchange=NSE_EQ&page=1&limit=50
router.get('/stocks', requireAuth, marketLimiter, ctrl.listStocks);
// Real option chain: GET /api/market/options-chain?underlying=NIFTY&expiry=2026-07-10
router.get('/options-chain', requireAuth, marketLimiter, ctrl.getOptionsChain);
router.get('/candles/:symbol', requireAuth, marketLimiter, validateMarketCandles, ctrl.getCandles);

module.exports = router;

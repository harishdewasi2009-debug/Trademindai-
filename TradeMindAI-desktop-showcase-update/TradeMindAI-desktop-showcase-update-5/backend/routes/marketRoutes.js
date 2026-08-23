// routes/marketRoutes.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminCheck');
const { requireFeature, requireScreenerAccess } = require('../middleware/planCheck');
const { marketLimiter, adminLimiter } = require('../middleware/rateLimit');
const { validateMarketSymbol, validateMarketCandles, validateMarketQuotes, validateMarketReport, validateMarketSearch } = require('../middleware/validate');
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
 router.get('/quote/:symbol', marketLimiter, validateMarketSymbol, ctrl.getQuote);
 // Batch: GET /api/market/quotes?symbols=RELIANCE,TCS,INFY&exchange=BSE_EQ
router.get('/quotes', marketLimiter, validateMarketQuotes, ctrl.getQuotes);
// Computed (non-AI) bullish/bearish/neutral bias signals for the Screener:
// GET /api/market/signals?symbols=RELIANCE,TCS&exchange=BSE_EQ
router.get('/signals', marketLimiter, validateMarketQuotes, ctrl.getSignals);
// Full rule-based technical report (Trend, Price Action, RSI, MACD, Volume,
// Candlestick, Volatility, ADX, Bollinger, Fibonacci, Indicator Summary,
// Technical Score, Conclusion) for the Screener's "full analysis" view:
// GET /api/market/report/:symbol?exchange=BSE_EQ
router.get('/report/:symbol', marketLimiter, validateMarketReport, ctrl.getFullReport);
router.get('/indices', marketLimiter, ctrl.getIndices);
router.get('/index-candles', marketLimiter, ctrl.getIndexCandles);
// Search: GET /api/market/search?q=REL — autocomplete across NSE + BSE
router.get('/search', marketLimiter, validateMarketSearch, ctrl.searchSymbols);
// Options-only autocomplete: GET /api/market/search-fno?q=REL
router.get('/search-fno', marketLimiter, validateMarketSearch, ctrl.searchFnoSymbols);
// Browse ALL stocks: GET /api/market/stocks?exchange=NSE_EQ&page=1&limit=50
// FIX: Screener requires a signed-in session (matching the Analysis page's
// gate in frontend/index.html) and stays available on every paid plan
// permanently. Free is a 7-day trial from signup, not unlimited/permanent
// access — requireScreenerAccess() (config/plans.js FREE_SCREENER_TRIAL_DAYS)
// reads req.user.created_at and blocks Free users once the trial window
// closes, prompting them to upgrade. Basic/Pro/Elite behave exactly like
// the plain requireFeature('screener') check used to.
router.get('/stocks', requireAuth, requireScreenerAccess, marketLimiter, ctrl.listStocks);
// Real option chain: GET /api/market/options-chain?underlying=NIFTY&expiry=2026-07-10
// FIX: sold as Elite-only on the pricing page/comparison table but had no
// backend gate — requireFeature('options_analysis') matches config/plans.js
// (only elite.features includes it).
router.get('/options-chain', requireAuth, requireFeature('options_analysis'), marketLimiter, ctrl.getOptionsChain);
router.get('/candles/:symbol', marketLimiter, validateMarketCandles, ctrl.getCandles);

module.exports = router;

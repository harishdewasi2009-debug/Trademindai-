// controllers/marketController.js
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const marketDataService = require('../services/marketDataService');

// ── GET /api/market/upstox/login  (admin only) ───────────────────────────
// Redirects the admin to Upstox's login dialog to approve TradeMind's
// access. This must be done once a day — Upstox tokens expire daily.
const upstoxLogin = asyncHandler(async (req, res) => {
  const url = marketDataService.buildLoginUrl();
  res.redirect(url);
});

// ── GET /api/market/upstox/callback  (no auth — Upstox redirects here) ───
// Upstox itself hits this URL with ?code=... after the admin approves.
// There is no TradeMind session on this request, so it cannot be gated by
// requireAuth/requireAdmin — protection instead comes from this URL only
// being reachable via the admin-initiated /upstox/login redirect, plus the
// code being single-use and short-lived.
const upstoxCallback = asyncHandler(async (req, res) => {
  const { code, error } = req.query;
  if (error) throw new AppError(`Upstox authorization was not granted: ${error}`, 400);
  const result = await marketDataService.exchangeCodeForToken(code);
  res.json({ message: 'Upstox connected successfully.', ...result });
});

// ── GET /api/market/upstox/status  (admin only) ──────────────────────────
const upstoxStatus = asyncHandler(async (req, res) => {
  const status = await marketDataService.upstoxStatus();
  res.json(status);
});

// ── GET /api/market/quote/:symbol  (any authenticated user) ─────────────
const getQuote = asyncHandler(async (req, res) => {
  const quote = await marketDataService.getLtp(req.params.symbol);
  res.json(quote);
});

// ── GET /api/market/candles/:symbol  (any authenticated user) ───────────
// Query params: unit (minutes|hours|days|weeks|months), interval, from, to
const getCandles = asyncHandler(async (req, res) => {
  const { unit, interval, from, to } = req.query;
  const data = await marketDataService.getHistoricalCandles(req.params.symbol, {
    unit,
    interval: interval ? Number(interval) : undefined,
    from,
    to,
  });
  res.json(data);
});

module.exports = { upstoxLogin, upstoxCallback, upstoxStatus, getQuote, getCandles };

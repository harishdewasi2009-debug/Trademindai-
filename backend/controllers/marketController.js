// controllers/marketController.js
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const marketDataService = require('../services/marketDataService');
const userBrokerService = require('../services/userBrokerService');
const liveFeedService = require('../services/liveFeedService');

// ── GET /api/market/upstox/login  (admin only) ───────────────────────────
// Redirects the admin to Upstox's login dialog to approve TradeMind's
// access. This must be done once a day — Upstox tokens expire daily.
const upstoxLogin = asyncHandler(async (req, res) => {
  const url = marketDataService.buildLoginUrl();
  res.redirect(url);
});

// ── GET /api/market/upstox/callback  (no auth — Upstox redirects here) ───
// Upstox itself hits this URL with ?code=... after approval. There is no
// TradeMind session on this request, so it cannot be gated by requireAuth.
//
// This single URL is shared by TWO different flows, since Upstox only
// allows one registered redirect_uri per app:
//  1. Admin market-data connect (marketDataService)    — no `state` param
//  2. A user connecting their OWN portfolio (userBrokerService) — has a
//     signed `state` param identifying which user initiated it
// We check `state` first and branch accordingly.
const upstoxCallback = asyncHandler(async (req, res) => {
  const { code, error, state } = req.query;
  if (error) throw new AppError(`Upstox authorization was not granted: ${error}`, 400);

  const userId = userBrokerService.decodeUserConnectState(state);
  if (userId) {
    await userBrokerService.handleUserCallback(code, userId);
    // Redirect back to the frontend portfolio page rather than returning
    // raw JSON — this callback opens in the user's own browser tab.
    const frontendUrl = process.env.FRONTEND_URL || '/';
    return res.redirect(`${frontendUrl}?upstox_connected=1#portfolio`);
  }

 const result = await marketDataService.exchangeCodeForToken(code);
  const token = await marketDataService.getValidAccessToken();
  liveFeedService.startLiveFeed(token).catch((err) => console.error('[liveFeed] restart failed:', err.message));
  res.json({ message: 'Upstox connected successfully.', ...result });
});
// ── GET /api/market/upstox/status  (admin only) ──────────────────────────
const upstoxStatus = asyncHandler(async (req, res) => {
  const status = await marketDataService.upstoxStatus();
  res.json(status);
});

// ── POST /api/market/upstox/request-token  (admin OR cron secret) ───────
// Triggers Upstox's official Access Token Request API — sends a push
// notification (in-app + WhatsApp) to the admin's phone. Approving it is
// what actually delivers the token, to the notifier webhook below.
// Called manually, or automatically by the daily cron job in server.js.
const upstoxRequestToken = asyncHandler(async (req, res) => {
  const result = await marketDataService.requestAccessTokenApproval();
  res.json({
    message: 'Approval request sent — check your phone (Upstox app or WhatsApp) and tap Approve.',
    ...result,
  });
});

// ── POST /api/market/upstox/notifier  (no auth — Upstox's own webhook) ──
// Upstox POSTs here once the admin approves the request above. There is
// no TradeMind session on this request (same security model as the OAuth
// /callback route) — protection comes from this URL only being known to
// Upstox (set once in the app dashboard as the Notifier Webhook URL) and
// from checking client_id matches our own app.
const upstoxNotifier = asyncHandler(async (req, res) => {
  const { client_id, access_token, expires_at } = req.body || {};
  if (client_id && client_id !== process.env.UPSTOX_API_KEY) {
    throw new AppError('Notifier payload client_id does not match this app.', 400);
  }
const result = await marketDataService.storeNotifiedToken({ access_token, expires_at });
  liveFeedService.startLiveFeed(access_token).catch((err) => console.error('[liveFeed] restart failed:', err.message));
  res.json({ message: 'Token received and stored.', ...result });
});

// ── GET /api/market/quote/:symbol  (any authenticated user) ─────────────
const getQuote = asyncHandler(async (req, res) => {
  const quote = await marketDataService.getLtp(req.params.symbol);
  res.json(quote);
});

// ── GET /api/market/quotes?symbols=RELIANCE,TCS,530001  (any authenticated user) ──
// Batch endpoint — fixes the "only 10 stocks" ticker/screener limitation by
// letting the frontend request any number of symbols in one call instead
// of hardcoding a fixed list. Add &exchange=BSE_EQ to force BSE for all
// symbols in the request; otherwise each symbol tries NSE then BSE.
const getQuotes = asyncHandler(async (req, res) => {
  const { symbols, exchange } = req.query;
  if (!symbols) throw new AppError('symbols query param is required (comma-separated).', 400);

  const list = symbols.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
  const input = exchange ? list.map((symbol) => ({ symbol, exchange })) : list;

  const result = await marketDataService.getLtpBatch(input);
  res.json(result);
});

// ── GET /api/market/signals?symbols=RELIANCE,TCS&exchange=BSE_EQ  (any authenticated user) ──
// Rule-based BUY/HOLD/SELL, computed purely from real technical indicators
// (RSI, EMA, MACD, Supertrend, VWAP, trend strength) — no AI/LLM involved.
// Powers the Screener's Buy/Hold/Sell filter; kept as a separate endpoint
// from /quotes since it's cached much longer (20 min vs 3 sec) and is a
// heavier per-symbol computation.
const getSignals = asyncHandler(async (req, res) => {
  const { symbols, exchange } = req.query;
  if (!symbols) throw new AppError('symbols query param is required (comma-separated).', 400);

  const list = symbols.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
  const input = exchange ? list.map((symbol) => ({ symbol, exchange })) : list;

  const signals = await marketDataService.getSignalsBatch(input);
  res.json({ signals, source: 'computed', fetchedAt: new Date().toISOString() });
});

// ── GET /api/market/stocks?exchange=NSE_EQ&page=1&limit=50  (any authenticated user) ──
// Full paginated browse across all NSE + BSE equities (~5,000+), for an
// "all stocks" page — distinct from /search, which is prefix search.
const getIndices = asyncHandler(async (req, res) => {
  const result = await marketDataService.getIndexQuotes();
  res.json(result);
});

const getIndexCandles = asyncHandler(async (req, res) => {
  const { underlying = 'NIFTY 50', unit, interval, from, to } = req.query;
  const data = await marketDataService.getIndexHistoricalCandles(underlying, {
    unit, interval: interval ? Number(interval) : undefined, from, to,
  });
  res.json(data);
});
const listStocks = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 150);
  const exchange = ['NSE_EQ', 'BSE_EQ'].includes(req.query.exchange) ? req.query.exchange : undefined;
  const result = await marketDataService.listAllSymbols({ exchange, page, limit });
  res.json(result);
});

// ── GET /api/market/options-chain?underlying=NIFTY&expiry=2026-07-10  (any authenticated user) ──
// Real Upstox option chain — replaces the old fabricated OI/PCR numbers.
const INDEX_INSTRUMENT_KEYS = {
  NIFTY: 'NSE_INDEX|Nifty 50',
  BANKNIFTY: 'NSE_INDEX|Nifty Bank',
  SENSEX: 'BSE_INDEX|SENSEX',
};
const getOptionsChain = asyncHandler(async (req, res) => {
  const { underlying = 'NIFTY', expiry } = req.query;
  if (!expiry) throw new AppError('expiry query param is required (YYYY-MM-DD).', 400);

  const instrumentKey = INDEX_INSTRUMENT_KEYS[underlying.toUpperCase()]
    || await marketDataService.resolveInstrumentKey(underlying); // falls through to NSE/BSE equity for stock options

  const chain = await marketDataService.getOptionChain(instrumentKey, expiry);
  res.json({ underlying, expiry, chain });
});
// ── GET /api/market/search?q=REL  (any authenticated user) ──────────────
// Symbol search across NSE + BSE for autocomplete, so the frontend isn't
// stuck picking from a hardcoded stock list.
const searchSymbols = asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q) throw new AppError('q query param is required.', 400);
  const results = await marketDataService.searchSymbols(q, 20);
  res.json({ results });
});

// ── GET /api/market/search-fno?q=REL  (any authenticated user) ──────────
// Same autocomplete, but filtered to only underlyings that actually have
// a listed options segment (derived from Upstox's own instrument master,
// not a hand-maintained list) — feeds the Options page search bar so it
// never suggests a stock that has no option chain.
const searchFnoSymbols = asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q) throw new AppError('q query param is required.', 400);
  const results = await marketDataService.searchFnoSymbols(q, 20);
  res.json({ results });
});

// ── GET /api/market/candles/:symbol  (any authenticated user) ───────────
// Query params: unit (minutes|hours|days|weeks|months), interval, from, to,
// exchange (NSE_EQ|BSE_EQ — optional; omit to try NSE first then BSE, same
// as before. The Charts page's NSE/BSE switch sends this explicitly so a
// symbol listed on both exchanges shows the one the trader actually picked.)
const getCandles = asyncHandler(async (req, res) => {
  const { unit, interval, from, to } = req.query;
  const exchange = ['NSE_EQ', 'BSE_EQ'].includes(req.query.exchange) ? req.query.exchange : undefined;
  const data = await marketDataService.getHistoricalCandles(req.params.symbol, {
    unit,
    interval: interval ? Number(interval) : undefined,
    from,
    to,
    exchange,
  });
  res.json(data);
});

module.exports = { upstoxLogin, upstoxCallback, upstoxStatus, upstoxRequestToken, upstoxNotifier, getQuote, getQuotes, getSignals, getIndices, getIndexCandles, searchSymbols, searchFnoSymbols, listStocks, getOptionsChain, getCandles };

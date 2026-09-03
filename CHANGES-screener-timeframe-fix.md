# Fix: Screener "Time Interval" chips were cosmetic only

## The bug

The Screener sidebar (`#page-screener`) has a "Time Interval" filter row
(1 Minute … 5 Year chips) that looks and behaves like the candle-interval
picker on the Analysis/Charts page. Selecting a chip called
`setScreenerTimeframe()`, which stored the choice in `screenerPeriod` and
even sent it to the backend as `?period=...` on `/api/market/signals`.

But nothing on the backend ever read that `period` param:

- `marketController.js`'s `getSignals` destructured only
  `{ symbols, exchange }` from `req.query` — `period` was silently dropped.
- `marketController.js`'s `getFullReport` (powers the "full analysis" view
  opened from a Screener row, and the stock-detail mini-modal) never read
  `req.query.period` either.
- `marketDataService.js`'s `getTechnicalSignal()` and
  `getFullTechnicalReport()` always fetched candles with
  `{ unit: 'days', interval: 1 }` hardcoded, and cached results only by
  `SYMBOL:EXCHANGE` (no timeframe in the cache key).
- The stock-detail modal's mini chart (`openStockDetail()`) always requested
  `unit=days&interval=1` too, and always labeled the range "30D High/Low"
  regardless of what was actually fetched.

Net effect: every Bullish/Bearish badge in the Screener list, the full
technical report, and the mini-chart/quick-analysis modal were **always**
computed off daily candles — changing the Time Interval chip did nothing
except toggle which button looked active.

## The fix

**Backend**
- `services/marketDataService.js`: added `PERIOD_CANDLE_PARAMS` /
  `candleParamsForPeriod(period)`, mapping each Screener chip to a real
  Upstox `{unit, interval}` (intraday/1D/1W/1M chips) or to daily candles
  with a widened lookback window (3mo–5y chips, since Upstox has no such
  thing as a single "3-month candle"). `getTechnicalSignal()`,
  `getFullTechnicalReport()`, and `getSignalsBatch()` now accept and use
  `period`, and their cache keys now include it (so different timeframes no
  longer serve each other's stale cached results).
- `controllers/marketController.js`: `getSignals` and `getFullReport` now
  read `period` from the query string and pass it through.
- `middleware/validate.js` / `routes/marketRoutes.js`: `period` is now
  allow-listed and validated on `/api/market/signals` and the new
  `validateMarketReport` (used on `/api/market/report/:symbol`).

**Frontend**
- `openStockDetail()` (the Screener's click-through quick-analysis modal)
  now requests candles and the full report at the Screener's currently
  selected interval instead of hardcoded daily, and shows an "Analysis
  timeframe: …" badge in the modal header so it's clear which interval the
  numbers reflect.
- The range card and technical-reading disclaimer text no longer hardcode
  "30D" / "daily candles" — they name whatever interval was actually used.

Signal badges in the Screener list (`fetchSignalsBatch`) already sent
`period` correctly; they just needed the backend fix above to start being
honored.

---

## Follow-up 1: same bug existed on the Analysis page

The Analysis page has its own "Analysis timeframe" dropdown (`#inp-timeframe`,
same 1 Minute → 5 Year values as the Screener). It was already being
collected client-side (`getAnalysisHorizonRisk()`) and sent as `timeframe`
on every `/api/ai/analyze` request — but exactly like the Screener bug,
nothing on the backend read it:

- `routes/aiRoutes.js` destructured only `{ stockSymbol, horizon,
  riskTolerance, exchange }` from the request body — `timeframe` was
  dropped.
- `services/aiService.js`'s `fetchRealMarketContext()` always fetched daily
  candles over a hardcoded 1-year window, regardless of the dropdown.

**Fix:** `aiRoutes.js` now reads and forwards `timeframe`; `validate.js`
allow-lists it; `aiService.js` reuses the same
`marketDataService.candleParamsForPeriod()` mapping the Screener fix
introduced (now exported) to fetch the right candle granularity, and
mentions the selected timeframe in the prompt sent to the model. This
applies to Quick Analysis, Deep Research, Compare, and Portfolio Scan,
since they all share `getAnalysisHorizonRisk()`.

## Follow-up 2: Screener was reachable (and broke confusingly) before sign-in

`show()` only redirected logged-out visitors away from Dashboard and Admin
— Screener had no such gate, so an unauthenticated visitor could open the
Screener page and see the full sidebar/filters. The actual data request
(`/api/market/stocks`, which does correctly require auth server-side) would
then fail with a 401, which the UI rendered as a generic "Stocks are
temporarily unavailable" message — no mention of needing to sign in, and no
way back into the Screener after logging in (login always landed on
Dashboard).

**Fix:**
- `show('screener')` now redirects straight to the Google/email sign-in
  screen when logged out, same as Dashboard/Admin.
- A new `postLoginRedirect` + `goToPostLoginDestination()` remembers where
  the visitor was trying to go, so signing in (via Google, email/password,
  or signup) sends them back to the Screener instead of always to
  Dashboard.
- `renderScreener()`'s error handling now recognizes a 401 specifically
  (e.g. a session that expired while already on the page) and shows a
  "Sign in to use the Screener" prompt with a Sign in button, instead of
  lumping it in with the generic unavailable message.


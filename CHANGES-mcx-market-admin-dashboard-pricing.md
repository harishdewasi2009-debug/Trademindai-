# Add MCX market data + admin + dashboard pricing + chart fix

## 1. MCX commodity market data (real Upstox data, not fabricated)

**backend/services/marketDataService.js**
- Added `MCX_FO` to `EXCHANGE_FILES`, pointing at Upstox's MCX instrument
  master (`.../instruments/exchange/MCX.json.gz`) — same per-exchange file
  pattern already used for NSE/BSE.
- `loadInstrumentMaster()` now branches for `MCX_FO`: MCX lists dated
  **futures contracts** (e.g. `GOLD25AUGFUT`), not permanent ISIN-identified
  equities, so it can't reuse the equity parsing path. For each commodity
  (GOLD, SILVER, CRUDEOIL, NATURALGAS, COPPER, ZINC, etc.) it picks
  whichever real, currently-listed contract expires soonest but hasn't
  expired yet (the standard "near month" convention) and resolves the
  plain commodity name to that contract's real `instrument_key`.
- Added `listMcxSymbols()` and exported `MCX_COMMODITY_SYMBOLS` (a naming
  reference list, not a price source — every quote/candle still comes from
  the live Upstox instrument resolved at request time).
- `searchSymbols()` now also searches `MCX_FO`, so commodities show up in
  the same autocomplete used by Watchlist / Charts / Portfolio / Screener
  everywhere else in the app.

**backend/controllers/marketController.js**, **routes/marketRoutes.js**,
**middleware/validate.js**
- `MCX_FO` added to every exchange whitelist that previously only accepted
  `NSE_EQ`/`BSE_EQ` (candles, quotes, signals, full report, quant report) —
  4 spots in the controller, 3 in validators.
- New `GET /api/market/mcx` route + controller — full MCX commodity list,
  same auth/screener-access gate as `/api/market/stocks`.
- **Real bug fixed**: `getQuote` (`GET /api/market/quote/:symbol`) never
  read `?exchange=` at all — a forced-BSE or MCX single-symbol quote was
  silently impossible before this.

## 2. AI assistant — MCX everywhere

`analyzeStock()`/`fetchRealMarketContext()` in **aiService.js** already
resolved symbols generically through `marketDataService`, so once MCX
resolution above works, `/api/ai/analyze` works for commodities with no
further change. Updated:
- The `/api/ai/chat` system prompt to mention MCX commodity markets
  explicitly (previously said "Focus on NSE/BSE markets").
- Comments/validators in `aiRoutes.js` to reflect `MCX_FO` as a valid
  `exchange` value.

## 3. Chart fix + MCX in Charts/Screener (frontend)

**Real bug**: `loadChart()` never sent `?exchange=` to
`/api/market/candles/:symbol` at all — it always relied on the backend's
NSE-then-BSE guess. Any symbol that only existed on BSE-with-a-clash or
(after this update) MCX had no way to resolve and the chart just failed
with "Could not load candles."

- Added an exchange dropdown (NSE / BSE / MCX) to the **Charts** page,
  wired through `submitChartLoad` → `loadChart(symbol, exchange)` →
  `/api/market/candles/:symbol?exchange=...` and into `watchLiveSymbol`.
- Added an **MCX tab** to the Screener (`#screenerExchangeTabs`) —
  `loadDashboardScreener()` was already fully parameterized by
  `screenerExchange`, so this tab works against the same
  `/api/market/stocks` + `/quotes` + `/signals` endpoints with zero other
  frontend changes needed once the backend accepted `MCX_FO`.
- Added an exchange dropdown to **Computed Analysis** too, and threaded
  the row's real exchange through the Screener's "Analyze" button
  (`goAnalyzeSymbol(symbol, exchange)`) so jumping from an MCX screener row
  into Computed Analysis actually resolves the right commodity instead of
  falling back to the NSE/BSE-only default.

## 4. Admin: harishdewasi2009@gmail.com

**backend/controllers/authController.js**
- Added an `ADMIN_EMAILS` set (seed admin + `harishdewasi2009@gmail.com` +
  anything in the `ADMIN_EMAILS` env var). `googleLogin()` now promotes any
  matching email to `is_admin = TRUE` automatically — on first signup, or
  retroactively on next login if the account already existed.

**backend/db/promoteAdmin.js** (new)
- `node db/promoteAdmin.js [email]` — immediately flips `is_admin = TRUE`
  for an existing account (or creates a placeholder row if it doesn't
  exist yet), for when you don't want to wait for the next Google sign-in.
  Defaults to `harishdewasi2009@gmail.com`.

## 5. Dashboard: full pricing structure (mirrors homepage)

The dashboard's Subscription page previously only had two bare "Upgrade"
buttons with no prices, features, or comparison shown. Added:
- The same 3 plan cards as the homepage (`PRICING_PLANS` in the script —
  a single JS source of truth so homepage and dashboard can't drift out of
  sync), rendered via `renderDashboardPricing()`, called every time
  `loadSubscription()` runs so the current plan is highlighted live.
- The full feature comparison table (Free / Pro ₹499 / Elite ₹999),
  including the NSE · BSE · MCX data row.

**Prices shown are display-only** — the real source of truth for what's
actually charged is `backend/config/plans.js`; keep both in sync if prices
change there.

## What this does NOT cover / known limits

- No network access was available while writing this, so the MCX
  instrument-master URL/field names (`instrument_type`, `expiry`,
  `asset_symbol`/`underlying_symbol`) are inferred from Upstox's
  documented, consistent per-exchange file pattern (same as the
  already-working NSE/BSE files) — **verify against a live Upstox
  connection before deploying**, the same way earlier notes in this
  codebase (e.g. the `getLtp` quote-shape comment) already flag similar
  untested assumptions.
- MCX **options** (as opposed to futures) are not wired into the Options
  Chain page — that page still covers NIFTY/BANKNIFTY/SENSEX/stock
  options only. Not part of what was asked for this pass.
- The homepage's separate ticker/Markets-overview widgets (`stocks`,
  `indices` arrays) are a small curated display list unrelated to the
  Screener/Charts/AI paths above and were left as-is.

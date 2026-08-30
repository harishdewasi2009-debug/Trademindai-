# MCX (Upstox) integration

Adds MCX commodity data (Gold, Silver, Crude Oil, Natural Gas, Copper, etc.)
as a first-class exchange alongside NSE_EQ/BSE_EQ, using Upstox's existing
instrument-master file for MCX (`MCX.json.gz`, segment `MCX_FO`). MCX has no
cash-equity segment — every row is a futures/options contract — so a
commodity resolves to its current **front-month futures contract**
(nearest non-expired expiry), the same role a single index instrument_key
plays for NIFTY 50 / SENSEX. That resolution re-picks itself automatically
as contracts expire and roll; no manual updates needed month to month.

## Backend

- **`services/marketDataService.js`**
  - `EXCHANGE_FILES.MCX_FO` → Upstox's MCX instrument master URL.
  - New `parseMcxInstrumentMaster()` — picks the nearest-unexpired FUT
    contract per commodity; collects CE/PE underlyings for F&O search.
  - New `ALL_BROWSABLE_EXCHANGES = ['NSE_EQ','BSE_EQ','MCX_FO']`, used by
    `searchSymbols`, `searchFnoSymbols`, `listAllSymbols`, and
    `getFnoUnderlyings` so MCX is included by default in "search/browse
    everything" flows.
  - `resolveInstrumentKey()` (used for a single ambiguous symbol lookup —
    watchlist add, quote-by-symbol) deliberately **keeps its NSE→BSE-only
    default** — MCX is never auto-tried, only when `exchange: 'MCX_FO'` is
    passed explicitly. This means an equity ticker can never accidentally
    resolve to a commodity contract.
  - `searchSymbols`/`searchFnoSymbols` gained an optional exchange filter.
- **`middleware/validate.js`** — every `exchange` validator now accepts
  `MCX_FO` (AI analyze, market quotes/report/search, watchlist add,
  portfolio add-holding).
- **`controllers/marketController.js`** — inline exchange whitelists
  widened (`listStocks`, `getFullReport`, `getCandles`); `/search` and
  `/search-fno` now accept `?exchange=MCX_FO`; `/options-chain` can resolve
  a commodity underlying with `?exchange=MCX_FO`.
- **`db/schema.sql`** — added `exchange VARCHAR(10)` to `portfolios` and
  `watchlist` (migration-safe `ADD COLUMN IF NOT EXISTS`, picked up by the
  existing `db/migrate.js` run) so a manually-tracked commodity holding or
  a watched commodity resolves via MCX_FO instead of the NSE/BSE default.
- **`controllers/watchlistController.js` / `portfolioController.js`** —
  accept, store, and return the optional `exchange` field.
- **`services/alertService.js`** — the watchlist scan now selects and
  threads through each row's `exchange`, so an MCX commodity on a user's
  watchlist is actually scanned for alerts instead of silently failing
  NSE/BSE resolution.
- **`services/liveFeedService.js`** — `feedKeyFor()` gives MCX ticks their
  own `MCX:<symbol>` key; `watchSymbol()` accepts `exchange: 'MCX_FO'` for
  on-demand commodity ticks; `startLiveFeed()` also resolves and subscribes
  a small default MCX set (`DEFAULT_MCX_SYMBOLS`: GOLD, SILVER, CRUDEOIL,
  NATURALGAS, COPPER) so commodity ticks are live without waiting for a
  browser to open the MCX tab first.
- **`services/userBrokerService.js`** — no code changes needed: real
  broker-synced holdings/positions/orders already pass through whatever
  `exchange` Upstox reports, so a user's actual MCX positions show up
  automatically. Added a comment documenting this.
- **`services/scannerAccuracyService.js`** — no changes needed; it already
  stores/reads `exchange` generically, so MCX signals get accuracy-tracked
  the same as NSE/BSE ones once `getTechnicalSignal(...)` is called with
  `exchange: 'MCX_FO'`.

## Frontend (`frontend/index.html`)

- Added a shared `exchangeLabel(exchange)` helper (NSE/BSE/MCX) and
  replaced the ~6 scattered `exchange==='BSE_EQ'?'BSE':'NSE'` ternaries
  that would otherwise have mislabeled a commodity result as "NSE".
- Added an **"MCX — commodities"** scan-universe chip on the Market
  Scanner page (`setScanUniverse('MCX_FO', ...)`), reusing every existing
  scan type (breakout, volume spike, reversal, oversold, gap, momentum)
  against MCX front-month candles with no additional scanner logic needed.

### Not yet done (follow-up)
- No dedicated MCX section/icon set on the Watchlist, Portfolio "add
  holding", or Search UI — those forms still just take a symbol; adding a
  visible exchange picker there (so a user can add "GOLD" as MCX_FO rather
  than it 404'ing against NSE/BSE) is the natural next step for the
  frontend once you're ready for it.
- MCX options chains resolve the front-month **future** as the underlying;
  Upstox's commodity option-chain semantics can differ subtly from
  index/equity options and haven't been tested against a live connection.
- `DEFAULT_MCX_SYMBOLS` in `liveFeedService.js` is a small starter list —
  edit it the same way you'd edit `DEFAULT_SYMBOLS`.

# Fix: Chart timeframes showing the wrong range (NSE + BSE) + MCX quotes going dead over time + Screener/quotes silently failing for every exchange

## 0. THE BIG ONE — Screener showing "No quote" for NSE, BSE, and MCX alike

### Root cause
`backend/middleware/validate.js`'s `validateMarketQuotes` (guards
`/api/market/quotes` and `/api/market/signals`) checks the `symbols` query
param against this regex:

```js
.matches(/^[A-Za-z0-9&_,-]+$/)
```

An earlier fix (already in the code, described in its own comments) added a
per-entry `"SYMBOL:EXCHANGE"` override — e.g. `RELIANCE:BSE_EQ` — so a
dual-listed symbol's NSE row and BSE row (and any MCX row) each resolve
against their own exchange instead of colliding into one price. **But the
regex above was never updated to allow the `:` character.** The Screener
tags every row with its exchange unconditionally, so essentially every real
quotes/signals request it makes has always contained a colon — and has
always been rejected with a 400 ("symbols contains invalid characters")
ever since that per-entry syntax was introduced.

The frontend swallows that failure silently (`.catch(()=>({}))`), so it
never showed up as a visible error — it just quietly showed "No quote yet"
for every row, on every exchange, in the Screener, the search dropdowns,
and the stock-detail modal. The only thing that ever looked "fine" was the
top ticker tape, because `TICKER_SYMBOLS` are plain strings with no exchange
tag — no colon, no rejection.

This is exchange-agnostic (breaks NSE, BSE, and MCX identically), which is
why it looked like "NSE and BSE data broken" and "MCX live quote removed"
at the same time — it's the same one request getting rejected for all of
them.

### Fix
Widened the regex to allow `:` — `/^[A-Za-z0-9&_,:-]+$/`. That's the whole
fix; the actual per-exchange quote logic downstream (`getLtpBatch`,
`getSignalsBatch`) was already correct, it just never got a chance to run.

This is the fix that should visibly bring live quotes back on the Screener
for NSE, BSE, and MCX. The two fixes below are separate, smaller issues
found during the same pass.


## 1. Charts — 1M / 6M / 1Y all showed roughly the same (too-short) range

### Root cause
`tfToUpstoxParams(tf)` (frontend/index.html) mapped 1M, 6M, and 1Y to the
*same* `{ unit: 'days', interval: 1 }` request with no `from` date. Without
an explicit `from`, the backend's `getHistoricalCandles()` always fell back
to its own hardcoded default (`defaultFromDate('days')` = 6 months back) —
**for every one of those three buttons**. So:

- "1Y" could never show more than ~6 months of history, no matter what —
  the backend was never even asked for a year's worth of candles.
- "6M" was then further sliced to the last 90 candles on the frontend
  (`tfToCandles`), which is only ~4.5 calendar months of trading days, so it
  under-filled its own 6-month request.
- Since this is the exact same candle-fetching code path regardless of
  which exchange is selected, the wrong range showed up identically for
  both NSE and BSE — never an exchange-specific issue.

### Fix
`tfToUpstoxParams` now sends an explicit `from` date matching each preset's
real calendar range (1M → 35 days back, 6M → 190 days back, 1Y → 370 days
back), and `fetchRealCandles` includes it in the request. `tfToCandles`'s
per-preset candle caps were raised so they no longer clip real data that's
now actually being returned (they're a safety cap, not the thing defining
the range anymore).

## 2. MCX — live quote price stops coming through after a while

### Root cause
`resolveInstrumentKey()` (backend/services/marketDataService.js) caches a
symbol's resolved Upstox `instrument_key` in the `instrument_cache` Postgres
table with no expiry. That's correct for NSE/BSE equities — an equity's
instrument_key (exchange + ISIN) never changes. It's **wrong for MCX_FO**:
a commodity resolves to its current **front-month futures contract**
(see `parseMcxInstrumentMaster`), which expires and rolls to a new contract
every month. Once a contract's instrument_key got cached, it was returned
forever — including after that contract expired — so Upstox had nothing
live left to quote against it (Upstox's `/market-quote/quotes` returns a
"success" response with an empty `data: {}` for a dead/expired contract
instrument_key rather than an error, which is why this failed silently
instead of throwing).

This affected live quotes, candles, and the screener for any MCX commodity
whose cached contract had since expired — worse the longer the app had been
deployed without a redeploy/DB change.

### Fix
`resolveInstrumentKey()` now treats a cached `MCX_FO` row as stale after 24
hours (`updated_at > now() - interval '24 hours'`), matching the in-memory
instrument-master TTL. A stale row is ignored, forcing a fresh lookup
against the (freshly-downloaded, if needed) MCX instrument master — which
always picks the current nearest-unexpired front-month contract — and
re-caches it. NSE/BSE rows are untouched and keep the old permanent-cache
behavior.

No DB migration needed — this only changes which cached rows
`resolveInstrumentKey` is willing to trust, not the schema.

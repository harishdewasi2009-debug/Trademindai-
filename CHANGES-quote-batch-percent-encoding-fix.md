# Fix: stock/index prices in the batch quotes endpoint showing stale values

## Symptom
Reliance on NSE showing e.g. 1287 when the actual live price was 1277; BSE
showing 1284 vs actual 1285. Same pattern reported on NIFTY 50, SENSEX, and
NIFTY BANK when fetched through the generic quotes endpoint.

## Root cause
`backend/services/marketDataService.js` → `getLtpBatch()` (powers
`GET /api/market/quotes`) matches each returned quote back to the symbol
that was requested by comparing Upstox's `instrument_token` to the
`instrument_key` we asked for.

Upstox sometimes echoes the token back with the pipe URL-encoded
(`NSE_EQ%7CINE002A01018`) instead of literal (`NSE_EQ|INE002A01018`).
`getIndexQuotes()` already had a fix for this exact quirk (`.replace('%7C',
'|')`), but `getLtpBatch()` did not.

When the match silently failed, the affected row fell through to
`getDailyCloseFallback()`, which is a *real* but *stale* number (yesterday's
close), not a crash — so it looked like "a slightly wrong price" rather than
an obvious error.

## Fix
`getLtpBatch()` now normalizes `%7C` → `|` before comparing tokens, in both
the primary map lookup and the loose-match fallback — matching the same
normalization `getIndexQuotes()` already does. Single-symbol quotes
(`getLtp()`) were not affected (they don't need to match against a token —
there's only one result).

## Files changed
- `backend/services/marketDataService.js`

---

# Fix: Charts showing wrong "today" close after market hours

## Symptom
Charts section not showing the correct last-close price for a stock/index
once the market has closed for the day.

## Root cause
`getHistoricalCandles()` (stocks) and `getIndexHistoricalCandles()`
(NIFTY 50/SENSEX/NIFTY BANK) both merge two Upstox endpoints:
- historical-candle — only covers *completed* sessions, and normally
  doesn't include today while the market is still open
- intraday — today's live-building candle

Both functions **unconditionally** dropped any "today" row coming back
from historical and replaced it with intraday's data, on the assumption
historical never has today. That's true while the market is open, but
once Upstox processes the day's officially settled close (after the
3:30–3:40pm closing auction), historical *does* include today — and with
the authoritative, auction-settled close price. intraday's last candle is
only the last live tick *before* the auction, which can differ from the
real settled close by a few points/paise. Since intraday always won, the
chart kept showing that pre-auction tick as "today's close" instead of
the real one.

## Fix
Both functions now check whether historical already has a row for today.
If it does, that row is trusted as-is (it's authoritative) and intraday is
not spliced in over it. intraday is only used to fill in today's candle
when historical hasn't produced it yet (i.e., during market hours).

## Files changed
- `backend/services/marketDataService.js` (`getHistoricalCandles`,
  `getIndexHistoricalCandles`)

---

# Fix: homepage NIFTY 50 hero chart still wrong after the settled-close fix

## Symptom
After deploying the previous settled-close fix, the Charts page showed the
correct last close, but the homepage hero chart (NIFTY 50) still showed the
wrong "today" price.

## Root cause
The earlier fix (`historicalHasToday`) only helps when the requested candle
granularity is **daily** — Upstox backfills "today" into its historical feed
same-day at daily granularity, but generally does NOT do so same-day for
minute/hour granularity. The homepage hero chart defaults to a 5-day /
15-minute view (`heroTF='5D'`), so `historicalHasToday` never went true for
it — it kept showing intraday's last pre-auction tick indefinitely, no
matter how long after close you looked. The Charts page happened not to
expose this because it's normally tested on daily-range views.

## Fix
Added `getSettledTodayClose()` — a small, cached, dedicated lookup that asks
Upstox specifically for **today's daily candle** (which does settle
same-day) regardless of what granularity the chart itself is drawn in.
`patchSettledCloseIntoMerged()` uses it to overwrite the last candle's close
(and extend high/low) with the officially settled price once the market is
closed — applied uniformly in both `getHistoricalCandles()` and
`getIndexHistoricalCandles()`, so it now works for every chart timeframe
(1D/5D/1M/6M/1Y, any interval), not just daily views.

## Files changed
- `backend/services/marketDataService.js`

---

# Fix: homepage NIFTY 50 hero chart lagging/mismatching the Charts section

## Symptom
Homepage NIFTY 50 chart still didn't match the Charts section's NIFTY 50
price, even after the settled-close fix.

## Root cause
The Charts section patches its on-screen candle **instantly** from the live
Upstox WebSocket feed (see the `chartFeedKey` block in `liveSocket.onmessage`).
The homepage hero chart (hardcoded to NIFTY 50) was never wired into that
feed at all — it only ever refreshed once every `CHART_REFRESH_MS` (60s) via
a REST poll. Both are ultimately sourced from Upstox, but the homepage could
sit up to a minute stale next to the Charts section's live price, which is
what looked like "different data."

## Fix
The WebSocket tick handler now also patches the homepage hero chart's last
candle (close/high/low) and the `hc-price` display directly from live ticks,
the same way the Charts section already does — so both update at the same
instant instead of the homepage lagging behind on its 60s poll.

## Files changed
- `frontend/index.html`

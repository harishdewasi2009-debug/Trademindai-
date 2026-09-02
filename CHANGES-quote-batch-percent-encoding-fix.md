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

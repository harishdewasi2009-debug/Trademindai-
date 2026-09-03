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

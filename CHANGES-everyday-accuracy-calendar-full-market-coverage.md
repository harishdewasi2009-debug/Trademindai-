# Everyday Accuracy Calendar + Full NSE/BSE/MCX Scanner Coverage

## What was asked
1. A **calendar** showing Screener signal accuracy for **every day the
   market is open**.
2. Every stock's signal should **not repeat** (one signal counted per
   stock per day).
3. **Every stock on NSE, BSE, and MCX** should be covered — not just
   whatever a user happened to look at.

## What already existed
`scannerAccuracyService.js` / `scanner_signal_history` (see
`CHANGES-scanner-signal-accuracy.md`) already logged one signal per
stock+timeframe+trading-day, deduped via a DB `UNIQUE` constraint —
requirement (2) was already solid. But two gaps remained:

- There was no day-by-day **calendar** view, only aggregate stats.
- Signals were only ever logged when a real user's browser hit
  `/api/market/signals` for that stock. Nothing guaranteed **every**
  NSE/BSE/MCX symbol got scanned on a given day — coverage silently
  depended on traffic.
- `isIndianMarketOpen()` only checked weekday + clock time, so it treated
  real exchange holidays (Holi, Diwali-Balipratipada, Republic Day, etc.)
  as open market — signals kept getting logged on days the market never
  actually traded, which would have shown up as wrong/misleading days on
  any calendar built on top of it.

## The fix

### 1. `utils/tradingCalendar.js` (new)
Official NSE 2026 trading-holiday list (from NSE circular
`NSE/CMTR/71775`, Dec 12, 2025) plus `isTradingDay()` / `isMarketHoliday()`
helpers. BSE observes the same weekday holidays; MCX is approximated with
the same list until its own circular is wired in separately (noted clearly
in the file — **this needs a yearly refresh every December**).

### 2. `marketDataService.isIndianMarketOpen()` — bug fix
Now also checks `isTradingDay()`, so scanner signals stop being logged on
real exchange holidays that happen to fall on a weekday.

### 3. `services/screenerCoverageService.js` (new)
Drives full-market coverage independent of user traffic:
- `loadUniverse(exchange)` — pages through the existing
  `marketDataService.listAllSymbols()` to get every symbol on NSE_EQ,
  BSE_EQ, and MCX_FO (cached per IST calendar day).
- `runCoverageBatch()` — each call processes up to `SCREENER_COVERAGE_BATCH_SIZE`
  (default 60) symbols that don't already have a `'1d'` signal logged for
  today, spread across NSE → BSE → MCX, with concurrency capped at 6. Runs
  through the same `getTechnicalSignal()` path a real user's Screener
  request uses, so logging/dedup behavior is identical. No-ops instantly
  outside real market hours (see fix #2).
- `getCoverageStatus()` — today's `scanned / total` per exchange, for a
  live progress indicator.
- Scheduled via `tokenScheduler.js` every 5 minutes, 9:00–15:59 IST,
  Mon–Fri — by market close, every symbol on all three exchanges has been
  scanned at least once that day, without one giant burst of requests.

### 4. `scannerAccuracyService.getScannerAccuracyCalendar({ month, year })`
Returns every day in the requested month: trading day / weekend / holiday
flag, correct/incorrect/pending/total counts, per-exchange
(NSE_EQ/BSE_EQ/MCX_FO) breakdown, distinct symbols scanned, and that day's
accuracy %.

### 5. Admin API (`adminController.js` + `adminRoutes.js`)
- `GET  /api/admin/scanner-accuracy/calendar?month=&year=`
- `GET  /api/admin/scanner-accuracy/coverage`
- `POST /api/admin/scanner-accuracy/scan-now` (manual coverage-batch trigger)

### 6. Admin panel UI (`frontend/index.html`)
New "Everyday accuracy calendar" block under the existing Scanner signal
accuracy section:
- Month grid, one cell per day — green shades for evaluated accuracy,
  amber outline for trading days still pending evaluation, grey for
  weekends/holidays, dashed for trading days with no data yet.
- Prev/next month navigation.
- Click a day to see its correct/incorrect/pending split and NSE/BSE/MCX
  breakdown.
- "Today's coverage" strip showing live `scanned/total` progress per
  exchange.

## After deploying
No new migration needed (uses the existing `scanner_signal_history`
table). Coverage scanning starts automatically the next trading session
via the new 5-minute cron; the calendar will show real data as soon as
signals are logged and evaluated (evaluation still runs at 18:00 IST, or
via "Evaluate now").

**Remember to update `utils/tradingCalendar.js` every December** with the
next calendar year's NSE/BSE/MCX holiday circular — a hardcoded 2026 list
will silently stop being accurate on Jan 1, 2027.

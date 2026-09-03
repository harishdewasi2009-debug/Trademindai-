# Scanner Signal Accuracy Tracking

## The problem
The admin panel's "Prediction accuracy" section only ever showed data from
one source: the manual, single-stock "AI Analyze" feature
(`routes/aiRoutes.js` → `prediction_history` table). The Screener/Scanner —
the rule-based bullish/bearish/neutral signal shown across all stocks
(`utils/indicators.js` `deriveSignal`, served via `getSignals` /
`getSignalsBatch` in `marketDataService.js`) — never logged anything
anywhere. So the admin accuracy dashboard reflected only occasional manual
clicks, not the day-to-day signals the Screener actually generates for
every stock, every day the market is open.

## The fix
1. **New table** `scanner_signal_history` (`db/schema.sql`) — one row per
   stock + Time Interval chip + trading day (deduped via a UNIQUE
   constraint so repeat scans within the same day don't spam the table).
2. **New service** `services/scannerAccuracyService.js`:
   - `logSignal()` — called (fire-and-forget) from
     `marketDataService.getTechnicalSignal()` every time a fresh signal is
     computed, only while `isIndianMarketOpen()`.
   - `evaluateDueScannerSignals()` — checks every signal whose horizon has
     passed against the real current price (via `getLtp`) and records
     correct/incorrect. Horizon per Time Interval chip:
     intraday chips & 1d → 1 day, 1w → 7 days, 1mo → 30, 3mo → 90,
     6mo → 182, 1y/3y/5y → capped at 365 days.
   - `getScannerAccuracyStats()` — overall accuracy, plus breakdowns by
     **every timeframe**, by signal direction, and by symbol.
   - `listAllScannerSignals()` — paginated raw log with outcome/symbol/
     timeframe/date filters.
3. **Cron**: added to the existing 18:00 IST daily job in
   `services/tokenScheduler.js`, right alongside the AI-prediction
   evaluation.
4. **Admin API** (`controllers/adminController.js` +
   `routes/adminRoutes.js`):
   - `GET  /api/admin/scanner-accuracy`
   - `POST /api/admin/scanner-accuracy/evaluate-now`
   - `GET  /api/admin/scanner-signals`
5. **Admin panel UI** (`frontend/index.html`) — new "Scanner signal
   accuracy — all stocks, all timeframes" section: overall accuracy,
   accuracy-by-timeframe bars, accuracy-by-signal bars, accuracy-by-symbol
   table, and the full paginated/filterable raw signal log.

## After deploying
Run the migration so the new table exists:
```
node backend/db/migrate.js
```
Signals start logging the next time the Screener is used during market
hours (9:15–15:30 IST, Mon–Fri). The first evaluated numbers will appear
after signals cross their horizon and the 18:00 IST job runs (or hit
"Evaluate now" in the admin panel once some rows are actually due).

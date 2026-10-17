# Verified outcomes + market instrument fixes

## 1. "Verified" never fills in (homepage shows —, "Accuracy data is being collected")
Root causes found in the evaluators (`scannerAccuracyService`, `predictionAccuracyService`):
- **One live quote call per row.** With full NSE+BSE+MCX coverage that is thousands of calls per run → Upstox rate limits →
  every failed lookup left the row `pending` forever, silently.
- **Wrong price.** Rows were judged against whatever the price was *when the cron ran*, not the price on the day they were due.
- **Wrong contract (MCX).** `GOLD`, `CRUDEOIL`… re-resolved to the *current* front-month contract, so a signal made on an
  expired contract was judged against a different one.
- **Starvation.** `ORDER BY signal_date LIMIT 1500` re-selected the same unpriceable old rows every run.

Fix:
- New `services/outcomePrice.js`: uses the **instrument_key stored at log time** (new `instrument_key` column on
  `scanner_signal_history` and `prediction_history`, added automatically by `db/autoMigrate.js`), then
  - target day not over yet → **one batched quote call per 50 instruments**,
  - target day already past → the **official daily candle close of that day**.
- Both evaluators use it, update in bulk, and write the reason a row couldn't be priced to `eval_note` (no more silent failures).
  A row still unpriceable 14 days after it was due becomes `unresolvable` (excluded from accuracy, never counted as correct).
- Scanner `signal_date` is now the IST date (was the DB server's UTC date).
- `autoMigrate` statements are independent — one that can't apply no longer blocks the rest.

## 2. Market instruments "key not working"
- **Live ticks:** the default stocks, the 3 indices and the MCX list were broadcast only under legacy keys
  (`RELIANCE`, `NIFTY 50`, `MCX:GOLD`) while the Market page listens under the instrument key → those instruments never
  ticked. Ticks are now published under both, a new viewer gets the last known tick immediately, and percent-encoded
  feed keys are decoded.
- **Registry ingest:** keys are trimmed (a stray space made the stored key differ from the one the API receives);
  values longer than their column are clipped instead of making Postgres reject a whole 2,000-row batch; keys > 120
  chars (which can't be addressed) are skipped.
- **Keys containing commas** are no longer cut in half by `/quotes?keys=…` / option-greeks, and are fetched on their own upstream.

## 3. "Verified" timeframes not working on some instruments
- The probe checked each timeframe on **one** sample instrument per segment, and the UI then **hard-disabled** that chip for
  every instrument in the segment. Now each timeframe is tried on up to 3 samples, a timeframe proven once stays proven
  (a later probe run while the market is closed / rate-limited can't erase it), and the UI only *dims* an unproven chip —
  clicking it asks Upstox live and the chart footer reports what came back.

## Tests
`npm test` → 55 passing (new: `tests/verification.test.js`).

## Deploy
Push → Render redeploys → `autoMigrate` adds the new columns on boot. Existing pending rows have no stored
instrument_key, so they are re-resolved by symbol (same as before). After deploy: Admin → "evaluate now"
(`POST /api/admin/scanner-accuracy/evaluate-now` and `/ai-accuracy/evaluate-now`) forces a pass; the response and the
server log list the reason for anything it could not price. The Upstox token must be valid (approve the 08:00 IST request).

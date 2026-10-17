// db/autoMigrate.js
// Idempotent, self-healing schema fixes that run automatically at boot and
// before the first prediction insert — so nobody has to run `node db/migrate.js`
// by hand (the app is deployed from GitHub + Render with no shell access).
// Every statement is safe to re-run.
const { query } = require('./pool');

const STATEMENTS = [
  // 'moderate_bullish' (16 chars) did not fit VARCHAR(10): every insert failed silently.
  `ALTER TABLE prediction_history ALTER COLUMN recommendation TYPE VARCHAR(30)`,
  // Remember which exchange the read was made on so MCX/BSE reads can be verified.
  `ALTER TABLE prediction_history ADD COLUMN IF NOT EXISTS exchange VARCHAR(10)`,
  // The exact Upstox instrument the read was made on. MCX symbols (GOLD, CRUDEOIL…) re-resolve to the
  // CURRENT front-month contract, so an old read must be judged against the contract it was made on.
  `ALTER TABLE prediction_history ADD COLUMN IF NOT EXISTS instrument_key VARCHAR(120)`,
  `ALTER TABLE prediction_history ADD COLUMN IF NOT EXISTS eval_note TEXT`,
  `ALTER TABLE scanner_signal_history ADD COLUMN IF NOT EXISTS instrument_key VARCHAR(120)`,
  `ALTER TABLE scanner_signal_history ADD COLUMN IF NOT EXISTS eval_note TEXT`,
  // Partial index keeps the "what is still pending?" scan cheap with ~10k signals logged per day.
  `CREATE INDEX IF NOT EXISTS idx_scanner_signal_pending ON scanner_signal_history (signal_date) WHERE outcome = 'pending'`,
];

let promise = null;
function ensure() {
  if (!promise) {
    promise = (async () => {
      // Each statement is independent: one that cannot apply (e.g. a table not created yet) must not
      // stop the others — that used to leave every later fix silently un-applied.
      for (const sql of STATEMENTS) {
        try { await query(sql); } catch (e) { console.warn('[autoMigrate] skipped one statement:', e.message, '|', sql.slice(0, 80)); }
      }
      // Scanner dedupe: UNIQUE(.., exchange, ..) treats NULL exchanges as distinct,
      // so "auto" scans were logged repeatedly. Remove repeats, then enforce uniqueness.
      const { rows } = await query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_scanner_signal_day'`);
      if (!rows.length) {
        await query(`DELETE FROM scanner_signal_history a USING scanner_signal_history b
          WHERE a.stock_symbol = b.stock_symbol AND COALESCE(a.exchange,'') = COALESCE(b.exchange,'')
            AND a.timeframe = b.timeframe AND a.signal_date = b.signal_date
            AND (a.created_at > b.created_at OR (a.created_at = b.created_at AND a.id > b.id))`);
        await query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_scanner_signal_day
          ON scanner_signal_history (stock_symbol, COALESCE(exchange,''), timeframe, signal_date)`);
      }
      console.log('[autoMigrate] schema fixes verified.');
    })().catch((e) => { promise = null; console.error('[autoMigrate] failed:', e.message); throw e; });
  }
  return promise;
}

module.exports = { ensure };

// services/scannerAccuracyService.js
// ══════════════════════════════════════════════════════════════════════════
//  Accuracy tracking for the Screener's rule-based bullish/bearish/neutral
//  signal (RSI/EMA/MACD/Supertrend/VWAP — see utils/indicators.js). This is
//  distinct from predictionAccuracyService.js, which only covers the manual
//  "AI Analyze" deep-dive on a single stock. The Screener computes a signal
//  for every stock it scans, on whichever Time Interval chip the user has
//  selected — this file logs ALL of those (deduped to one row per
//  symbol+timeframe+trading day) and checks them against real prices later,
//  so the admin panel reflects the full scanned market, not just the small
//  number of stocks someone happened to run deep AI analysis on.
//
//  Same "backward-looking analytics only" note as predictionAccuracyService:
//  nothing here is shown to end users or used to generate new signals — it's
//  an internal quality check on the Screener itself.
// ══════════════════════════════════════════════════════════════════════════

const { query } = require('../db/pool');

const NEUTRAL_BAND_PCT = 3; // same convention as predictionAccuracyService

// How far out each Screener "Time Interval" chip is checked. Intraday chips
// (1m..4h) can't be meaningfully re-checked intraday by a once-a-day cron,
// so they're evaluated at the next trading day's close. Long-horizon chips
// (3y/5y) are capped at 1 year — waiting years for an admin accuracy report
// isn't practical, so those are checked at the 1-year mark as the best
// available proxy.
const TIMEFRAME_HORIZON_DAYS = {
  '1m': 1, '5m': 1, '15m': 1, '30m': 1, '1h': 1, '4h': 1,
  '1d': 1, '1w': 7, '1mo': 30, '3mo': 90, '6mo': 182,
  '1y': 365, '3y': 365, '5y': 365,
};
function horizonDaysFor(timeframe) {
  return TIMEFRAME_HORIZON_DAYS[timeframe] || 1;
}

// Maps the Screener's descriptive strength label to the same
// bullish/bearish/neutral vocabulary predictionAccuracyService uses, so the
// same correct/incorrect rule applies consistently across both signal types.
function normalizeSignal(strengthLabel) {
  if (strengthLabel === 'Strong Bullish Bias') return 'strong_bullish';
  if (strengthLabel === 'Strong Bearish Bias') return 'strong_bearish';
  return 'neutral';
}

function judgeOutcome(signal, entryPrice, actualPrice) {
  const changePct = ((actualPrice - entryPrice) / entryPrice) * 100;
  if (signal === 'strong_bullish') return changePct > 0 ? 'correct' : 'incorrect';
  if (signal === 'strong_bearish') return changePct < 0 ? 'correct' : 'incorrect';
  return Math.abs(changePct) <= NEUTRAL_BAND_PCT ? 'correct' : 'incorrect';
}

/** Logs one scanner signal. Called (fire-and-forget) from
 *  marketDataService.getTechnicalSignal() every time a signal is freshly
 *  computed during market hours. ON CONFLICT DO NOTHING means repeated
 *  scans of the same symbol+timeframe within the same trading day only
 *  keep the first one — that's the row accuracy is checked against. */
async function logSignal({ symbol, exchange, period, derived, currentPrice }) {
  const signal = normalizeSignal(derived.strength);
  const timeframe = period || '1d';
  await query(
    `INSERT INTO scanner_signal_history
       (stock_symbol, exchange, timeframe, signal, strength_score, entry_price, horizon_days, outcome, signal_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', CURRENT_DATE)
     ON CONFLICT (stock_symbol, exchange, timeframe, signal_date) DO NOTHING`,
    [symbol, exchange || null, timeframe, signal, derived.strengthScore, currentPrice, horizonDaysFor(timeframe)]
  );
}

/** Same idea as predictionAccuracyService.evaluateDuePredictions(): finds
 *  every scanner signal whose horizon has passed and is still pending,
 *  fetches the real current price, and records correct/incorrect. Symbol
 *  lookups are deduped per run (a symbol can appear across many timeframes
 *  on the same day) to keep Upstox request volume sane. */
async function evaluateDueScannerSignals() {
  const marketDataService = require('./marketDataService'); // required lazily to avoid a require cycle
  const { rows: due } = await query(`
    SELECT id, stock_symbol, exchange, signal, entry_price, horizon_days
    FROM scanner_signal_history
    WHERE outcome = 'pending'
      AND signal_date + (horizon_days || ' days')::interval <= now()
  `);

  if (!due.length) return { evaluated: 0, failed: 0 };

  const priceCache = {}; // "SYMBOL:EXCHANGE" -> real LTP (or null if lookup failed)
  let evaluated = 0, failed = 0;

  for (const row of due) {
    const cacheKey = `${row.stock_symbol}:${row.exchange || ''}`;
    if (!(cacheKey in priceCache)) {
      try {
        const quote = await marketDataService.getLtp(row.stock_symbol, row.exchange);
        priceCache[cacheKey] = quote?.lastPrice ?? null;
      } catch (err) {
        console.warn(`[scannerAccuracy] Could not fetch real price for ${row.stock_symbol}:`, err.message);
        priceCache[cacheKey] = null;
      }
    }
    const actualPrice = priceCache[cacheKey];
    if (actualPrice == null) { failed++; continue; }

    const outcome = judgeOutcome(row.signal, Number(row.entry_price), actualPrice);
    try {
      await query(
        `UPDATE scanner_signal_history
         SET actual_price_at_horizon = $1, outcome = $2, evaluated_at = now()
         WHERE id = $3`,
        [actualPrice, outcome, row.id]
      );
      evaluated++;
    } catch (err) {
      console.error(`[scannerAccuracy] Failed to save outcome for signal ${row.id}:`, err.message);
      failed++;
    }
  }

  console.log(`[scannerAccuracy] Evaluated ${evaluated} due scanner signal(s), ${failed} failed.`);
  return { evaluated, failed };
}

/** Aggregate accuracy across the ENTIRE scanned market, for the admin
 *  dashboard: overall, broken down by timeframe (all timeframes, per your
 *  request), and by symbol. Pending (horizon not reached yet) reported
 *  separately, never guessed at. */
async function getScannerAccuracyStats() {
  const [overall, byTimeframe, bySignal, bySymbol, pendingCount] = await Promise.all([
    query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome = 'correct')::int   AS correct,
        COUNT(*) FILTER (WHERE outcome = 'incorrect')::int AS incorrect
      FROM scanner_signal_history
      WHERE outcome IN ('correct','incorrect')
    `),
    query(`
      SELECT timeframe,
        COUNT(*) FILTER (WHERE outcome = 'correct')::int   AS correct,
        COUNT(*) FILTER (WHERE outcome = 'incorrect')::int AS incorrect
      FROM scanner_signal_history
      WHERE outcome IN ('correct','incorrect')
      GROUP BY timeframe
      ORDER BY timeframe
    `),
    query(`
      SELECT signal,
        COUNT(*) FILTER (WHERE outcome = 'correct')::int   AS correct,
        COUNT(*) FILTER (WHERE outcome = 'incorrect')::int AS incorrect
      FROM scanner_signal_history
      WHERE outcome IN ('correct','incorrect')
      GROUP BY signal
      ORDER BY signal
    `),
    query(`
      SELECT stock_symbol,
        COUNT(*) FILTER (WHERE outcome = 'correct')::int   AS correct,
        COUNT(*) FILTER (WHERE outcome = 'incorrect')::int AS incorrect,
        COUNT(*)::int AS total
      FROM scanner_signal_history
      WHERE outcome IN ('correct','incorrect')
      GROUP BY stock_symbol
      HAVING COUNT(*) >= 3
      ORDER BY total DESC
      LIMIT 50
    `),
    query(`SELECT COUNT(*)::int AS count FROM scanner_signal_history WHERE outcome = 'pending'`),
  ]);

  const totalEvaluated = overall.rows[0].correct + overall.rows[0].incorrect;

  return {
    overall: {
      totalEvaluated,
      correct: overall.rows[0].correct,
      incorrect: overall.rows[0].incorrect,
      accuracyPct: totalEvaluated ? Number(((overall.rows[0].correct / totalEvaluated) * 100).toFixed(1)) : null,
    },
    byTimeframe: byTimeframe.rows.map(r => ({
      timeframe: r.timeframe,
      correct: r.correct,
      incorrect: r.incorrect,
      total: r.correct + r.incorrect,
      accuracyPct: Number(((r.correct / (r.correct + r.incorrect)) * 100).toFixed(1)),
    })),
    bySignal: bySignal.rows.map(r => ({
      signal: r.signal,
      correct: r.correct,
      incorrect: r.incorrect,
      total: r.correct + r.incorrect,
      accuracyPct: Number(((r.correct / (r.correct + r.incorrect)) * 100).toFixed(1)),
    })),
    bySymbol: bySymbol.rows.map(r => ({
      symbol: r.stock_symbol,
      correct: r.correct,
      incorrect: r.incorrect,
      total: r.total,
      accuracyPct: Number(((r.correct / r.total) * 100).toFixed(1)),
    })),
    pendingCount: pendingCount.rows[0].count,
  };
}

/** Full, paginated log of every scanner signal ever recorded — pending,
 *  correct, and incorrect — across every stock and every timeframe. */
async function listAllScannerSignals({ page = 1, limit = 50, outcome, symbol, timeframe, from, to } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;

  const conditions = [];
  const params = [];

  if (outcome && ['pending', 'correct', 'incorrect'].includes(outcome)) {
    params.push(outcome);
    conditions.push(`outcome = $${params.length}`);
  }
  if (symbol) {
    params.push(symbol.toUpperCase());
    conditions.push(`stock_symbol = $${params.length}`);
  }
  if (timeframe) {
    params.push(timeframe);
    conditions.push(`timeframe = $${params.length}`);
  }
  if (from) {
    params.push(from);
    conditions.push(`signal_date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    conditions.push(`signal_date < ($${params.length}::date + interval '1 day')`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const dataParams = [...params, safeLimit, offset];
  const { rows } = await query(
    `SELECT id, stock_symbol, exchange, timeframe, signal, strength_score, entry_price,
            horizon_days, actual_price_at_horizon, outcome, signal_date, evaluated_at, created_at
     FROM scanner_signal_history
     ${where}
     ORDER BY created_at DESC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS count FROM scanner_signal_history ${where}`,
    params
  );

  return {
    signals: rows,
    page: safePage,
    limit: safeLimit,
    total: countRows[0].count,
    totalPages: Math.max(Math.ceil(countRows[0].count / safeLimit), 1),
  };
}

module.exports = { logSignal, evaluateDueScannerSignals, getScannerAccuracyStats, listAllScannerSignals, judgeOutcome };

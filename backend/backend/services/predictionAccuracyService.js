// services/predictionAccuracyService.js
// ══════════════════════════════════════════════════════════════════════════
//  Studies the AI's own past sentiment reads (prediction_history) against
//  REAL prices fetched afterward, and turns that into an accuracy score the
//  admin panel can show across ALL users.
//
//  IMPORTANT — this is NOT the AI predicting future prices (that would need
//  SEBI Investment Adviser / Research Analyst registration). This is
//  backward-looking analytics: for a sentiment read that was logged N days
//  ago with a horizon of N days, we check what the real price actually did
//  and mark it correct/incorrect. Nothing here is shown to end users or
//  used to make new recommendations — it's an internal quality check on the
//  AI itself, using real market data end to end.
//
//  "Correct" definition (kept simple and transparent, no invented logic):
//   - strong_bullish / moderate_bullish → correct if real price rose
//   - strong_bearish / moderate_bearish → correct if real price fell
//   - neutral                          → correct if price stayed within
//                                         ±NEUTRAL_BAND_PCT of entry
// ══════════════════════════════════════════════════════════════════════════

const { query } = require('../db/pool');
const marketDataService = require('./marketDataService');

const NEUTRAL_BAND_PCT = 3; // neutral call counts as "correct" if move stayed within ±3%

function judgeOutcome(sentiment, entryPrice, actualPrice) {
  const changePct = ((actualPrice - entryPrice) / entryPrice) * 100;
  if (sentiment === 'strong_bullish' || sentiment === 'moderate_bullish') {
    return changePct > 0 ? 'correct' : 'incorrect';
  }
  if (sentiment === 'strong_bearish' || sentiment === 'moderate_bearish') {
    return changePct < 0 ? 'correct' : 'incorrect';
  }
  // 'neutral' or anything unrecognized falls back to the neutral band rule.
  return Math.abs(changePct) <= NEUTRAL_BAND_PCT ? 'correct' : 'incorrect';
}

/** Finds every prediction whose horizon has passed and is still 'pending',
 *  fetches the REAL current price for its symbol (deduping repeated symbols
 *  in one run so we don't hammer Upstox), and records correct/incorrect. */
async function evaluateDuePredictions() {
  const { rows: due } = await query(`
    SELECT id, stock_symbol, recommendation AS sentiment, entry_price, horizon_days, created_at
    FROM prediction_history
    WHERE outcome = 'pending'
      AND created_at + (horizon_days || ' days')::interval <= now()
  `);

  if (!due.length) return { evaluated: 0, failed: 0 };

  const priceCache = {}; // symbol -> real LTP (or null if lookup failed)
  let evaluated = 0, failed = 0;

  for (const row of due) {
    const sym = row.stock_symbol;
    if (!(sym in priceCache)) {
      try {
        // No exchange stored on the row — getLtp() tries NSE then BSE itself.
        const quote = await marketDataService.getLtp(sym);
        priceCache[sym] = quote?.lastPrice ?? null;
      } catch (err) {
        console.warn(`[predictionAccuracy] Could not fetch real price for ${sym}:`, err.message);
        priceCache[sym] = null;
      }
    }
    const actualPrice = priceCache[sym];
    if (actualPrice == null) { failed++; continue; }

    const outcome = judgeOutcome(row.sentiment, Number(row.entry_price), actualPrice);
    try {
      await query(
        `UPDATE prediction_history
         SET actual_price_at_horizon = $1, outcome = $2, evaluated_at = now()
         WHERE id = $3`,
        [actualPrice, outcome, row.id]
      );
      evaluated++;
    } catch (err) {
      console.error(`[predictionAccuracy] Failed to save outcome for prediction ${row.id}:`, err.message);
      failed++;
    }
  }

  console.log(`[predictionAccuracy] Evaluated ${evaluated} due prediction(s), ${failed} failed (real-price lookup or DB error).`);
  return { evaluated, failed };
}

/** Aggregate accuracy across ALL users, for the admin dashboard. Only counts
 *  predictions that have actually been evaluated against real data — pending
 *  ones (horizon not reached yet) are reported separately, never guessed at. */
async function getAccuracyStats() {
  const [overall, bySentiment, bySymbol, recentEvaluated, pendingCount] = await Promise.all([
    query(`
      SELECT
        COUNT(*) FILTER (WHERE outcome = 'correct')::int   AS correct,
        COUNT(*) FILTER (WHERE outcome = 'incorrect')::int AS incorrect
      FROM prediction_history
      WHERE outcome IN ('correct','incorrect')
    `),
    query(`
      SELECT recommendation AS sentiment,
        COUNT(*) FILTER (WHERE outcome = 'correct')::int   AS correct,
        COUNT(*) FILTER (WHERE outcome = 'incorrect')::int AS incorrect
      FROM prediction_history
      WHERE outcome IN ('correct','incorrect')
      GROUP BY recommendation
      ORDER BY recommendation
    `),
    query(`
      SELECT stock_symbol,
        COUNT(*) FILTER (WHERE outcome = 'correct')::int   AS correct,
        COUNT(*) FILTER (WHERE outcome = 'incorrect')::int AS incorrect,
        COUNT(*)::int AS total
      FROM prediction_history
      WHERE outcome IN ('correct','incorrect')
      GROUP BY stock_symbol
      HAVING COUNT(*) >= 3
      ORDER BY total DESC
      LIMIT 20
    `),
    query(`
      SELECT id, user_id, stock_symbol, recommendation AS sentiment, entry_price,
             actual_price_at_horizon, outcome, evaluated_at
      FROM prediction_history
      WHERE outcome IN ('correct','incorrect')
      ORDER BY evaluated_at DESC
      LIMIT 50
    `),
    query(`SELECT COUNT(*)::int AS count FROM prediction_history WHERE outcome = 'pending'`),
  ]);

  const totalEvaluated = overall.rows[0].correct + overall.rows[0].incorrect;

  return {
    overall: {
      totalEvaluated,
      correct: overall.rows[0].correct,
      incorrect: overall.rows[0].incorrect,
      accuracyPct: totalEvaluated ? Number(((overall.rows[0].correct / totalEvaluated) * 100).toFixed(1)) : null,
    },
    bySentiment: bySentiment.rows.map(r => ({
      sentiment: r.sentiment,
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
    recentEvaluations: recentEvaluated.rows,
    pendingCount: pendingCount.rows[0].count,
  };
}

/** Full, paginated log of EVERY prediction ever logged — pending, correct,
 *  and incorrect — across every user and every date. This is the "raw data"
 *  view for the admin panel: every sentiment read the AI ever gave a user,
 *  with the date it was made, the date (if any) it was evaluated, and the
 *  real-price outcome. Unlike getAccuracyStats() (which only aggregates
 *  already-evaluated rows), this never drops pending rows, so nothing that
 *  was ever shown to a user goes missing from the admin view.
 *
 *  Supports optional filters so the admin can narrow a long history down:
 *   - outcome: 'pending' | 'correct' | 'incorrect'
 *   - symbol:  exact stock symbol (case-insensitive)
 *   - from/to: created_at date range (ISO date strings, inclusive)
 */
async function listAllPredictions({ page = 1, limit = 50, outcome, symbol, from, to } = {}) {
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
  if (from) {
    params.push(from);
    conditions.push(`created_at >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    conditions.push(`created_at < ($${params.length}::date + interval '1 day')`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const dataParams = [...params, safeLimit, offset];
  const { rows } = await query(
    `SELECT ph.id, ph.user_id, u.email AS user_email, ph.stock_symbol,
            ph.recommendation AS sentiment, ph.entry_price, ph.target_price,
            ph.horizon_days, ph.confidence_score, ph.actual_price_at_horizon,
            ph.outcome, ph.created_at, ph.evaluated_at
     FROM prediction_history ph
     LEFT JOIN users u ON u.id = ph.user_id
     ${where}
     ORDER BY ph.created_at DESC
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS count FROM prediction_history ph ${where}`,
    params
  );

  return {
    predictions: rows,
    page: safePage,
    limit: safeLimit,
    total: countRows[0].count,
    totalPages: Math.max(Math.ceil(countRows[0].count / safeLimit), 1),
  };
}

module.exports = { evaluateDuePredictions, getAccuracyStats, listAllPredictions, judgeOutcome };

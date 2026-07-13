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

module.exports = { evaluateDuePredictions, getAccuracyStats, judgeOutcome };

// services/analysisTracker.js
// ══════════════════════════════════════════════════════════════════════════
//  Honest, outcome-based tracking of the rule-based technical reads for
//  registry instruments.
//   • RECORD   at analysis time: instrument, segment, bias, observed price,
//              timeframe, horizon (in bars) and the success criteria — all
//              frozen before the outcome is known.
//   • EVALUATE once the horizon bar has COMPLETED, using the real Upstox
//              candle close at that bar. Never earlier, never estimated.
//   • REPORT   accuracy = correct / (correct + incorrect) only. Pending and
//              unresolvable rows are counted and shown separately. Sample
//              size and evaluation window are always returned.
//  Success criteria (frozen per row, in ATR(14) units at the time of the call):
//     bullish  → correct if outcome − entry ≥ +0.25 ATR
//     bearish  → correct if outcome − entry ≤ −0.25 ATR
//     neutral  → correct if |outcome − entry| ≤ 1.0 ATR
// ══════════════════════════════════════════════════════════════════════════
const { query } = require('../db/pool');
const { ensureSchema } = require('./upstoxRegistry');
const { logError } = require('./upstoxHttp');

const STRATEGY = 'rule-based-technical-v1';
const HORIZON_BARS = 5;
const CRITERIA = { directionalMinMoveAtr: 0.25, neutralMaxMoveAtr: 1.0, horizonBars: HORIZON_BARS, outcomeBasis: 'close of the horizon candle (Upstox)' };
const UNRESOLVABLE_GRACE_DAYS = 14;
const BAR_MS = { minutes: 60e3, hours: 3600e3, days: 86400e3, weeks: 7 * 86400e3, months: 30 * 86400e3 };
const barMs = (unit, interval) => interval * (BAR_MS[unit] || 86400e3);

/** Pure: judge one outcome against frozen criteria. */
function judge(bias, entry, outcome, atr, criteria = CRITERIA) {
  if (![entry, outcome, atr].every((v) => Number.isFinite(v)) || atr <= 0) return null;
  const moveAtr = (outcome - entry) / atr;
  let ok;
  if (bias === 'bullish') ok = moveAtr >= criteria.directionalMinMoveAtr;
  else if (bias === 'bearish') ok = moveAtr <= -criteria.directionalMinMoveAtr;
  else if (bias === 'neutral') ok = Math.abs(moveAtr) <= criteria.neutralMaxMoveAtr;
  else return null;
  return { status: ok ? 'correct' : 'incorrect', moveAtr };
}

/** Pure: given ascending candles [{ts,c}], find the horizon candle for an entry candle. */
function findHorizonCandle(candles, entryTs, horizonBars, unit, interval, nowMs = Date.now()) {
  const idx = candles.findIndex((c) => c.ts === entryTs);
  if (idx === -1) return { found: false, reason: 'entry candle not present in Upstox history' };
  const h = candles[idx + horizonBars];
  if (!h) return { found: false, reason: 'horizon candle not yet formed' };
  if (h.ts + barMs(unit, interval) > nowMs) return { found: false, reason: 'horizon candle still in progress' };
  return { found: true, candle: h };
}

/** Pure: roll rows up into accuracy stats. Only correct+incorrect are "eligible". */
function summarize(rows) {
  const s = { pending: 0, unresolvable: 0, correct: 0, incorrect: 0, firstRecordedAt: null, lastEvaluatedAt: null };
  for (const r of rows) {
    if (r.status === 'pending') s.pending++;
    else if (r.status === 'unresolvable') s.unresolvable++;
    else if (r.status === 'correct') s.correct++;
    else if (r.status === 'incorrect') s.incorrect++;
    if (r.created_at && (!s.firstRecordedAt || r.created_at < s.firstRecordedAt)) s.firstRecordedAt = r.created_at;
    if (r.evaluated_at && (!s.lastEvaluatedAt || r.evaluated_at > s.lastEvaluatedAt)) s.lastEvaluatedAt = r.evaluated_at;
  }
  const eligible = s.correct + s.incorrect;
  return { ...s, eligible, total: rows.length, accuracyPct: eligible ? Number(((s.correct / eligible) * 100).toFixed(2)) : null };
}

/** Records a read. Idempotent per (instrument, strategy, timeframe, entry candle). */
async function recordAnalysis({ instrument, unit, interval, technical, lastCandleTs }) {
  if (!technical || !technical.ok) return { recorded: false, reason: 'no computable read' };
  const atr = technical.volatility && technical.volatility.atr14;
  if (!Number.isFinite(atr) || atr <= 0) return { recorded: false, reason: 'ATR unavailable — cannot define success criteria' };
  await ensureSchema();
  const r = await query(
    `INSERT INTO market_analysis_log
       (instrument_key, symbol, segment, strategy, unit, interval_n, horizon_bars, predicted_bias,
        observed_price, observed_candle_at, atr_at_call, criteria)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (instrument_key, strategy, unit, interval_n, observed_candle_at) DO NOTHING
     RETURNING id`,
    [instrument.instrumentKey, instrument.symbol, instrument.segment, STRATEGY, unit, interval, HORIZON_BARS,
      technical.bias, technical.lastClose, new Date(lastCandleTs), atr, JSON.stringify(CRITERIA)]);
  return { recorded: r.rowCount > 0, duplicate: r.rowCount === 0, strategy: STRATEGY, horizonBars: HORIZON_BARS, criteria: CRITERIA };
}

/**
 * Evaluates every pending row whose horizon could have completed.
 * `getCandlesFn(key,{unit,interval,from,to,indicators:false})` is injected (real Upstox in prod; stub in tests).
 */
async function evaluateDue(getCandlesFn, { limit = 200, nowMs = Date.now() } = {}) {
  await ensureSchema();
  const { rows } = await query(
    `SELECT * FROM market_analysis_log WHERE status = 'pending' ORDER BY created_at LIMIT $1`, [limit]);
  const out = { checked: rows.length, evaluated: 0, stillPending: 0, unresolvable: 0, errors: 0 };
  for (const row of rows) {
    const entryTs = new Date(row.observed_candle_at).getTime();
    const horizonEnd = entryTs + (row.horizon_bars + 1) * barMs(row.unit, row.interval_n);
    if (horizonEnd > nowMs) { out.stillPending++; continue; } // cannot possibly be complete yet
    try {
      const from = new Date(entryTs - 86400e3).toISOString().slice(0, 10);
      const to = new Date(nowMs).toISOString().slice(0, 10);
      const res = await getCandlesFn(row.instrument_key, { unit: row.unit, interval: row.interval_n, from, to, indicators: false });
      const candles = res.candles.map((c) => ({ ts: c.time * 1000, c: c.c }));
      const f = findHorizonCandle(candles, entryTs, row.horizon_bars, row.unit, row.interval_n, nowMs);
      if (!f.found) {
        const tooOld = nowMs - horizonEnd > UNRESOLVABLE_GRACE_DAYS * 86400e3;
        if (tooOld) {
          await query(`UPDATE market_analysis_log SET status='unresolvable', evaluated_at=now(), eval_note=$2 WHERE id=$1`, [row.id, f.reason]);
          out.unresolvable++;
        } else out.stillPending++;
        continue;
      }
      const verdict = judge(row.predicted_bias, Number(row.observed_price), f.candle.c, Number(row.atr_at_call), row.criteria);
      if (!verdict) { await query(`UPDATE market_analysis_log SET status='unresolvable', evaluated_at=now(), eval_note='invalid stored values' WHERE id=$1`, [row.id]); out.unresolvable++; continue; }
      await query(
        `UPDATE market_analysis_log SET status=$2, outcome_price=$3, outcome_candle_at=$4, move_in_atr=$5, evaluated_at=now() WHERE id=$1`,
        [row.id, verdict.status, f.candle.c, new Date(f.candle.ts), verdict.moveAtr]);
      out.evaluated++;
    } catch (e) {
      out.errors++;
      logError({ module: 'analysisTracker', kind: 'evaluate_failed', key: row.instrument_key, message: e.message });
    }
  }
  return out;
}

/** Accuracy report grouped by market (segment), strategy and timeframe. */
async function getStats({ segment } = {}) {
  await ensureSchema();
  const params = []; let where = '';
  if (segment) { params.push(segment); where = 'WHERE segment = $1'; }
  const { rows } = await query(
    `SELECT segment, strategy, unit, interval_n, predicted_bias, status, created_at, evaluated_at FROM market_analysis_log ${where}`, params);
  const group = (keyFn) => {
    const m = new Map();
    for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
    return [...m.entries()].map(([k, v]) => ({ ...JSON.parse(k), ...summarize(v) }));
  };
  return {
    criteria: CRITERIA, strategy: STRATEGY,
    note: 'Accuracy = correct ÷ (correct + incorrect). Pending and unresolvable reads are excluded and shown separately. Small samples are not statistically meaningful.',
    overall: summarize(rows),
    byMarket: group((r) => JSON.stringify({ segment: r.segment })),
    byStrategy: group((r) => JSON.stringify({ strategy: r.strategy })),
    byTimeframe: group((r) => JSON.stringify({ timeframe: `${r.interval_n} ${r.unit}` })),
    byBias: group((r) => JSON.stringify({ bias: r.predicted_bias })),
  };
}

module.exports = { STRATEGY, HORIZON_BARS, CRITERIA, judge, findHorizonCandle, summarize, recordAnalysis, evaluateDue, getStats, barMs };

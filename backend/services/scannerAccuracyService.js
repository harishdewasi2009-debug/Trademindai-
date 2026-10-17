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
const { isTradingDay, isMarketHoliday } = require('../utils/tradingCalendar');

const istParts = (now = new Date()) => { const ist = new Date(now.getTime() + 5.5 * 3600e3); return { date: ist.toISOString().slice(0, 10), minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes() }; };
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** First trading day on/after signalDate + horizonDays (and strictly after signalDate). */
function targetTradingDay(signalDate, horizonDays) {
  let d = addDays(signalDate, Math.max(1, horizonDays));
  for (let i = 0; i < 10 && !isTradingDay(d); i++) d = addDays(d, 1);
  return d;
}
/** A signal is due once its target day's session has closed (15:45 IST; MCX 23:35 IST). */
function isSignalDue(signalDate, horizonDays, exchange, now = new Date()) {
  const target = targetTradingDay(signalDate, horizonDays);
  const { date, minutes } = istParts(now);
  if (date > target) return true;
  if (date < target) return false;
  return minutes >= (exchange === 'MCX_FO' ? 23 * 60 + 35 : 15 * 60 + 45);
}

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
  await require('../db/autoMigrate').ensure().catch(() => {}); // adds instrument_key/eval_note if missing
  // Remember the EXACT instrument (MCX symbols roll to a new front-month contract) so the outcome is
  // judged against the contract the signal was made on. Cached lookup; never blocks the log.
  let instrumentKey = null;
  try { instrumentKey = await require('./marketDataService').resolveInstrumentKey(symbol, exchange || undefined); } catch { /* evaluator re-resolves */ }
  await query(
    `INSERT INTO scanner_signal_history
       (stock_symbol, exchange, timeframe, signal, strength_score, entry_price, horizon_days, outcome, signal_date, instrument_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', (now() AT TIME ZONE 'Asia/Kolkata')::date, $8)
     ON CONFLICT DO NOTHING`,
    [symbol, exchange || null, timeframe, signal, derived.strengthScore, currentPrice, horizonDaysFor(timeframe), instrumentKey]
  );
}

/** Judges every scanner signal whose target trading day has closed.
 *  Price = the real close of the TARGET day (one batched quote call right after the close, the official daily
 *  candle afterwards) — never "whatever the price is when the cron happens to run".
 *  A row that cannot be priced stays pending with the reason in eval_note, and is only given up on
 *  (outcome 'unresolvable', excluded from accuracy) once it is UNRESOLVABLE_AFTER_DAYS past due. */
const UNRESOLVABLE_AFTER_DAYS = 14;
const DAY_MS = 86400e3;

async function evaluateDueScannerSignals({ limit = 6000, now = new Date() } = {}) {
  const { fetchOutcomePrices, istDate } = require('./outcomePrice');
  await require('../db/autoMigrate').ensure().catch(() => {});
  let { rows: due } = await query(`
    SELECT id, stock_symbol, exchange, instrument_key, signal, entry_price, horizon_days, signal_date::text AS signal_date
    FROM scanner_signal_history
    WHERE outcome = 'pending'
      AND signal_date + horizon_days <= (now() AT TIME ZONE 'Asia/Kolkata')::date
    ORDER BY signal_date, created_at
    LIMIT $1
  `, [limit]);
  due = due.filter((r) => isSignalDue(r.signal_date, r.horizon_days, r.exchange, now));
  if (!due.length) return { evaluated: 0, failed: 0, unresolvable: 0 };

  const items = due.map((r) => ({
    id: r.id, symbol: r.stock_symbol, exchange: r.exchange, instrumentKey: r.instrument_key,
    targetDate: targetTradingDay(r.signal_date, r.horizon_days), exact: true,
  }));
  const prices = await fetchOutcomePrices(items, { today: istDate(now) });

  const done = { ids: [], prices: [], outcomes: [] };
  const giveUp = [];
  const notes = new Map(); // reason → [ids]
  let failed = 0;
  due.forEach((row, i) => {
    const p = prices.get(row.id);
    if (p && p.price != null && Number(row.entry_price) > 0) {
      done.ids.push(row.id); done.prices.push(p.price); done.outcomes.push(judgeOutcome(row.signal, Number(row.entry_price), p.price));
      return;
    }
    failed++;
    const reason = String((p && p.error) || 'no price available').slice(0, 200);
    const daysPast = (now.getTime() - new Date(items[i].targetDate + 'T00:00:00Z').getTime()) / DAY_MS;
    if (daysPast > UNRESOLVABLE_AFTER_DAYS) giveUp.push({ id: row.id, reason });
    else { if (!notes.has(reason)) notes.set(reason, []); notes.get(reason).push(row.id); }
  });

  for (let i = 0; i < done.ids.length; i += 500) {
    await query(
      `UPDATE scanner_signal_history t SET actual_price_at_horizon = v.p, outcome = v.o, evaluated_at = now(), eval_note = NULL
         FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::numeric[]) AS p, unnest($3::text[]) AS o) v
        WHERE t.id = v.id AND t.outcome = 'pending'`,
      [done.ids.slice(i, i + 500), done.prices.slice(i, i + 500), done.outcomes.slice(i, i + 500)]);
  }
  for (const g of giveUp) {
    await query(`UPDATE scanner_signal_history SET outcome = 'unresolvable', evaluated_at = now(), eval_note = $2 WHERE id = $1 AND outcome = 'pending'`, [g.id, g.reason]);
  }
  for (const [reason, ids] of notes) {
    await query(`UPDATE scanner_signal_history SET eval_note = $2 WHERE id = ANY($1::uuid[]) AND outcome = 'pending'`, [ids, reason]);
  }

  const summary = { evaluated: done.ids.length, failed, unresolvable: giveUp.length };
  console.log(`[scannerAccuracy] Evaluated ${summary.evaluated} due scanner signal(s); ${failed} could not be priced yet (${giveUp.length} given up).` +
    (notes.size ? ' Reasons: ' + [...notes].map(([r, ids]) => `${r} ×${ids.length}`).join('; ') : ''));
  return summary;
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

/** Day-by-day accuracy for one calendar month, for the admin "everyday
 *  accuracy" calendar view. Every day in the month gets an entry — trading
 *  days with no logged signals yet (market open but nothing scanned/
 *  evaluated), weekends, and published exchange holidays are all
 *  distinguished, not just lumped together as "no data". Coverage is also
 *  broken out per exchange (NSE_EQ/BSE_EQ/MCX_FO) so it's visible at a
 *  glance whether a given day's scan actually reached all three markets. */
async function getScannerAccuracyCalendar({ month, year } = {}) {
  const now = new Date();
  const y = Number(year) || now.getFullYear();
  const m = Number(month) || now.getMonth() + 1; // 1-12, matches the API's month param
  if (m < 1 || m > 12) throw new Error('month must be between 1 and 12');

  const pad = (n) => String(n).padStart(2, '0');
  const monthStart = `${y}-${pad(m)}-01`;
  const nextMonthStart = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;

  const { rows } = await query(
    `SELECT
       signal_date::text AS date,
       COUNT(*) FILTER (WHERE outcome = 'correct')::int   AS correct,
       COUNT(*) FILTER (WHERE outcome = 'incorrect')::int AS incorrect,
       COUNT(*) FILTER (WHERE outcome = 'pending')::int   AS pending,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE exchange = 'NSE_EQ')::int AS nse,
       COUNT(*) FILTER (WHERE exchange = 'BSE_EQ')::int AS bse,
       COUNT(*) FILTER (WHERE exchange = 'MCX_FO')::int AS mcx,
       COUNT(DISTINCT stock_symbol)::int AS symbols_scanned
     FROM scanner_signal_history
     WHERE signal_date >= $1::date AND signal_date < $2::date
     GROUP BY signal_date`,
    [monthStart, nextMonthStart]
  );
  const byDate = new Map(rows.map((r) => [r.date, r]));

  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = [];
  let monthCorrect = 0, monthIncorrect = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const date = `${y}-${pad(m)}-${pad(d)}`;
    const row = byDate.get(date);
    const evaluated = row ? row.correct + row.incorrect : 0;
    monthCorrect += row?.correct || 0;
    monthIncorrect += row?.incorrect || 0;

    days.push({
      date,
      isTradingDay: isTradingDay(date),
      isHoliday: isMarketHoliday(date),
      hasData: !!row,
      correct: row?.correct || 0,
      incorrect: row?.incorrect || 0,
      pending: row?.pending || 0,
      total: row?.total || 0,
      symbolsScanned: row?.symbols_scanned || 0,
      accuracyPct: evaluated ? Number(((row.correct / evaluated) * 100).toFixed(1)) : null,
      byExchange: {
        NSE_EQ: row?.nse || 0,
        BSE_EQ: row?.bse || 0,
        MCX_FO: row?.mcx || 0,
      },
    });
  }

  const monthEvaluated = monthCorrect + monthIncorrect;
  return {
    year: y,
    month: m,
    monthAccuracyPct: monthEvaluated ? Number(((monthCorrect / monthEvaluated) * 100).toFixed(1)) : null,
    days,
  };
}

module.exports = {
  UNRESOLVABLE_AFTER_DAYS,
  logSignal,
  evaluateDueScannerSignals,
  getScannerAccuracyStats,
  listAllScannerSignals,
  getScannerAccuracyCalendar,
  judgeOutcome,
  targetTradingDay,
  isSignalDue,
};

// services/publicAccuracyService.js
// ══════════════════════════════════════════════════════════════════════════
//  PUBLIC, read-only accuracy aggregates for the homepage.
//
//  Rules (documented so the numbers are auditable):
//   - Sources: prediction_history, scanner_signal_history and market_analysis_log rows already judged against REAL prices by
//     predictionAccuracyService.evaluateDuePredictions(). Nothing is random,
//     hardcoded or adjusted here.
//   - Only predictions CREATED on/after PUBLIC_ACCURACY_START_DATE (the
//     TradeMind AI launch day, default 2026-08-16) are counted. Anything
//     earlier (tests, seed data) is never exposed.
//   - Overall  = correct / (correct + incorrect) × 100
//   - Today    = same formula over predictions whose outcome was verified
//                today (IST calendar day).
//   - Pending predictions never enter the accuracy denominator.
//   - Rows with any other outcome (NULL / unknown) are ignored.
//   - Daily series has ONE entry for every calendar day from the start date
//     to today (IST) — a new day appears automatically each day. Days with
//     no verified predictions have accuracy = null (never 0%).
//   - Daily goal: target = most recent earlier verified day's accuracy + 5
//     percentage points. It is a goal only; real accuracy is never altered.
//  Only aggregates + timestamps leave this module — no user ids, symbols or
//  individual predictions.
// ══════════════════════════════════════════════════════════════════════════
const { query } = require('../db/pool');

const START_DATE = /^\d{4}-\d{2}-\d{2}$/.test(process.env.PUBLIC_ACCURACY_START_DATE || '')
  ? process.env.PUBLIC_ACCURACY_START_DATE
  : '2026-08-16';
const GOAL_STEP_PP = 5;
const CACHE_MS = 60 * 1000;
const STALE_AFTER_MS = 36 * 60 * 60 * 1000; // no verification for 36h → flagged stale

let cache = { at: 0, data: null };

const pct = (c, i) => (c + i > 0 ? Number(((c / (c + i)) * 100).toFixed(2)) : null);
const round2 = (n) => Number(n.toFixed(2));

function istToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()); // YYYY-MM-DD
}

function eachDay(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

// Every verified source is judged against REAL prices by its own evaluator:
//   prediction_history       – AI Analyze reads (horizon 7/30/90 days)
//   scanner_signal_history   – Screener signals, whole market (horizon ≥ 1 trading day)
//   market_analysis_log      – registry technical reads (horizon 5 bars)
// A source that is missing or errors is skipped, never fatal.
const SOURCES = [
  { name: 'ai_analysis', table: 'prediction_history', outcome: 'outcome', created: 'created_at' },
  { name: 'screener', table: 'scanner_signal_history', outcome: 'outcome', created: 'created_at' },
  { name: 'registry', table: 'market_analysis_log', outcome: 'status', created: 'created_at' },
];

async function querySource(src) {
  const o = src.outcome, c = src.created;
  const [daily, pending, last] = await Promise.all([
    query(
      `SELECT (evaluated_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
              COUNT(*) FILTER (WHERE ${o} = 'correct')::int   AS correct,
              COUNT(*) FILTER (WHERE ${o} = 'incorrect')::int AS incorrect
         FROM ${src.table}
        WHERE ${o} IN ('correct','incorrect') AND evaluated_at IS NOT NULL
          AND (${c} AT TIME ZONE 'Asia/Kolkata')::date >= $1::date
        GROUP BY 1`, [START_DATE]),
    query(
      `SELECT COUNT(*)::int AS n FROM ${src.table}
        WHERE ${o} = 'pending' AND (${c} AT TIME ZONE 'Asia/Kolkata')::date >= $1::date`, [START_DATE]),
    query(
      `SELECT MAX(evaluated_at) AS at FROM ${src.table}
        WHERE ${o} IN ('correct','incorrect') AND (${c} AT TIME ZONE 'Asia/Kolkata')::date >= $1::date`, [START_DATE]),
  ]);
  return { daily: daily.rows, pending: pending.rows[0].n, last: last.rows[0].at };
}

// Opportunistic catch-up: on a sleeping/free host the 18:00 cron can be missed.
// Evaluators only touch rows whose horizon has really passed, so this is safe.
let lastCatchUp = 0;
function maybeCatchUp() {
  if (Date.now() - lastCatchUp < 15 * 60 * 1000) return;
  lastCatchUp = Date.now();
  require('./predictionAccuracyService').evaluateDuePredictions().catch((e) => console.warn('[publicAccuracy] catch-up (predictions):', e.message));
  require('./scannerAccuracyService').evaluateDueScannerSignals().catch((e) => console.warn('[publicAccuracy] catch-up (scanner):', e.message));
  require('./analysisTracker').evaluateDue((k, o) => require('./instrumentData').getCandles(k, o)).catch((e) => console.warn('[publicAccuracy] catch-up (registry):', e.message));
}

async function compute() {
  const today = istToday();
  try { await require('../db/autoMigrate').ensure(); } catch (e) { /* reported by autoMigrate */ }
  try { await require('./upstoxRegistry').ensureSchema(); } catch (e) { /* registry log table may not exist yet */ }

  const results = await Promise.allSettled(SOURCES.map(querySource));
  const merged = new Map();
  let pendingTotal = 0, lastAt = null;
  const bySource = {};
  results.forEach((r, i) => {
    const name = SOURCES[i].name;
    if (r.status !== 'fulfilled') { console.warn(`[publicAccuracy] source ${name} skipped:`, r.reason && r.reason.message); bySource[name] = { error: true }; return; }
    let v = 0;
    for (const row of r.value.daily) {
      const m = merged.get(row.day) || { day: row.day, correct: 0, incorrect: 0 };
      m.correct += row.correct; m.incorrect += row.incorrect; merged.set(row.day, m);
      v += row.correct + row.incorrect;
    }
    pendingTotal += r.value.pending;
    if (r.value.last && (!lastAt || new Date(r.value.last) > new Date(lastAt))) lastAt = r.value.last;
    bySource[name] = { verified: v, pending: r.value.pending };
  });
  const daily = { rows: [...merged.values()] };
  const pending = { rows: [{ n: pendingTotal }] };
  const last = { rows: [{ at: lastAt }] };

  const byDay = new Map(daily.rows.map(r => [r.day, r]));
  let totalC = 0, totalI = 0;
  daily.rows.forEach(r => { totalC += r.correct; totalI += r.incorrect; });
  const verified = totalC + totalI;

  // One entry per calendar day, start date → today. Never earlier.
  const series = eachDay(START_DATE, today).map(day => {
    const r = byDay.get(day);
    const c = r ? r.correct : 0, i = r ? r.incorrect : 0;
    return { date: day, verified: c + i, accuracy: pct(c, i) };
  });

  const todayRow = series[series.length - 1];
  const todayAcc = todayRow ? todayRow.accuracy : null;

  // Most recent EARLIER day with verified results (used only for the goal).
  let prevAcc = null;
  for (let k = series.length - 2; k >= 0; k--) {
    if (series[k].accuracy != null) { prevAcc = series[k].accuracy; break; }
  }

  let goal = { available: false };
  if (prevAcc != null) {
    const target = Math.min(100, round2(prevAcc + GOAL_STEP_PP));
    const change = todayAcc != null ? round2(todayAcc - prevAcc) : null;
    const progress = change != null
      ? Math.max(0, Math.min(100, round2((change / GOAL_STEP_PP) * 100)))
      : null;
    goal = { available: true, stepPp: GOAL_STEP_PP, targetAccuracy: target, todayAccuracy: todayAcc, changePp: change, progressPct: progress };
  }

  const lastVerifiedAt = last.rows[0].at ? new Date(last.rows[0].at).toISOString() : null;
  const stale = lastVerifiedAt ? Date.now() - new Date(lastVerifiedAt).getTime() > STALE_AFTER_MS : false;

  return {
    available: verified > 0,
    startDate: START_DATE,
    today,
    overall: { accuracy: pct(totalC, totalI), verified },
    todayStats: {
      accuracy: todayAcc,
      verified: todayRow ? todayRow.verified : 0,
      changePp: goal.available && todayAcc != null ? round2(todayAcc - prevAcc) : null,
    },
    pending: pending.rows[0].n,
    sources: bySource,
    goal,
    daily: series,
    lastVerifiedAt,
    generatedAt: new Date().toISOString(),
    stale,
  };
}

async function getPublicAccuracy() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  maybeCatchUp();
  const data = await compute();
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { getPublicAccuracy, GOAL_STEP_PP, maybeCatchUp };

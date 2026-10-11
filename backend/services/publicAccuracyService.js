// services/publicAccuracyService.js
// ══════════════════════════════════════════════════════════════════════════
//  PUBLIC, read-only accuracy aggregates for the homepage.
//
//  Rules (documented so the numbers are auditable):
//   - Source: prediction_history rows already judged against REAL prices by
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

async function compute() {
  const today = istToday();

  const [daily, pending, last] = await Promise.all([
    query(
      `SELECT (evaluated_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
              COUNT(*) FILTER (WHERE outcome = 'correct')::int   AS correct,
              COUNT(*) FILTER (WHERE outcome = 'incorrect')::int AS incorrect
         FROM prediction_history
        WHERE outcome IN ('correct','incorrect')
          AND evaluated_at IS NOT NULL
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= $1::date
        GROUP BY 1`,
      [START_DATE]
    ),
    query(
      `SELECT COUNT(*)::int AS n FROM prediction_history
        WHERE outcome = 'pending'
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= $1::date`,
      [START_DATE]
    ),
    query(
      `SELECT MAX(evaluated_at) AS at FROM prediction_history
        WHERE outcome IN ('correct','incorrect')
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date >= $1::date`,
      [START_DATE]
    ),
  ]);

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
    goal,
    daily: series,
    lastVerifiedAt,
    generatedAt: new Date().toISOString(),
    stale,
  };
}

async function getPublicAccuracy() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const data = await compute();
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { getPublicAccuracy, GOAL_STEP_PP };

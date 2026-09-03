// utils/seasonalityEngine.js
// ══════════════════════════════════════════════════════════════════════════
//  Calendar-effect statistics computed from REAL candle timestamps — day-
//  of-week and month-of-year average returns, purely descriptive summaries
//  of what has historically happened on this instrument. Needs candles with
//  a real `t` (ISO timestamp) field, which every candle in this codebase
//  already carries. Small samples are flagged rather than hidden, since a
//  "best day" computed from 4 data points is not the same claim as one
//  computed from 400.
// ══════════════════════════════════════════════════════════════════════════

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function groupReturnsBy(candles, keyFn) {
  const buckets = {};
  for (let i = 1; i < candles.length; i++) {
    if (!candles[i].t || !candles[i - 1].c) continue;
    const ret = (candles[i].c - candles[i - 1].c) / candles[i - 1].c;
    const key = keyFn(new Date(candles[i].t));
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(ret);
  }
  return buckets;
}

function summarise(buckets, labels) {
  return Object.entries(buckets).map(([key, rets]) => {
    const avgPct = Number(((rets.reduce((a, b) => a + b, 0) / rets.length) * 100).toFixed(3));
    const positiveCount = rets.filter((r) => r > 0).length;
    return {
      label: labels ? labels[Number(key)] : key,
      sampleSize: rets.length,
      avgReturnPct: avgPct,
      positiveRatePct: Number(((positiveCount / rets.length) * 100).toFixed(1)),
      reliability: rets.length >= 30 ? 'Adequate sample' : rets.length >= 10 ? 'Small sample — treat cautiously' : 'Very small sample — not statistically meaningful',
    };
  });
}

/** Requires DAILY candles (day-of-week is meaningless on intraday bars). */
function calcDayOfWeekSeasonality(candles) {
  const buckets = groupReturnsBy(candles, (d) => d.getUTCDay());
  const rows = summarise(buckets, DAY_NAMES).filter((r) => r.label !== 'Sunday' && r.label !== 'Saturday');
  const sorted = [...rows].sort((a, b) => b.avgReturnPct - a.avgReturnPct);
  return {
    byDay: rows,
    bestDay: sorted[0] || null,
    worstDay: sorted[sorted.length - 1] || null,
  };
}

function calcMonthlySeasonality(candles) {
  const buckets = groupReturnsBy(candles, (d) => d.getUTCMonth());
  const rows = summarise(buckets, MONTH_NAMES);
  const sorted = [...rows].sort((a, b) => b.avgReturnPct - a.avgReturnPct);
  return {
    byMonth: rows,
    bestMonth: sorted[0] || null,
    worstMonth: sorted[sorted.length - 1] || null,
  };
}

module.exports = { calcDayOfWeekSeasonality, calcMonthlySeasonality };

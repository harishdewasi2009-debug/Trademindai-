// utils/candleUtils.js
// ══════════════════════════════════════════════════════════════════════════
//  Pure candle helpers for Upstox V3 historical/intraday responses.
// ══════════════════════════════════════════════════════════════════════════

// Interval rules for the V3 historical-candle API as documented by Upstox:
// minutes 1–300, hours 1–5, days/weeks/months interval 1. These bounds are
// enforced up front so a bad request fails fast with a clear 400 instead of
// burning a rate-limited upstream call. (If Upstox widens them, change here.)
const UNIT_RULES = {
  minutes: { min: 1, max: 300 },
  hours:   { min: 1, max: 5 },
  days:    { min: 1, max: 1 },
  weeks:   { min: 1, max: 1 },
  months:  { min: 1, max: 1 },
};

// Maximum look-back per request, in days, by unit/interval (Upstox limits the
// date window per call: ~1 month for ≤15-minute bars, ~1 quarter for larger
// minute/hour bars, ~1 decade for daily and above). `from` is clamped to this.
function maxRangeDays(unit, interval) {
  if (unit === 'minutes') return interval <= 15 ? 30 : 90;
  if (unit === 'hours') return 90;
  return 3650;
}

function validateTimeframe(unit, interval) {
  const rule = UNIT_RULES[unit];
  if (!rule) return `unit must be one of: ${Object.keys(UNIT_RULES).join(', ')}`;
  if (!Number.isInteger(interval) || interval < rule.min || interval > rule.max) {
    return `interval for ${unit} must be an integer from ${rule.min} to ${rule.max}`;
  }
  return null;
}

const isIntradayUnit = (unit) => unit === 'minutes' || unit === 'hours';

/** Parses candles as [timestamp, o, h, l, c, v, oi] rows → oldest-first {t,o,h,l,c,v,oi}. Drops malformed rows. */
function normalizeCandleRows(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  let dropped = 0;
  const out = [];
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== 'string') { dropped++; continue; }
    const [t, o, h, l, c, v, oi] = r;
    const ts = Date.parse(t);
    const ok = [o, h, l, c].every((x) => typeof x === 'number' && Number.isFinite(x)) && Number.isFinite(ts);
    // Guard against rows that violate basic OHLC invariants — those are
    // corrupt data, and drawing them would distort every indicator.
    if (!ok || h < l || h < Math.max(o, c) - 1e-9 || l > Math.min(o, c) + 1e-9) { dropped++; continue; }
    out.push({
      t, ts,
      o, h, l, c,
      v: typeof v === 'number' && Number.isFinite(v) ? v : null,
      oi: typeof oi === 'number' && Number.isFinite(oi) ? oi : null,
    });
  }
  out.sort((a, b) => a.ts - b.ts); // Upstox sends newest-first; charts need oldest-first
  return { candles: out, dropped };
}

/** Merges historical + intraday candles, de-duplicating by timestamp (intraday wins). */
function mergeCandles(historical, intraday) {
  const map = new Map();
  for (const c of historical) map.set(c.ts, c);
  for (const c of intraday) map.set(c.ts, c);
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

module.exports = { UNIT_RULES, maxRangeDays, validateTimeframe, isIntradayUnit, normalizeCandleRows, mergeCandles };

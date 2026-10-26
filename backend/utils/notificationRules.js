// utils/notificationRules.js
// Pure, dependency-free decision logic for the notification engine, so it can
// be unit-tested without a database or market-data connection.

const MOVE_LEVELS = [3, 5, 7, 10, 15, 20];          // stock % milestones
const MCX_LEVELS = [2, 3, 5, 10];                   // commodity % milestones (they move less than small caps)
const SECTOR_LEVELS = [1, 2, 3, 4, 6];              // sector-average % milestones
const PNL_LEVELS = [10, 20, 30, 50, 100];           // portfolio P&L % milestones
const MIN_SECTOR_BREADTH = 0.6;                     // share of stocks moving the same way
const MIN_SECTOR_STOCKS = 3;

const DEFAULT_PREFS = Object.freeze({
  in_app: true, email: false, push: false,
  watchlist: true, portfolio: true, price_alerts: true,
  screener: true, sector_heat: true, top_movers: true, mcx: true,
  move_threshold: 5, sector_threshold: 2, watchlist_threshold: 3, min_signal_score: 80,
});

/** Highest milestone in `levels` that |pct| has reached, or null. */
function highestLevel(absPct, levels) {
  let hit = null;
  for (const l of levels) if (absPct >= l) hit = l;
  return hit;
}

/** { level, dir } for a stock's day change, or null if it has not reached the first milestone. */
function moveMilestone(changePct, levels = MOVE_LEVELS) {
  if (typeof changePct !== 'number' || !Number.isFinite(changePct)) return null;
  const level = highestLevel(Math.abs(changePct), levels);
  return level == null ? null : { level, dir: changePct > 0 ? 'up' : 'down' };
}

/** Portfolio P&L milestone from buy price; +10%, -10% etc. */
function pnlMilestone(buyPrice, price) {
  if (!(buyPrice > 0) || !(price > 0)) return null;
  const pct = ((price - buyPrice) / buyPrice) * 100;
  const level = highestLevel(Math.abs(pct), PNL_LEVELS);
  return level == null ? null : { level, dir: pct > 0 ? 'up' : 'down', pct };
}

/** Has a watchlist price alert been crossed? Directions: 'above' | 'below'. */
function priceAlertTriggered(alertPrice, direction, price) {
  const target = Number(alertPrice);
  if (!(target > 0) || !(price > 0)) return false;
  if (direction === 'above') return price >= target;
  if (direction === 'below') return price <= target;
  return false;
}

/**
 * quotes: [{ symbol, changePct }] → [{ sector, avg, breadth, count, dir, level, leaders }]
 * Only sectors with enough stocks and one-directional breadth qualify.
 */
function computeSectorHeat(quotes, symbolSector, levels = SECTOR_LEVELS) {
  const buckets = {};
  for (const q of quotes) {
    const sector = symbolSector[q.symbol];
    if (!sector || typeof q.changePct !== 'number' || !Number.isFinite(q.changePct)) continue;
    (buckets[sector] ||= []).push(q);
  }
  const out = [];
  for (const [sector, list] of Object.entries(buckets)) {
    if (list.length < MIN_SECTOR_STOCKS) continue;
    const avg = list.reduce((a, q) => a + q.changePct, 0) / list.length;
    const dir = avg > 0 ? 'up' : 'down';
    const same = list.filter((q) => (dir === 'up' ? q.changePct > 0 : q.changePct < 0)).length;
    const breadth = same / list.length;
    const level = highestLevel(Math.abs(avg), levels);
    if (level == null || breadth < MIN_SECTOR_BREADTH) continue;
    const leaders = [...list]
      .sort((a, b) => (dir === 'up' ? b.changePct - a.changePct : a.changePct - b.changePct))
      .slice(0, 3)
      .map((q) => ({ symbol: q.symbol, changePct: q.changePct }));
    out.push({ sector, avg, breadth, count: list.length, dir, level, leaders });
  }
  return out.sort((a, b) => Math.abs(b.avg) - Math.abs(a.avg));
}

/** Screener signal worth notifying? signal: strong_bullish | strong_bearish | neutral */
function screenerQualifies(signal, score, minScore) {
  if (signal !== 'strong_bullish' && signal !== 'strong_bearish') return false;
  return Number(score) >= Number(minScore);
}

const istDate = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const fmtPct = (n) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtPrice = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

module.exports = {
  MOVE_LEVELS, MCX_LEVELS, SECTOR_LEVELS, PNL_LEVELS, DEFAULT_PREFS,
  highestLevel, moveMilestone, pnlMilestone, priceAlertTriggered,
  computeSectorHeat, screenerQualifies, istDate, fmtPct, fmtPrice,
};

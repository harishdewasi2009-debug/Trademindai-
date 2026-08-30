// utils/microstructureEngine.js
// ══════════════════════════════════════════════════════════════════════════
//  Statistics about HOW a stock tends to move (trending vs mean-reverting,
//  liquid vs thin, where volume actually transacted) — all computed from
//  real OHLCV candles. These describe the instrument's own historical
//  behaviour; they are not predictions of what it will do next.
// ══════════════════════════════════════════════════════════════════════════

const stats = require('./statsEngine');

/** Lag-1 autocorrelation of returns. Positive = today's move tends to be
 *  followed by a similar move (momentum/trending behaviour). Negative =
 *  today's move tends to be followed by the opposite (mean-reverting
 *  behaviour). Near zero = close to a random walk. */
function calcAutocorrelation(returns, lag = 1) {
  const n = returns.length - lag;
  if (n < 10) return null;
  const a = returns.slice(0, n), b = returns.slice(lag, lag + n);
  return stats.correlation(a, b);
}

/** Hurst exponent via rescaled-range (R/S) analysis over several chunk
 *  sizes. H ~ 0.5 => random walk. H > 0.5 => trending/persistent series.
 *  H < 0.5 => mean-reverting/anti-persistent series. This is a real,
 *  standard estimator (not exact for short series — hence the minimum
 *  length gate and the explicit reliability note). */
function calcHurstExponent(closes) {
  const rets = stats.logReturns(closes);
  if (rets.length < 100) return { hurst: null, note: 'Need at least ~100 real bars for a meaningful Hurst estimate.' };

  const chunkSizes = [10, 20, 30, 50, 75, 100].filter((s) => s <= rets.length / 2);
  const points = [];
  for (const size of chunkSizes) {
    const numChunks = Math.floor(rets.length / size);
    if (numChunks < 2) continue;
    const rsValues = [];
    for (let c = 0; c < numChunks; c++) {
      const chunk = rets.slice(c * size, (c + 1) * size);
      const m = stats.mean(chunk);
      const deviations = chunk.map((r) => r - m);
      let cum = 0;
      const cumulative = deviations.map((d) => (cum += d));
      const range = Math.max(...cumulative) - Math.min(...cumulative);
      const sd = stats.stdev(chunk, false);
      if (sd) rsValues.push(range / sd);
    }
    if (rsValues.length) points.push({ logSize: Math.log(size), logRS: Math.log(stats.mean(rsValues)) });
  }
  if (points.length < 3) return { hurst: null, note: 'Not enough chunk sizes fit this history length.' };

  // Simple least-squares slope of log(R/S) vs log(chunk size) = Hurst exponent.
  const mx = stats.mean(points.map((p) => p.logSize));
  const my = stats.mean(points.map((p) => p.logRS));
  let num = 0, den = 0;
  points.forEach((p) => { num += (p.logSize - mx) * (p.logRS - my); den += (p.logSize - mx) ** 2; });
  const hurst = den ? num / den : null;

  return {
    hurst: hurst != null ? Number(hurst.toFixed(3)) : null,
    interpretation: hurst == null ? 'Unavailable'
      : hurst > 0.55 ? 'Trending / persistent — moves have historically tended to continue.'
      : hurst < 0.45 ? 'Mean-reverting / anti-persistent — moves have historically tended to reverse.'
      : 'Close to a random walk — little historical persistence either way.',
  };
}

/** How many standard deviations current price sits from its own N-period
 *  moving average — a standard mean-reversion gauge (Bollinger's
 *  underlying idea, generalised to any lookback). Not a signal by itself;
 *  reported alongside the Hurst read so a large z-score is only framed as
 *  "reversion-prone" when the series itself behaves that way historically. */
function calcMeanReversionZScore(closes, period = 20) {
  if (closes.length < period + 1) return null;
  const window = closes.slice(-period);
  const m = stats.mean(window);
  const sd = stats.stdev(window, false);
  if (!sd) return null;
  const z = (closes[closes.length - 1] - m) / sd;
  return {
    zScore: Number(z.toFixed(2)),
    mean: Number(m.toFixed(2)),
    reading: Math.abs(z) >= 2 ? `${z > 0 ? 'Well above' : 'Well below'} its ${period}-period average (|z| ≥ 2).`
      : Math.abs(z) >= 1 ? `Somewhat ${z > 0 ? 'above' : 'below'} its ${period}-period average.`
      : 'Close to its own recent average.',
  };
}

/** Liquidity proxy from real turnover (price × volume) — no bid/ask data
 *  required. Reports average daily traded value and where TODAY's turnover
 *  sits vs its own recent history (a percentile, not a fixed cutoff, since
 *  "liquid" means different absolute numbers for different stocks). */
function calcLiquidityProfile(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const turnovers = candles.map((c) => c.c * c.v);
  const recent = turnovers.slice(-period);
  const avgTurnover = stats.mean(recent);
  const current = turnovers[turnovers.length - 1];
  const sorted = [...recent].sort((a, b) => a - b);
  const percentile = (sorted.filter((v) => v <= current).length / sorted.length) * 100;
  return {
    avgDailyTurnover: Math.round(avgTurnover),
    currentTurnover: Math.round(current),
    turnoverPercentile: Number(percentile.toFixed(1)),
    label: avgTurnover >= 5e8 ? 'High liquidity (large average turnover)' : avgTurnover >= 5e7 ? 'Moderate liquidity' : 'Lower liquidity — larger orders may see more price impact',
  };
}

/** Volume Profile / Point-of-Control approximation — bins the typical
 *  price of each real candle and accumulates its real volume into that
 *  bin, then reports the price bin with the most traded volume (POC) and
 *  the range holding 70% of volume (a value-area approximation). This is
 *  a coarser proxy than tick-level volume profile (which needs intra-
 *  candle trade data TradeMind doesn't have) but is built entirely from
 *  real OHLCV — no synthetic distribution assumed. */
function calcVolumeProfile(candles, bins = 24) {
  if (candles.length < 10) return null;
  const highs = candles.map((c) => c.h), lows = candles.map((c) => c.l);
  const top = Math.max(...highs), bottom = Math.min(...lows);
  const range = top - bottom;
  if (!range) return null;
  const binSize = range / bins;
  const volByBin = new Array(bins).fill(0);
  for (const c of candles) {
    const typical = (c.h + c.l + c.c) / 3;
    let idx = Math.floor((typical - bottom) / binSize);
    idx = Math.max(0, Math.min(bins - 1, idx));
    volByBin[idx] += c.v;
  }
  const totalVol = volByBin.reduce((a, b) => a + b, 0);
  let pocIdx = 0;
  for (let i = 1; i < bins; i++) if (volByBin[i] > volByBin[pocIdx]) pocIdx = i;
  const pocPrice = Number((bottom + (pocIdx + 0.5) * binSize).toFixed(2));

  // Value area: expand outward from POC until 70% of volume is covered.
  let covered = volByBin[pocIdx], lo = pocIdx, hi = pocIdx;
  while (covered / totalVol < 0.7 && (lo > 0 || hi < bins - 1)) {
    const nextLo = lo > 0 ? volByBin[lo - 1] : -1;
    const nextHi = hi < bins - 1 ? volByBin[hi + 1] : -1;
    if (nextLo >= nextHi) { lo--; covered += nextLo; } else { hi++; covered += nextHi; }
  }
  return {
    pointOfControl: pocPrice,
    valueAreaLow: Number((bottom + lo * binSize).toFixed(2)),
    valueAreaHigh: Number((bottom + (hi + 1) * binSize).toFixed(2)),
    note: 'Approximated from candle OHLC + real volume (typical-price binning), not tick-level trade data.',
  };
}

/** Opening-Range Breakout state for the CURRENT session's intraday candles
 *  only (pass just today's candles). Defines the opening range from the
 *  first `orBars` candles, then reports whether/when price broke out. */
function detectOpeningRangeBreakout(todaysCandles, orBars = 3) {
  if (!todaysCandles || todaysCandles.length <= orBars) return null;
  const orCandles = todaysCandles.slice(0, orBars);
  const orHigh = Math.max(...orCandles.map((c) => c.h));
  const orLow = Math.min(...orCandles.map((c) => c.l));
  const rest = todaysCandles.slice(orBars);
  const breakoutUp = rest.findIndex((c) => c.c > orHigh);
  const breakoutDown = rest.findIndex((c) => c.c < orLow);
  let state = 'Still inside the opening range';
  if (breakoutUp !== -1 && (breakoutDown === -1 || breakoutUp < breakoutDown)) state = 'Broke above the opening range';
  else if (breakoutDown !== -1) state = 'Broke below the opening range';
  return { orHigh: Number(orHigh.toFixed(2)), orLow: Number(orLow.toFixed(2)), state };
}

module.exports = {
  calcAutocorrelation, calcHurstExponent, calcMeanReversionZScore,
  calcLiquidityProfile, calcVolumeProfile, detectOpeningRangeBreakout,
};

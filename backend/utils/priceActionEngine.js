// utils/priceActionEngine.js
// ══════════════════════════════════════════════════════════════════════════
//  Structural price-action reading over REAL candles: swing-point market
//  structure (HH/HL/LH/LL), breakout/breakdown/retest/gap detection, a few
//  more candlestick patterns, and zone-based (not single-price) support &
//  resistance with a transparent strength score. Everything here is a
//  DESCRIPTION of what the real candles show — never a buy/sell instruction.
// ══════════════════════════════════════════════════════════════════════════

/** Finds local swing highs/lows using a simple N-bar fractal: a candle is a
 *  swing high if its high is the max within `window` bars on each side
 *  (same for swing low). Real, deterministic, no lookahead beyond the
 *  window used purely to confirm a swing already in the historical data. */
function findSwingPoints(candles, window = 3) {
  const swings = [];
  for (let i = window; i < candles.length - window; i++) {
    const slice = candles.slice(i - window, i + window + 1);
    const isHigh = candles[i].h === Math.max(...slice.map((c) => c.h));
    const isLow = candles[i].l === Math.min(...slice.map((c) => c.l));
    if (isHigh) swings.push({ index: i, type: 'high', price: candles[i].h });
    if (isLow) swings.push({ index: i, type: 'low', price: candles[i].l });
  }
  return swings;
}

/** Classifies market structure from the sequence of recent swing highs/lows:
 *  Higher-High/Higher-Low (uptrend structure), Lower-High/Lower-Low
 *  (downtrend structure), or mixed (range/transition). */
function classifyMarketStructure(candles, window = 3, lookbackSwings = 6) {
  const swings = findSwingPoints(candles, window);
  const highs = swings.filter((s) => s.type === 'high').slice(-lookbackSwings);
  const lows = swings.filter((s) => s.type === 'low').slice(-lookbackSwings);

  const highSeq = highs.map((h) => h.price);
  const lowSeq = lows.map((l) => l.price);
  const isRising = (arr) => arr.length >= 2 && arr.every((v, i) => i === 0 || v >= arr[i - 1]);
  const isFalling = (arr) => arr.length >= 2 && arr.every((v, i) => i === 0 || v <= arr[i - 1]);

  let structure = 'Mixed / range-bound structure';
  if (isRising(highSeq) && isRising(lowSeq)) structure = 'Higher Highs & Higher Lows (uptrend structure)';
  else if (isFalling(highSeq) && isFalling(lowSeq)) structure = 'Lower Highs & Lower Lows (downtrend structure)';
  else if (isRising(lowSeq) && !isRising(highSeq)) structure = 'Higher Lows forming (possible base / accumulation)';
  else if (isFalling(highSeq) && !isFalling(lowSeq)) structure = 'Lower Highs forming (possible topping / distribution)';

  return { structure, recentSwingHighs: highSeq, recentSwingLows: lowSeq, swingCount: swings.length };
}

/** Breakout / breakdown / retest relative to the most recent completed
 *  swing high & low. `withinPct` controls how close price must be to a
 *  level to call it a "retest" rather than a clean breakout. */
function detectBreakoutState(candles, window = 3, withinPct = 0.5) {
  const swings = findSwingPoints(candles, window);
  const lastHigh = [...swings].reverse().find((s) => s.type === 'high');
  const lastLow = [...swings].reverse().find((s) => s.type === 'low');
  const last = candles[candles.length - 1];
  const events = [];

  if (lastHigh && last.c > lastHigh.price) {
    const distPct = ((last.c - lastHigh.price) / lastHigh.price) * 100;
    events.push(distPct <= withinPct
      ? { type: 'Retest of prior swing high from above', level: lastHigh.price }
      : { type: 'Breakout above prior swing high', level: lastHigh.price, distancePct: Number(distPct.toFixed(2)) });
  }
  if (lastLow && last.c < lastLow.price) {
    const distPct = ((lastLow.price - last.c) / lastLow.price) * 100;
    events.push(distPct <= withinPct
      ? { type: 'Retest of prior swing low from below', level: lastLow.price }
      : { type: 'Breakdown below prior swing low', level: lastLow.price, distancePct: Number(distPct.toFixed(2)) });
  }
  if (!events.length) events.push({ type: 'Trading within the recent swing range — no breakout/breakdown', lastSwingHigh: lastHigh?.price, lastSwingLow: lastLow?.price });
  return events;
}

/** Gap detection — real gap up/down between consecutive daily candles, plus
 *  whether a later candle has since filled it. */
function detectGaps(candles, minGapPct = 0.5) {
  const gaps = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].c;
    const open = candles[i].o;
    if (!prevClose) continue;
    const gapPct = ((open - prevClose) / prevClose) * 100;
    if (Math.abs(gapPct) >= minGapPct) {
      let filled = false, filledAtIndex = null;
      for (let j = i; j < candles.length; j++) {
        if (gapPct > 0 && candles[j].l <= prevClose) { filled = true; filledAtIndex = j; break; }
        if (gapPct < 0 && candles[j].h >= prevClose) { filled = true; filledAtIndex = j; break; }
      }
      gaps.push({
        index: i, type: gapPct > 0 ? 'Gap up' : 'Gap down', gapPct: Number(gapPct.toFixed(2)),
        prevClose, open: candles[i].o, filled, filledAtIndex,
      });
    }
  }
  return gaps;
}

/** A few more candlestick patterns beyond indicators.js
 *  describeCandlestickPattern() — 3-candle reversal patterns and inside/
 *  outside bars, which need more history than the single-candle read
 *  already shipped. Purely descriptive. */
function describeExtraCandlePatterns(candles) {
  if (!candles || candles.length < 3) return [];
  const patterns = [];
  const n = candles.length;
  const [c1, c2, c3] = [candles[n - 3], candles[n - 2], candles[n - 1]];
  const body = (c) => Math.abs(c.c - c.o);
  const isSmallBody = (c) => body(c) / ((c.h - c.l) || 0.0001) < 0.3;

  // Morning Star: big bearish, small indecisive, big bullish closing well into candle1's body.
  if (c1.c < c1.o && isSmallBody(c2) && c3.c > c3.o && c3.c > (c1.o + c1.c) / 2) {
    patterns.push({ pattern: 'Morning Star', note: 'A three-candle bottoming pattern — selling, then indecision, then a strong bullish candle reclaiming the midpoint of the first candle.' });
  }
  // Evening Star: mirror of the above.
  if (c1.c > c1.o && isSmallBody(c2) && c3.c < c3.o && c3.c < (c1.o + c1.c) / 2) {
    patterns.push({ pattern: 'Evening Star', note: 'A three-candle topping pattern — buying, then indecision, then a strong bearish candle giving back the midpoint of the first candle.' });
  }
  // Harami: second candle's body is fully inside the first candle's body.
  const [pa, pb] = [candles[n - 2], candles[n - 1]];
  const paTop = Math.max(pa.o, pa.c), paBot = Math.min(pa.o, pa.c);
  const pbTop = Math.max(pb.o, pb.c), pbBot = Math.min(pb.o, pb.c);
  if (pbTop <= paTop && pbBot >= paBot && body(pb) < body(pa)) {
    patterns.push({ pattern: pa.c < pa.o ? 'Bullish Harami' : 'Bearish Harami', note: 'The latest candle\'s body is contained entirely within the prior candle\'s body — momentum contracting, often a pause or early reversal cue.' });
  }
  // Inside bar / outside bar (range-based, not body-based).
  if (pb.h <= pa.h && pb.l >= pa.l) {
    patterns.push({ pattern: 'Inside Bar', note: 'The latest candle\'s full range sits inside the prior candle\'s range — a contraction/consolidation candle.' });
  } else if (pb.h >= pa.h && pb.l <= pa.l) {
    patterns.push({ pattern: 'Outside Bar', note: 'The latest candle\'s range fully engulfs the prior candle\'s range — an expansion candle showing a pickup in participation.' });
  }
  return patterns;
}

/** Zone-based support/resistance with a transparent strength score, instead
 *  of a single price. Clusters swing highs/lows that sit within
 *  `zoneWidthPct` of each other, and scores each zone by:
 *    touch count + volume confirmation + confluence with the given MAs.
 *  This directly implements the "Support Strength Score" idea: touches +
 *  volume + confluence, rather than an unweighted single price. */
function buildSupportResistanceZones(candles, { window = 3, zoneWidthPct = 1.0, maLevels = [] } = {}) {
  const swings = findSwingPoints(candles, window);
  const avgVolume = candles.reduce((s, c) => s + c.v, 0) / (candles.length || 1);

  function cluster(points) {
    const sorted = [...points].sort((a, b) => a.price - b.price);
    const zones = [];
    for (const p of sorted) {
      const zone = zones.find((z) => Math.abs(p.price - z.centre) / z.centre * 100 <= zoneWidthPct);
      if (zone) {
        zone.touches.push(p);
        zone.centre = zone.touches.reduce((s, t) => s + t.price, 0) / zone.touches.length;
      } else {
        zones.push({ centre: p.price, touches: [p] });
      }
    }
    return zones.map((z) => {
      const touchCount = z.touches.length;
      const volumeConfirmation = z.touches.some((t) => candles[t.index] && candles[t.index].v > avgVolume * 1.3);
      const maConfluence = maLevels.filter((ma) => ma && Math.abs(ma - z.centre) / z.centre * 100 <= zoneWidthPct).length;
      // Simple, explainable additive score — documented so it's never a
      // black box: 15 pts/touch (cap 4), +20 for volume confirmation,
      // +15 per confluent MA (cap 2), all capped at 100.
      const score = Math.min(100, touchCount * 15 + (volumeConfirmation ? 20 : 0) + Math.min(maConfluence, 2) * 15);
      return {
        low: Number((z.centre * (1 - zoneWidthPct / 200)).toFixed(2)),
        high: Number((z.centre * (1 + zoneWidthPct / 200)).toFixed(2)),
        centre: Number(z.centre.toFixed(2)),
        touchCount,
        volumeConfirmation,
        maConfluenceCount: maConfluence,
        strengthScore: score,
      };
    }).sort((a, b) => b.strengthScore - a.strengthScore);
  }

  const resistanceZones = cluster(swings.filter((s) => s.type === 'high'));
  const supportZones = cluster(swings.filter((s) => s.type === 'low'));
  return { resistanceZones: resistanceZones.slice(0, 5), supportZones: supportZones.slice(0, 5) };
}

module.exports = {
  findSwingPoints, classifyMarketStructure, detectBreakoutState, detectGaps,
  describeExtraCandlePatterns, buildSupportResistanceZones,
};

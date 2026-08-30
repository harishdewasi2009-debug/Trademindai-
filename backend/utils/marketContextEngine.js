// utils/marketContextEngine.js
// ══════════════════════════════════════════════════════════════════════════
//  Context that sits ABOVE a single stock's own indicators: market/volatility
//  regime, divergences between price and an oscillator, statistical anomaly
//  flags, multi-timeframe agreement, and a data-quality score to compute
//  BEFORE trusting the rest of the numbers. All descriptive, no verdicts.
// ══════════════════════════════════════════════════════════════════════════

const stats = require('./statsEngine');

// ── Market regime (run this on INDEX candles, e.g. NIFTY 50) ────────────
function classifyMarketRegime(indexCandles, adx, atrPctSeries) {
  if (!indexCandles || indexCandles.length < 20) return null;
  const closes = indexCandles.map((c) => c.c);
  const ret20 = stats.periodReturnPct(closes, Math.min(20, closes.length - 1));
  const vol = stats.historicalVolatilityPct(closes);
  const currentAtrPct = atrPctSeries && atrPctSeries.length ? atrPctSeries[atrPctSeries.length - 1] : null;
  const volPercentile = currentAtrPct != null
    ? require('./quantIndicators').calcVolatilityPercentile(atrPctSeries)
    : null;

  let regime;
  if (volPercentile != null && volPercentile >= 85) regime = 'High-volatility regime';
  else if (ret20 != null && ret20 >= 3 && adx >= 20) regime = 'Bull market (positive trend, rising index)';
  else if (ret20 != null && ret20 <= -3 && adx >= 20) regime = 'Bear market (negative trend, falling index)';
  else regime = 'Sideways / range-bound regime';

  return {
    regime,
    indexReturn20dPct: ret20,
    annualisedVolatilityPct: vol,
    volatilityPercentile: volPercentile,
    note: 'The same setup can behave very differently depending on regime — treat signals with more caution in high-volatility or choppy sideways regimes.',
  };
}

// ── Divergence engine ────────────────────────────────────────────────────
// Compares the direction of the last two PRICE swing points against the
// direction of the oscillator at those same two candle indices.
function detectDivergence(candles, oscillatorSeries, oscillatorName, window = 3) {
  const { findSwingPoints } = require('./priceActionEngine');
  const swings = findSwingPoints(candles, window);
  const lows = swings.filter((s) => s.type === 'low').slice(-2);
  const highs = swings.filter((s) => s.type === 'high').slice(-2);
  const results = [];

  if (lows.length === 2) {
    const [a, b] = lows;
    const priceDown = b.price < a.price;
    const oscUp = oscillatorSeries[b.index] > oscillatorSeries[a.index];
    if (priceDown && oscUp) {
      results.push({ type: 'Bullish divergence', indicator: oscillatorName, note: `Price made a lower low while ${oscillatorName} made a higher low — downside momentum may be fading.` });
    }
  }
  if (highs.length === 2) {
    const [a, b] = highs;
    const priceUp = b.price > a.price;
    const oscDown = oscillatorSeries[b.index] < oscillatorSeries[a.index];
    if (priceUp && oscDown) {
      results.push({ type: 'Bearish divergence', indicator: oscillatorName, note: `Price made a higher high while ${oscillatorName} made a lower high — upside momentum may be fading.` });
    }
  }
  return results;
}

// ── Anomaly detection ────────────────────────────────────────────────────
function detectAnomalies(candles, { volumeMult = 3, priceMovePct = 5, atrPctSeries = null } = {}) {
  const anomalies = [];
  const n = candles.length;
  if (n < 21) return anomalies;
  const last = candles[n - 1];

  const avgVol20 = candles.slice(-21, -1).reduce((s, c) => s + c.v, 0) / 20;
  if (avgVol20 && last.v >= avgVol20 * volumeMult) {
    anomalies.push({ type: 'Unusual volume', detail: `Volume is ${(last.v / avgVol20).toFixed(1)}× the 20-bar average.` });
  }

  const prevClose = candles[n - 2].c;
  const movePct = prevClose ? ((last.c - prevClose) / prevClose) * 100 : 0;
  if (Math.abs(movePct) >= priceMovePct) {
    anomalies.push({ type: 'Unusual price movement', detail: `Price moved ${movePct.toFixed(1)}% versus the prior close.` });
  }

  if (avgVol20 && last.v >= avgVol20 * (volumeMult / 1.5) && Math.abs(movePct) >= priceMovePct / 1.5) {
    anomalies.push({ type: 'Volume/price confirmation', detail: 'Both volume and price moved together by an unusual amount — reduces (but does not eliminate) the odds this is a data glitch.' });
  } else if (avgVol20 && last.v >= avgVol20 * volumeMult && Math.abs(movePct) < 1) {
    anomalies.push({ type: 'Volume/price divergence', detail: 'Volume spiked without a matching price move — worth checking for block/bulk deals or data noise.' });
  }

  if (atrPctSeries && atrPctSeries.length > 20) {
    const avgAtr = atrPctSeries.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
    const currentAtr = atrPctSeries[atrPctSeries.length - 1];
    if (avgAtr && currentAtr >= avgAtr * 1.8) {
      anomalies.push({ type: 'Volatility spike', detail: `ATR% is running ${(currentAtr / avgAtr).toFixed(1)}× its recent average.` });
    }
  }
  return anomalies;
}

// ── Multi-timeframe alignment ────────────────────────────────────────────
// Pass an array like [{ timeframe:'5m', trend:'Bullish' }, { timeframe:'1H', trend:'Bullish' }, ...]
// (trend labels already computed per-timeframe via indicators.js/buildFullTechnicalReport).
function calcTimeframeAlignment(timeframeSignals) {
  if (!timeframeSignals || !timeframeSignals.length) return null;
  const bullish = timeframeSignals.filter((t) => /bullish/i.test(t.trend)).length;
  const bearish = timeframeSignals.filter((t) => /bearish/i.test(t.trend)).length;
  const total = timeframeSignals.length;
  const alignmentScore = Math.round((Math.max(bullish, bearish) / total) * 100);
  const direction = bullish === bearish ? 'Mixed' : bullish > bearish ? 'Bullish' : 'Bearish';
  return {
    timeframeSignals, bullishCount: bullish, bearishCount: bearish, total,
    alignmentScore, // 100 = every timeframe agrees; lower = more disagreement across timeframes
    direction,
    note: alignmentScore >= 80 ? 'Strong agreement across timeframes.' : alignmentScore >= 50 ? 'Partial agreement — some timeframes disagree.' : 'Timeframes are conflicting; treat any single-timeframe read with caution.',
  };
}

// ── Data-quality score — compute BEFORE trusting derived indicators ─────
function assessDataQuality(candles) {
  if (!candles || !candles.length) return { score: 0, issues: ['No candle data.'] };
  const issues = [];
  let deductions = 0;

  // Duplicate timestamps.
  const seen = new Set();
  let duplicates = 0;
  for (const c of candles) { if (c.t && seen.has(c.t)) duplicates++; seen.add(c.t); }
  if (duplicates) { issues.push(`${duplicates} duplicate candle timestamp(s).`); deductions += Math.min(20, duplicates * 2); }

  // Bad OHLC (high < low, or close/open outside the high-low range).
  let badOhlc = 0;
  for (const c of candles) {
    if (c.h < c.l || c.c > c.h || c.c < c.l || c.o > c.h || c.o < c.l) badOhlc++;
  }
  if (badOhlc) { issues.push(`${badOhlc} candle(s) with inconsistent OHLC values.`); deductions += Math.min(30, badOhlc * 3); }

  // Zero/negative prices or volume.
  const badValues = candles.filter((c) => c.c <= 0 || c.v < 0).length;
  if (badValues) { issues.push(`${badValues} candle(s) with non-positive close or negative volume.`); deductions += Math.min(20, badValues * 2); }

  // Stale last candle (only meaningful when timestamps are provided).
  const lastT = candles[candles.length - 1].t;
  if (lastT) {
    const ageHours = (Date.now() - new Date(lastT).getTime()) / 36e5;
    if (ageHours > 72) { issues.push(`Most recent candle is ~${Math.round(ageHours / 24)} day(s) old.`); deductions += 10; }
  }

  const score = Math.max(0, 100 - deductions);
  return { score, issues, candleCount: candles.length };
}

module.exports = {
  classifyMarketRegime, detectDivergence, detectAnomalies,
  calcTimeframeAlignment, assessDataQuality,
};

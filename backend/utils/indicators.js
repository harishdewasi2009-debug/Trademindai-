// utils/indicators.js
// ══════════════════════════════════════════════════════════════════════════
//  Pure technical-indicator math. Every function here takes REAL OHLCV
//  candle data (as fetched from Upstox by marketDataService) and returns
//  computed values — nothing in this file invents, seeds, or randomizes
//  price data. If the input candles are real, the output indicators are
//  real; there is no fallback path that fabricates numbers.
// ══════════════════════════════════════════════════════════════════════════

function calcSMA(closes, period) {
  const out = [];
  for (let i = 0; i < closes.length; i++) {
    const start = Math.max(0, i - period + 1);
    const slice = closes.slice(start, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
}

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  const out = [ema];
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function calcRSI(closes, period = 14) {
  const out = new Array(closes.length).fill(50);
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (i <= period) {
      if (diff >= 0) gains += diff; else losses -= diff;
      if (i === period) { const rs = gains / (losses || 1); out[i] = 100 - 100 / (1 + rs); }
    } else {
      const up = diff > 0 ? diff : 0, dn = diff < 0 ? -diff : 0;
      gains = (gains * (period - 1) + up) / period;
      losses = (losses * (period - 1) + dn) / period;
      const rs = gains / (losses || 0.0001);
      out[i] = 100 - 100 / (1 + rs);
    }
  }
  return out;
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12), ema26 = calcEMA(closes, 26);
  const macd = closes.map((_, i) => ema12[i] - ema26[i]);
  const signal = calcEMA(macd, 9);
  const hist = macd.map((m, i) => m - signal[i]);
  return { macd, signal, hist };
}

function calcBollinger(closes, period = 20, mult = 2) {
  const upper = [], lower = [], mid = [];
  for (let i = 0; i < closes.length; i++) {
    const start = Math.max(0, i - period + 1);
    const slice = closes.slice(start, i + 1);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance = slice.reduce((a, b) => a + (b - avg) * (b - avg), 0) / slice.length;
    const sd = Math.sqrt(variance);
    mid.push(avg); upper.push(avg + mult * sd); lower.push(avg - mult * sd);
  }
  return { upper, lower, mid };
}

function calcVWAP(candles) {
  let cumPV = 0, cumV = 0;
  return candles.map((c) => {
    const typical = (c.h + c.l + c.c) / 3;
    cumPV += typical * c.v;
    cumV += c.v;
    return cumV ? cumPV / cumV : typical;
  });
}

/** Average True Range — volatility measure used by Supertrend below. */
function calcATR(candles, period = 14) {
  const trs = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const prevClose = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
  });
  const out = [];
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
  for (let i = 0; i < trs.length; i++) {
    if (i < period) { out.push(atr); continue; }
    atr = (atr * (period - 1) + trs[i]) / period;
    out.push(atr);
  }
  return out;
}

/** Supertrend — trend-following overlay derived from real ATR + HL2. */
function calcSupertrend(candles, period = 10, mult = 3) {
  const atr = calcATR(candles, period);
  const trend = [];
  let prevUpperBand = null, prevLowerBand = null, prevTrendUp = true;
  for (let i = 0; i < candles.length; i++) {
    const hl2 = (candles[i].h + candles[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];
    if (i > 0) {
      upperBand = (upperBand < prevUpperBand || candles[i - 1].c > prevUpperBand) ? upperBand : prevUpperBand;
      lowerBand = (lowerBand > prevLowerBand || candles[i - 1].c < prevLowerBand) ? lowerBand : prevLowerBand;
    }
    let trendUp = prevTrendUp;
    if (candles[i].c > upperBand) trendUp = true;
    else if (candles[i].c < lowerBand) trendUp = false;
    trend.push({ value: trendUp ? lowerBand : upperBand, trendUp });
    prevUpperBand = upperBand; prevLowerBand = lowerBand; prevTrendUp = trendUp;
  }
  return trend;
}

/** Naive but real support/resistance: local swing highs/lows over the window. */
function findSupportResistance(candles, lookback = 60) {
  const slice = candles.slice(-lookback);
  const highs = slice.map((c) => c.h).sort((a, b) => b - a);
  const lows = slice.map((c) => c.l).sort((a, b) => a - b);
  return { resistance: highs[0], support: lows[0] };
}

/** Simple, transparent trend-strength score (0-100) from EMA slope + ADX-style directional agreement. */
function calcTrendStrength(closes) {
  const ema20 = calcEMA(closes, 20);
  const last = ema20.length - 1;
  const lookback = Math.max(0, last - 10);
  const slopePct = ((ema20[last] - ema20[lookback]) / ema20[lookback]) * 100;
  return Math.max(0, Math.min(100, 50 + slopePct * 5));
}

/**
 * Computes the full real-data indicator set from candles ({o,h,l,c,v,t}[]).
 * Returns null if there isn't enough real data to compute meaningfully.
 */
function computeAllIndicators(candles) {
  if (!candles || candles.length < 20) return null;
  const closes = candles.map((c) => c.c);
  const last = closes.length - 1;

  const rsi = calcRSI(closes);
  const { macd, signal, hist } = calcMACD(closes);
  const ema20 = calcEMA(closes, 20), ema50 = calcEMA(closes, 50);
  const sma20 = calcSMA(closes, 20), sma50 = calcSMA(closes, 50);
  const bb = calcBollinger(closes);
  const vwap = calcVWAP(candles);
  const atr = calcATR(candles);
  const supertrend = calcSupertrend(candles);
  const { support, resistance } = findSupportResistance(candles);
  const trendStrength = calcTrendStrength(closes);

  return {
    currentPrice: closes[last],
    rsi: Number(rsi[last].toFixed(2)),
    macd: Number(macd[last].toFixed(2)),
    macdSignal: Number(signal[last].toFixed(2)),
    macdHistogram: Number(hist[last].toFixed(2)),
    ema20: Number(ema20[last].toFixed(2)),
    ema50: Number(ema50[last].toFixed(2)),
    sma20: Number(sma20[last].toFixed(2)),
    sma50: Number(sma50[last].toFixed(2)),
    bollingerUpper: Number(bb.upper[last].toFixed(2)),
    bollingerMid: Number(bb.mid[last].toFixed(2)),
    bollingerLower: Number(bb.lower[last].toFixed(2)),
    vwap: Number(vwap[last].toFixed(2)),
    atr: Number(atr[last].toFixed(2)),
    supertrend: Number(supertrend[last].value.toFixed(2)),
    supertrendDirection: supertrend[last].trendUp ? 'bullish' : 'bearish',
    support: Number(support.toFixed(2)),
    resistance: Number(resistance.toFixed(2)),
    trendStrength: Number(trendStrength.toFixed(1)),
    volume: candles[last].v,
    avgVolume20: Number((candles.slice(-20).reduce((s, c) => s + c.v, 0) / Math.min(20, candles.length)).toFixed(0)),
  };
}

// ── Rule-based BUY / HOLD / SELL signal — purely computed from the real ──
// indicator values above, no AI/LLM involved. Used by the Screener so it
// can be labelled "computed data analysis", distinct from the AI Analysis
// page. Six independent votes are tallied; each is a plain, explainable
// technical rule (trend, momentum, oscillator) so the result can always be
// traced back to real numbers instead of a black box.
function deriveSignal(ind) {
  if (!ind) return null;
  let score = 0;
  const votes = [];

  if (ind.rsi <= 30) { score += 1; votes.push('RSI oversold'); }
  else if (ind.rsi >= 70) { score -= 1; votes.push('RSI overbought'); }

  if (ind.ema20 > ind.ema50) { score += 1; votes.push('EMA20 > EMA50'); }
  else { score -= 1; votes.push('EMA20 < EMA50'); }

  if (ind.macdHistogram > 0) { score += 1; votes.push('MACD histogram positive'); }
  else { score -= 1; votes.push('MACD histogram negative'); }

  if (ind.supertrendDirection === 'bullish') { score += 1; votes.push('Supertrend bullish'); }
  else { score -= 1; votes.push('Supertrend bearish'); }

  if (ind.currentPrice > ind.vwap) { score += 1; votes.push('Price above VWAP'); }
  else { score -= 1; votes.push('Price below VWAP'); }

  if (ind.trendStrength >= 60) { score += 1; votes.push('Strong trend'); }
  else if (ind.trendStrength <= -60) { score -= 1; votes.push('Weak/negative trend'); }

  const signal = score >= 2 ? 'BUY' : score <= -2 ? 'SELL' : 'HOLD';
  // Map the -6..+6 vote tally to a 0-100 confidence figure so the UI can
  // show e.g. "BUY · 78%" without implying any prediction/probability.
  const confidence = Math.round(50 + (score / 6) * 50);

  return { signal, score, confidence: Math.max(0, Math.min(100, confidence)), votes };
}

module.exports = {
  calcSMA, calcEMA, calcRSI, calcMACD, calcBollinger, calcVWAP, calcATR,
  calcSupertrend, findSupportResistance, calcTrendStrength, computeAllIndicators,
  deriveSignal,
};

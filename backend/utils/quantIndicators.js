// utils/quantIndicators.js
// ══════════════════════════════════════════════════════════════════════════
//  Extends indicators.js with the rest of the standard technical-analysis
//  toolkit (extra trend, momentum, volume, and volatility measures) plus
//  pivot points and anchored VWAP. Same rule as indicators.js: pure math
//  over REAL OHLCV candles, nothing fabricated. Kept in a separate file so
//  the original, already-shipped indicators.js is never touched — every
//  export here is purely additive.
// ══════════════════════════════════════════════════════════════════════════

// ── Trend: extra moving averages ────────────────────────────────────────
function calcWMA(closes, period) {
  const out = [];
  const denom = (period * (period + 1)) / 2;
  for (let i = 0; i < closes.length; i++) {
    const start = Math.max(0, i - period + 1);
    const slice = closes.slice(start, i + 1);
    let sum = 0;
    for (let j = 0; j < slice.length; j++) sum += slice[j] * (j + 1);
    // Weight denominator scales down for the first (period-1) bars where
    // the slice is shorter than `period`.
    const localDenom = (slice.length * (slice.length + 1)) / 2;
    out.push(sum / localDenom);
    void denom;
  }
  return out;
}

/** Hull Moving Average — reduces MA lag: WMA(2×WMA(n/2) − WMA(n), sqrt(n)). */
function calcHMA(closes, period = 16) {
  const half = Math.max(1, Math.round(period / 2));
  const sqrtP = Math.max(1, Math.round(Math.sqrt(period)));
  const wmaHalf = calcWMA(closes, half);
  const wmaFull = calcWMA(closes, period);
  const diff = closes.map((_, i) => 2 * wmaHalf[i] - wmaFull[i]);
  return calcWMA(diff, sqrtP);
}

// ── Momentum ─────────────────────────────────────────────────────────────
function calcStochastic(candles, kPeriod = 14, dPeriod = 3) {
  const k = [];
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - kPeriod + 1);
    const slice = candles.slice(start, i + 1);
    const hh = Math.max(...slice.map((c) => c.h));
    const ll = Math.min(...slice.map((c) => c.l));
    const range = hh - ll;
    k.push(range ? ((candles[i].c - ll) / range) * 100 : 50);
  }
  const d = [];
  for (let i = 0; i < k.length; i++) {
    const start = Math.max(0, i - dPeriod + 1);
    const slice = k.slice(start, i + 1);
    d.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return { k, d };
}

/** Stochastic RSI — the Stochastic formula applied to RSI values instead
 *  of price. Needs an RSI series (pass indicators.js calcRSI output). */
function calcStochRSI(rsiSeries, period = 14) {
  const out = [];
  for (let i = 0; i < rsiSeries.length; i++) {
    const start = Math.max(0, i - period + 1);
    const slice = rsiSeries.slice(start, i + 1);
    const hh = Math.max(...slice), ll = Math.min(...slice);
    const range = hh - ll;
    out.push(range ? ((rsiSeries[i] - ll) / range) * 100 : 50);
  }
  return out;
}

function calcCCI(candles, period = 20) {
  const tp = candles.map((c) => (c.h + c.l + c.c) / 3);
  const out = [];
  for (let i = 0; i < tp.length; i++) {
    const start = Math.max(0, i - period + 1);
    const slice = tp.slice(start, i + 1);
    const sma = slice.reduce((a, b) => a + b, 0) / slice.length;
    const meanDev = slice.reduce((a, b) => a + Math.abs(b - sma), 0) / slice.length;
    out.push(meanDev ? (tp[i] - sma) / (0.015 * meanDev) : 0);
  }
  return out;
}

function calcROC(closes, period = 12) {
  return closes.map((c, i) => {
    const prev = closes[i - period];
    return prev ? Number((((c - prev) / prev) * 100).toFixed(2)) : 0;
  });
}

function calcWilliamsR(candles, period = 14) {
  return candles.map((_, i) => {
    const start = Math.max(0, i - period + 1);
    const slice = candles.slice(start, i + 1);
    const hh = Math.max(...slice.map((c) => c.h));
    const ll = Math.min(...slice.map((c) => c.l));
    const range = hh - ll;
    return range ? Number((((hh - candles[i].c) / range) * -100).toFixed(2)) : -50;
  });
}

/** Money Flow Index — volume-weighted RSI. */
function calcMFI(candles, period = 14) {
  const tp = candles.map((c) => (c.h + c.l + c.c) / 3);
  const rawMF = tp.map((t, i) => t * candles[i].v);
  const out = new Array(candles.length).fill(50);
  for (let i = 1; i < candles.length; i++) {
    const start = Math.max(1, i - period + 1);
    let posFlow = 0, negFlow = 0;
    for (let j = start; j <= i; j++) {
      if (tp[j] > tp[j - 1]) posFlow += rawMF[j];
      else if (tp[j] < tp[j - 1]) negFlow += rawMF[j];
    }
    const ratio = negFlow ? posFlow / negFlow : posFlow ? Infinity : 1;
    out[i] = negFlow ? 100 - 100 / (1 + ratio) : 100;
  }
  return out;
}

// ── Volume ───────────────────────────────────────────────────────────────
function calcOBV(candles) {
  const out = [0];
  for (let i = 1; i < candles.length; i++) {
    const prev = out[out.length - 1];
    if (candles[i].c > candles[i - 1].c) out.push(prev + candles[i].v);
    else if (candles[i].c < candles[i - 1].c) out.push(prev - candles[i].v);
    else out.push(prev);
  }
  return out;
}

/** Accumulation/Distribution line. */
function calcADLine(candles) {
  const out = [];
  let cum = 0;
  for (const c of candles) {
    const range = c.h - c.l;
    const mfm = range ? ((c.c - c.l) - (c.h - c.c)) / range : 0;
    cum += mfm * c.v;
    out.push(cum);
  }
  return out;
}

/** Chaikin Money Flow — A/D flow normalised over a rolling window. */
function calcCMF(candles, period = 20) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - period + 1);
    const slice = candles.slice(start, i + 1);
    let mfvSum = 0, volSum = 0;
    for (const c of slice) {
      const range = c.h - c.l;
      const mfm = range ? ((c.c - c.l) - (c.h - c.c)) / range : 0;
      mfvSum += mfm * c.v;
      volSum += c.v;
    }
    out.push(volSum ? Number((mfvSum / volSum).toFixed(3)) : 0);
  }
  return out;
}

/** Volume-Price Trend. */
function calcVPT(candles) {
  const out = [0];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].c;
    const change = prevClose ? (candles[i].c - prevClose) / prevClose : 0;
    out.push(out[out.length - 1] + change * candles[i].v);
  }
  return out;
}

/** Flags candles whose volume is an outlier vs its trailing average —
 *  purely descriptive ("N× average"), not a signal. */
function detectVolumeSpikes(candles, period = 20, thresholdMult = 2.5) {
  const spikes = [];
  for (let i = period; i < candles.length; i++) {
    const avg = candles.slice(i - period, i).reduce((s, c) => s + c.v, 0) / period;
    if (avg && candles[i].v >= avg * thresholdMult) {
      spikes.push({ index: i, volume: candles[i].v, avgVolume: Math.round(avg), multiple: Number((candles[i].v / avg).toFixed(2)) });
    }
  }
  return spikes;
}

// ── Volatility ───────────────────────────────────────────────────────────
function calcDonchian(candles, period = 20) {
  const upper = [], lower = [], mid = [];
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - period + 1);
    const slice = candles.slice(start, i + 1);
    const hh = Math.max(...slice.map((c) => c.h));
    const ll = Math.min(...slice.map((c) => c.l));
    upper.push(hh); lower.push(ll); mid.push((hh + ll) / 2);
  }
  return { upper, lower, mid };
}

/** Keltner Channels — EMA midline +/- ATR multiple. Needs calcEMA + calcATR
 *  from indicators.js, passed in to avoid a circular require. */
function calcKeltner(candles, emaSeries, atrSeries, mult = 2) {
  const upper = emaSeries.map((e, i) => e + mult * atrSeries[i]);
  const lower = emaSeries.map((e, i) => e - mult * atrSeries[i]);
  return { upper, lower, mid: emaSeries };
}

/** Where current ATR% sits vs its own trailing history — a 0-100
 *  percentile, so "volatility is high" can be judged against the stock's
 *  OWN normal range rather than a fixed threshold. */
function calcVolatilityPercentile(atrPctSeries, lookback = 252) {
  const n = atrPctSeries.length;
  if (n < 10) return null;
  const window = atrPctSeries.slice(-Math.min(lookback, n));
  const current = window[window.length - 1];
  const below = window.filter((v) => v <= current).length;
  return Number(((below / window.length) * 100).toFixed(1));
}

// ── Parabolic SAR ────────────────────────────────────────────────────────
function calcParabolicSAR(candles, step = 0.02, maxStep = 0.2) {
  if (candles.length < 2) return candles.map(() => null);
  const out = [];
  let isUp = candles[1].c > candles[0].c;
  let sar = isUp ? candles[0].l : candles[0].h;
  let ep = isUp ? candles[0].h : candles[0].l;
  let af = step;
  out.push(sar);
  for (let i = 1; i < candles.length; i++) {
    let nextSar = sar + af * (ep - sar);
    if (isUp) {
      nextSar = Math.min(nextSar, candles[i - 1].l, i > 1 ? candles[i - 2].l : candles[i - 1].l);
      if (candles[i].l < nextSar) {
        isUp = false; nextSar = ep; ep = candles[i].l; af = step;
      } else if (candles[i].h > ep) { ep = candles[i].h; af = Math.min(af + step, maxStep); }
    } else {
      nextSar = Math.max(nextSar, candles[i - 1].h, i > 1 ? candles[i - 2].h : candles[i - 1].h);
      if (candles[i].h > nextSar) {
        isUp = true; nextSar = ep; ep = candles[i].h; af = step;
      } else if (candles[i].l < ep) { ep = candles[i].l; af = Math.min(af + step, maxStep); }
    }
    sar = nextSar;
    out.push(Number(sar.toFixed(2)));
  }
  return out;
}

// ── Ichimoku Cloud ───────────────────────────────────────────────────────
function ichimokuLine(candles, period, i) {
  const start = Math.max(0, i - period + 1);
  const slice = candles.slice(start, i + 1);
  if (!slice.length) return null;
  const hh = Math.max(...slice.map((c) => c.h));
  const ll = Math.min(...slice.map((c) => c.l));
  return (hh + ll) / 2;
}

function calcIchimoku(candles) {
  const n = candles.length;
  const tenkan = [], kijun = [], senkouA = [], senkouB = [];
  for (let i = 0; i < n; i++) {
    tenkan.push(ichimokuLine(candles, 9, i));
    kijun.push(ichimokuLine(candles, 26, i));
  }
  for (let i = 0; i < n; i++) {
    senkouA.push(tenkan[i] != null && kijun[i] != null ? (tenkan[i] + kijun[i]) / 2 : null);
    senkouB.push(ichimokuLine(candles, 52, i));
  }
  const chikou = candles.map((c) => c.c); // plotted 26 back in charting UIs
  const last = n - 1;
  const cloudTop = senkouA[last] != null && senkouB[last] != null ? Math.max(senkouA[last], senkouB[last]) : null;
  const cloudBottom = senkouA[last] != null && senkouB[last] != null ? Math.min(senkouA[last], senkouB[last]) : null;
  let priceVsCloud = 'Unknown';
  if (cloudTop != null && cloudBottom != null) {
    const px = candles[last].c;
    priceVsCloud = px > cloudTop ? 'Above the cloud (bullish structure)'
      : px < cloudBottom ? 'Below the cloud (bearish structure)'
      : 'Inside the cloud (indecisive structure)';
  }
  return { tenkan, kijun, senkouA, senkouB, chikou, priceVsCloud, cloudTop, cloudBottom };
}

// ── Pivot points (classic floor-trader formula, from the PRIOR bar) ─────
function calcClassicPivots(prevCandle) {
  if (!prevCandle) return null;
  const { h, l, c } = prevCandle;
  const pivot = (h + l + c) / 3;
  const r1 = 2 * pivot - l, s1 = 2 * pivot - h;
  const r2 = pivot + (h - l), s2 = pivot - (h - l);
  const r3 = h + 2 * (pivot - l), s3 = l - 2 * (h - pivot);
  const round2 = (x) => Number(x.toFixed(2));
  return { pivot: round2(pivot), r1: round2(r1), r2: round2(r2), r3: round2(r3), s1: round2(s1), s2: round2(s2), s3: round2(s3) };
}

// ── Anchored VWAP — VWAP recomputed from a chosen candle index onward ───
// (e.g. anchored to an earnings date, a swing low, or the start of the
// visible chart range) instead of the whole series.
function calcAnchoredVWAP(candles, anchorIndex = 0) {
  let cumPV = 0, cumV = 0;
  const out = new Array(candles.length).fill(null);
  for (let i = anchorIndex; i < candles.length; i++) {
    const typical = (candles[i].h + candles[i].l + candles[i].c) / 3;
    cumPV += typical * candles[i].v;
    cumV += candles[i].v;
    out[i] = cumV ? Number((cumPV / cumV).toFixed(2)) : typical;
  }
  return out;
}

module.exports = {
  calcWMA, calcHMA,
  calcStochastic, calcStochRSI, calcCCI, calcROC, calcWilliamsR, calcMFI,
  calcOBV, calcADLine, calcCMF, calcVPT, detectVolumeSpikes,
  calcDonchian, calcKeltner, calcVolatilityPercentile,
  calcParabolicSAR, calcIchimoku, calcClassicPivots, calcAnchoredVWAP,
};

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

/** Real Average Directional Index (Wilder's method) — measures trend
 *  STRENGTH (not direction). Used for the "Trend Strength (ADX)" section
 *  of the full technical report. Computed purely from real OHLC candles. */
function calcADX(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const plusDM = [0], minusDM = [0], tr = [0];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].h - candles[i - 1].h;
    const downMove = candles[i - 1].l - candles[i].l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    ));
  }
  const smooth = (arr) => {
    const out = [arr.slice(0, period).reduce((a, b) => a + b, 0)];
    for (let i = period; i < arr.length; i++) {
      out.push(out[out.length - 1] - out[out.length - 1] / period + arr[i]);
    }
    return out;
  };
  const trS = smooth(tr), plusDMS = smooth(plusDM), minusDMS = smooth(minusDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    const plusDI = trS[i] ? (plusDMS[i] / trS[i]) * 100 : 0;
    const minusDI = trS[i] ? (minusDMS[i] / trS[i]) * 100 : 0;
    const sum = plusDI + minusDI;
    dx.push(sum ? (Math.abs(plusDI - minusDI) / sum) * 100 : 0);
  }
  if (dx.length < period) return { adx: dx[dx.length - 1] || 0, plusDI: 0, minusDI: 0 };
  const adxSeries = [dx.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < dx.length; i++) {
    adxSeries.push((adxSeries[adxSeries.length - 1] * (period - 1) + dx[i]) / period);
  }
  const lastIdx = trS.length - 1;
  return {
    adx: Number(adxSeries[adxSeries.length - 1].toFixed(1)),
    plusDI: Number(((plusDMS[lastIdx] / (trS[lastIdx] || 1)) * 100).toFixed(1)),
    minusDI: Number(((minusDMS[lastIdx] / (trS[lastIdx] || 1)) * 100).toFixed(1)),
  };
}

/** Real Fibonacci retracement levels computed from the actual swing
 *  high/low over the lookback window (not invented). Also reports which
 *  zone the current price is sitting in, for a descriptive "Fibonacci
 *  Zone" line — never a price target or trade instruction. */
function calcFibonacciLevels(candles, lookback = 120) {
  const slice = candles.slice(-lookback);
  if (!slice.length) return null;
  const swingHigh = Math.max(...slice.map((c) => c.h));
  const swingLow = Math.min(...slice.map((c) => c.l));
  const range = swingHigh - swingLow;
  if (!range) return null;
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
  const levels = ratios.map((r) => Number((swingHigh - range * r).toFixed(2)));
  const lastClose = slice[slice.length - 1].c;
  const retracementPct = Number((((swingHigh - lastClose) / range) * 100).toFixed(1));
  let zone = 'Outside the recent swing range';
  if (lastClose <= swingHigh && lastClose >= swingLow) {
    if (retracementPct <= 23.6) zone = '0–23.6% retracement (near the swing high)';
    else if (retracementPct <= 38.2) zone = '23.6–38.2% retracement (shallow pullback zone)';
    else if (retracementPct <= 61.8) zone = '38.2–61.8% retracement (the classic decision zone)';
    else if (retracementPct <= 78.6) zone = '61.8–78.6% retracement (deep pullback zone)';
    else zone = '78.6–100% retracement (near the swing low)';
  }
  return { swingHigh, swingLow, levels: Object.fromEntries(ratios.map((r, i) => [String(r), levels[i]])), retracementPct, zone };
}

/** Rule-based, descriptive candlestick read over the last few real candles.
 *  Reports a PATTERN NAME and what it typically indicates about buyer/seller
 *  balance — it is deliberately phrased as an observation, never a signal to
 *  act on. */
function describeCandlestickPattern(candles) {
  if (!candles || candles.length < 3) return { pattern: 'Insufficient data', note: 'Not enough candles to read a pattern.' };
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const body = Math.abs(last.c - last.o);
  const range = last.h - last.l || 0.0001;
  const upperWick = last.h - Math.max(last.c, last.o);
  const lowerWick = Math.min(last.c, last.o) - last.l;
  const bodyPct = body / range;

  const prevBody = Math.abs(prev.c - prev.o);
  const isBullishEngulf = last.c > last.o && prev.c < prev.o && last.c >= prev.o && last.o <= prev.c;
  const isBearishEngulf = last.c < last.o && prev.c > prev.o && last.o >= prev.c && last.c <= prev.o;

  if (isBullishEngulf) return { pattern: 'Bullish Engulfing', note: 'The latest candle\'s real body fully covers the prior candle\'s body — a classic sign of a shift in short-term buyer/seller control.' };
  if (isBearishEngulf) return { pattern: 'Bearish Engulfing', note: 'The latest candle\'s real body fully covers the prior candle\'s body in the opposite direction — often marks short-term momentum stalling.' };
  if (bodyPct < 0.12) return { pattern: 'Doji / Indecision', note: 'Open and close are nearly equal — reflects balance between buyers and sellers rather than a clear directional push.' };
  if (lowerWick > body * 2 && upperWick < body * 0.6) return { pattern: 'Hammer-like candle', note: 'A long lower wick shows sellers pushed price down but buyers stepped in before the close.' };
  if (upperWick > body * 2 && lowerWick < body * 0.6) return { pattern: 'Shooting-star-like candle', note: 'A long upper wick shows buyers pushed price up but sellers stepped in before the close.' };
  if (bodyPct > 0.7) return { pattern: last.c > last.o ? 'Strong bullish candle (large body)' : 'Strong bearish candle (large body)', note: 'A large real body with small wicks shows one side was in control for most of the session.' };
  return { pattern: 'Small-bodied / consolidation candle', note: 'Small real body relative to the day\'s range — consistent with consolidation rather than a decisive move.' };
}

/** Describes where price sits relative to the Bollinger Bands, and whether
 *  the bands are pinched (low volatility) or wide (high volatility) — purely
 *  descriptive, no signal. */
function describeBollingerPosition(currentPrice, bb) {
  const width = bb.upper - bb.lower;
  const widthPct = bb.mid ? (width / bb.mid) * 100 : 0;
  let position;
  if (currentPrice >= bb.upper) position = 'At or above the upper band';
  else if (currentPrice <= bb.lower) position = 'At or below the lower band';
  else if (currentPrice >= bb.mid) position = 'Between the middle and upper band';
  else position = 'Between the lower and middle band';
  const squeeze = widthPct < 4 ? 'Bands are pinched — volatility is historically low, often before an expansion.'
    : widthPct > 12 ? 'Bands are wide — volatility has recently expanded.'
    : 'Band width is unremarkable — normal volatility.';
  return { position, widthPct: Number(widthPct.toFixed(2)), squeeze };
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
  const adxData = calcADX(candles) || { adx: 0, plusDI: 0, minusDI: 0 };
  const fib = calcFibonacciLevels(candles);
  const candlePattern = describeCandlestickPattern(candles);
  const avgVolume20 = Number((candles.slice(-20).reduce((s, c) => s + c.v, 0) / Math.min(20, candles.length)).toFixed(0));
  const volumeRatio = avgVolume20 ? Number((candles[last].v / avgVolume20).toFixed(2)) : null;
  const bbPosition = describeBollingerPosition(closes[last], {
    upper: bb.upper[last], mid: bb.mid[last], lower: bb.lower[last],
  });

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
    bollingerPosition: bbPosition.position,
    bollingerWidthPct: bbPosition.widthPct,
    bollingerSqueezeNote: bbPosition.squeeze,
    vwap: Number(vwap[last].toFixed(2)),
    atr: Number(atr[last].toFixed(2)),
    atrPct: Number(((atr[last] / closes[last]) * 100).toFixed(2)),
    supertrend: Number(supertrend[last].value.toFixed(2)),
    supertrendDirection: supertrend[last].trendUp ? 'bullish' : 'bearish',
    support: Number(support.toFixed(2)),
    resistance: Number(resistance.toFixed(2)),
    trendStrength: Number(trendStrength.toFixed(1)),
    adx: adxData.adx,
    plusDI: adxData.plusDI,
    minusDI: adxData.minusDI,
    fibonacci: fib,
    candlePattern: candlePattern.pattern,
    candlePatternNote: candlePattern.note,
    volume: candles[last].v,
    avgVolume20,
    volumeRatio,
  };
}

// ── Full descriptive technical report — purely rule-based (no AI/LLM). ──
// Assembles every section Harish's target report format needs (Trend, Price
// Action, Support/Resistance, Moving Average, RSI, MACD, Volume, Candlestick
// Analysis, Volatility, Trend Strength/ADX, Bollinger Bands, Fibonacci Zone,
// Indicator Summary, Technical Score, Conclusion) directly from real computed
// numbers. COMPLIANCE: every sentence here is a DESCRIPTION of what the data
// currently shows — nothing here is or implies a buy/sell/hold instruction,
// a price target, or a prediction. This is the shared shape used by both the
// Screener's rule-based report and as grounding context for the AI Analysis
// prompt (see aiService.js buildPrompt), so the two features stay consistent.
function buildFullTechnicalReport(ind, meta = {}) {
  if (!ind) return null;
  const trendLabel = ind.ema20 > ind.ema50 ? 'Bullish' : ind.ema20 < ind.ema50 ? 'Bearish' : 'Neutral';
  const trendDesc = Math.abs(ind.trendStrength - 50) < 8
    ? 'Neutral to sideways — no strong directional lean.'
    : ind.trendStrength >= 50
      ? `Leaning bullish — price structure and moving averages are tilted upward.`
      : `Leaning bearish — price structure and moving averages are tilted downward.`;

  const rsiSignal = ind.rsi >= 70 ? 'Overbought' : ind.rsi <= 30 ? 'Oversold' : 'Neutral';
  const macdSignal = ind.macdHistogram > 0 ? 'Bullish momentum (histogram positive)' : ind.macdHistogram < 0 ? 'Bearish momentum (histogram negative)' : 'Flat momentum';

  const adxStrengthDesc = ind.adx >= 25 ? 'Strong trend' : ind.adx >= 15 ? 'Developing trend' : 'Weak / range-bound trend';

  const volumeDesc = ind.volumeRatio == null ? 'Volume data unavailable.'
    : ind.volumeRatio >= 1.5 ? `Volume is running high — about ${ind.volumeRatio}× the 20-day average.`
    : ind.volumeRatio <= 0.6 ? `Volume is running light — about ${ind.volumeRatio}× the 20-day average.`
    : `Volume is close to its 20-day average (${ind.volumeRatio}×).`;

  const volatilityDesc = ind.atrPct >= 3 ? `Volatility is elevated — ATR is roughly ${ind.atrPct}% of price.`
    : ind.atrPct <= 1 ? `Volatility is low — ATR is roughly ${ind.atrPct}% of price.`
    : `Volatility is moderate — ATR is roughly ${ind.atrPct}% of price.`;

  // Four 0-100 sub-scores that together make up the overall technical score —
  // purely descriptive strength readings, never a recommendation.
  const trendScore = Math.round(Math.max(0, Math.min(100, ind.trendStrength)));
  const momentumScore = Math.round(Math.max(0, Math.min(100, 50 + (ind.macdHistogram > 0 ? 15 : -15) + (ind.rsi - 50) * 0.4)));
  const strengthScore = Math.round(Math.max(0, Math.min(100, (ind.adx / 50) * 100)));
  const volatilityScore = Math.round(Math.max(0, Math.min(100, 100 - Math.min(100, ind.atrPct * 12))));
  const overallScore = Math.round((trendScore + momentumScore + strengthScore + volatilityScore) / 4);

  const indicatorSummary = [
    { label: 'Trend', signal: trendLabel },
    { label: 'Price Action', signal: ind.candlePattern },
    { label: 'Moving Average', signal: ind.ema20 > ind.ema50 ? 'Bullish (EMA20 > EMA50)' : 'Bearish (EMA20 < EMA50)' },
    { label: 'RSI', signal: rsiSignal },
    { label: 'MACD', signal: macdSignal.split(' (')[0] },
    { label: 'Trend Strength (ADX)', signal: adxStrengthDesc },
    { label: 'Bollinger Bands', signal: ind.bollingerPosition },
    { label: 'Support', signal: `₹${ind.support}` },
    { label: 'Resistance', signal: `₹${ind.resistance}` },
  ];

  const closeToResistance = ind.resistance && Math.abs(ind.currentPrice - ind.resistance) / ind.currentPrice < 0.02;
  const closeToSupport = ind.support && Math.abs(ind.currentPrice - ind.support) / ind.currentPrice < 0.02;
  const conclusion = `The stock is currently showing a ${trendLabel.toLowerCase()} technical bias with ${adxStrengthDesc.toLowerCase()}. `
    + (closeToResistance ? `Price is trading near its ${meta.lookback || 60}-period resistance of ₹${ind.resistance}. `
       : closeToSupport ? `Price is trading near its ${meta.lookback || 60}-period support of ₹${ind.support}. `
       : `Price is trading between its recent support (₹${ind.support}) and resistance (₹${ind.resistance}). `)
    + `A move beyond either level would meaningfully change this technical picture. This is a description of current data, not an instruction to buy, sell, or hold.`;

  return {
    trend: { label: trendLabel, text: trendDesc, strengthScore: Number(ind.trendStrength.toFixed(0)) },
    priceAction: { pattern: ind.candlePattern, text: ind.candlePatternNote },
    supportResistance: { support: ind.support, resistance: ind.resistance },
    movingAverage: { text: ind.ema20 > ind.ema50 ? `Price/EMA20 (₹${ind.ema20}) is above EMA50 (₹${ind.ema50}) — short-term average leading long-term.` : `EMA20 (₹${ind.ema20}) is below EMA50 (₹${ind.ema50}) — short-term average lagging long-term.`, signal: trendLabel },
    rsi: { value: ind.rsi, signal: rsiSignal, text: `RSI(14) is at ${ind.rsi} — ${rsiSignal.toLowerCase()} territory.` },
    macd: { value: ind.macd, signal: ind.macdHistogram > 0 ? 'Bullish' : ind.macdHistogram < 0 ? 'Bearish' : 'Neutral', text: `MACD histogram is ${ind.macdHistogram}. ${macdSignal}.` },
    volume: { ratio: ind.volumeRatio, text: volumeDesc },
    candlestick: { pattern: ind.candlePattern, text: ind.candlePatternNote },
    volatility: { atr: ind.atr, atrPct: ind.atrPct, text: volatilityDesc },
    trendStrength: { adx: ind.adx, plusDI: ind.plusDI, minusDI: ind.minusDI, text: `ADX is ${ind.adx} — ${adxStrengthDesc.toLowerCase()}. +DI ${ind.plusDI} vs -DI ${ind.minusDI}.` },
    bollinger: { upper: ind.bollingerUpper, mid: ind.bollingerMid, lower: ind.bollingerLower, position: ind.bollingerPosition, text: `${ind.bollingerPosition}. ${ind.bollingerSqueezeNote}` },
    fibonacci: ind.fibonacci ? { ...ind.fibonacci, text: `Price is in the ${ind.fibonacci.zone}.` } : null,
    indicatorSummary,
    technicalScore: { trend: trendScore, momentum: momentumScore, strength: strengthScore, volatility: volatilityScore, overall: overallScore },
    conclusion,
  };
}

// ── Rule-based technical strength meter — purely computed from the real ──
// indicator values above, no AI/LLM involved. Used by the Screener so it
// can be labelled "computed data analysis", distinct from the AI Analysis
// page. Six independent votes are tallied; each is a plain, explainable
// technical rule (trend, momentum, oscillator) so the result can always be
// traced back to real numbers instead of a black box.
//
// COMPLIANCE: this deliberately does NOT return a "BUY"/"SELL"/"HOLD"
// verdict. SEBI's Research Analyst / Investment Adviser regulations treat
// "trading calls" as a regulated activity requiring registration,
// regardless of whether the call is generated by a rule-based formula or
// an AI model — the mechanism doesn't matter, only the output does. This
// app is not SEBI-registered, so it reports the vote tally as a
// descriptive strength reading (e.g. "5/6 bullish votes") and leaves the
// interpretation to the user.
function deriveSignal(ind) {
  if (!ind) return null;
  let score = 0;
  let bullishVotes = 0;
  const votes = [];

  if (ind.rsi <= 30) { score += 1; bullishVotes++; votes.push('RSI oversold'); }
  else if (ind.rsi >= 70) { score -= 1; votes.push('RSI overbought'); }

  if (ind.ema20 > ind.ema50) { score += 1; bullishVotes++; votes.push('EMA20 > EMA50'); }
  else { score -= 1; votes.push('EMA20 < EMA50'); }

  if (ind.macdHistogram > 0) { score += 1; bullishVotes++; votes.push('MACD histogram positive'); }
  else { score -= 1; votes.push('MACD histogram negative'); }

  if (ind.supertrendDirection === 'bullish') { score += 1; bullishVotes++; votes.push('Supertrend bullish'); }
  else { score -= 1; votes.push('Supertrend bearish'); }

  if (ind.currentPrice > ind.vwap) { score += 1; bullishVotes++; votes.push('Price above VWAP'); }
  else { score -= 1; votes.push('Price below VWAP'); }

  if (ind.trendStrength >= 60) { score += 1; bullishVotes++; votes.push('Strong trend'); }
  else if (ind.trendStrength <= -60) { score -= 1; votes.push('Weak/negative trend'); }

  // Descriptive strength label — reports what the data shows, not an
  // instruction. "bullishVotes / 6" is shown directly in the UI.
  const strength = score >= 2 ? 'Strong Bullish Bias' : score <= -2 ? 'Strong Bearish Bias' : 'Mixed / Neutral';
  // Map the -6..+6 vote tally to a 0-100 "technical strength" figure so the
  // UI can show e.g. "78/100 bullish votes" without implying a
  // prediction/probability of any future price move.
  const strengthScore = Math.round(50 + (score / 6) * 50);

  return {
    strength,
    bullishVotes,
    totalVotes: 6,
    score,
    strengthScore: Math.max(0, Math.min(100, strengthScore)),
    votes,
  };
}

module.exports = {
  calcSMA, calcEMA, calcRSI, calcMACD, calcBollinger, calcVWAP, calcATR,
  calcSupertrend, findSupportResistance, calcTrendStrength, calcADX,
  calcFibonacciLevels, describeCandlestickPattern, describeBollingerPosition,
  computeAllIndicators, deriveSignal, buildFullTechnicalReport,
};

// utils/technicalAnalysis.js
// ══════════════════════════════════════════════════════════════════════════
//  Deterministic, rule-based technical read built ONLY from real candles.
//  Every field is null (never estimated) when the history needed to compute
//  it does not exist. The bias is a description of what indicators show NOW,
//  with explicit evidence + an invalidation level — it is not a price forecast.
// ══════════════════════════════════════════════════════════════════════════
const { sma, ema, rsi, macd, bollinger, atr, lastValue } = require('./seriesIndicators');

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const r2 = (v, dp = 2) => (isNum(v) ? Number(v.toFixed(dp)) : null);

const MIN_CANDLES = 30;

/** Wilder ADX(14): trend strength 0–100 (direction-agnostic) plus +DI / −DI. */
function adx(candles, period = 14) {
  const n = candles.length;
  if (n < period * 2 + 1) return null;
  const tr = [], pdm = [], mdm = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.h - p.h, dn = p.l - c.l;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  let sTr = 0, sP = 0, sM = 0;
  for (let i = 0; i < period; i++) { sTr += tr[i]; sP += pdm[i]; sM += mdm[i]; }
  const dxs = [];
  let pdi = 0, mdi = 0;
  for (let i = period; i <= tr.length; i++) {
    if (i > period) {
      sTr = sTr - sTr / period + tr[i - 1];
      sP = sP - sP / period + pdm[i - 1];
      sM = sM - sM / period + mdm[i - 1];
    }
    if (sTr === 0) { dxs.push(0); continue; }
    pdi = (100 * sP) / sTr; mdi = (100 * sM) / sTr;
    dxs.push(pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi));
  }
  if (dxs.length < period) return null;
  let a = dxs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dxs.length; i++) a = (a * (period - 1) + dxs[i]) / period;
  return { adx: a, plusDI: pdi, minusDI: mdi };
}

/** Swing-pivot support/resistance: fractal highs/lows (k bars each side), clustered by ATR tolerance. */
function supportResistance(candles, { k = 3, maxLevels = 3 } = {}) {
  const n = candles.length;
  if (n < k * 2 + 5) return { support: [], resistance: [] };
  const atrNow = lastValue(atr(candles, 14)) || (candles[n - 1].h - candles[n - 1].l);
  const tol = Math.max(atrNow * 0.5, 1e-9);
  const highs = [], lows = [];
  for (let i = k; i < n - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (candles[i].h <= candles[i - j].h || candles[i].h <= candles[i + j].h) isH = false;
      if (candles[i].l >= candles[i - j].l || candles[i].l >= candles[i + j].l) isL = false;
    }
    if (isH) highs.push(candles[i].h);
    if (isL) lows.push(candles[i].l);
  }
  const cluster = (arr) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const groups = [];
    for (const v of sorted) {
      const g = groups[groups.length - 1];
      if (g && v - g.mean <= tol) { g.sum += v; g.n++; g.mean = g.sum / g.n; } else groups.push({ sum: v, n: 1, mean: v });
    }
    return groups.map((g) => ({ level: g.mean, touches: g.n }));
  };
  const last = candles[n - 1].c;
  const res = cluster(highs).filter((l) => l.level > last).sort((a, b) => a.level - b.level).slice(0, maxLevels);
  const sup = cluster(lows).filter((l) => l.level < last).sort((a, b) => b.level - a.level).slice(0, maxLevels);
  const fmt = (l) => ({ level: r2(l.level, 4), touches: l.touches });
  return { support: sup.map(fmt), resistance: res.map(fmt) };
}

/** Relative volume vs 20-bar average. null when the instrument reports no volume. */
function volumeAnalysis(candles) {
  const vols = candles.map((c) => c.v);
  const have = vols.filter((v) => isNum(v) && v > 0).length;
  if (have < 21 || candles.length < 21) return null;
  const last = vols[vols.length - 1];
  const prev20 = vols.slice(-21, -1);
  const avg = prev20.reduce((s, v) => s + (isNum(v) ? v : 0), 0) / 20;
  if (!isNum(last) || avg <= 0) return null;
  const rel = last / avg;
  return { lastVolume: last, avg20: r2(avg, 0), relativeVolume: r2(rel), state: rel >= 1.5 ? 'elevated' : rel <= 0.6 ? 'thin' : 'normal' };
}

/** Breakout / breakdown vs the prior N-bar range (excludes the current bar). */
function breakoutState(candles, lookback = 20) {
  const n = candles.length;
  if (n < lookback + 1) return null;
  const win = candles.slice(n - 1 - lookback, n - 1);
  const hi = Math.max(...win.map((c) => c.h)), lo = Math.min(...win.map((c) => c.l));
  const c = candles[n - 1].c;
  const state = c > hi ? 'breakout' : c < lo ? 'breakdown' : 'inside-range';
  return { state, lookback, priorHigh: r2(hi, 4), priorLow: r2(lo, 4) };
}

/** ATR% and where Bollinger width sits relative to its own history → low/normal/high. */
function volatilityState(candles) {
  const closes = candles.map((c) => c.c);
  const a = lastValue(atr(candles, 14));
  const bb = bollinger(closes);
  const widths = bb.upper.map((u, i) => (u !== null && bb.mid[i] ? (u - bb.lower[i]) / bb.mid[i] : null)).filter(isNum);
  if (!isNum(a) || widths.length < 20) return null;
  const w = widths[widths.length - 1];
  const rank = widths.filter((x) => x <= w).length / widths.length; // percentile within available history
  const lastClose = closes[closes.length - 1];
  return {
    atr14: r2(a, 4), atrPct: lastClose ? r2((a / lastClose) * 100) : null,
    bandwidthPct: r2(w * 100), bandwidthPercentile: r2(rank * 100, 0),
    state: rank >= 0.8 ? 'high' : rank <= 0.2 ? 'low' : 'normal',
  };
}

/** Rate of change over `n` bars, in %. */
const roc = (closes, n) => (closes.length > n && closes[closes.length - 1 - n] ? ((closes[closes.length - 1] / closes[closes.length - 1 - n]) - 1) * 100 : null);

/**
 * Full read. Returns { ok:false, reason } if there isn't enough real data.
 * `bias` ∈ bullish | bearish | neutral from a transparent vote of independent signals.
 */
function analyze(candles) {
  if (!Array.isArray(candles) || candles.length < MIN_CANDLES) {
    return { ok: false, reason: `Only ${candles ? candles.length : 0} real candles available — at least ${MIN_CANDLES} are needed.` };
  }
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1];
  const e20 = lastValue(ema(closes, 20)), e50 = lastValue(ema(closes, 50)), s20 = lastValue(sma(closes, 20));
  const rs = lastValue(rsi(closes, 14));
  const m = macd(closes);
  const mh = lastValue(m.hist), ml = lastValue(m.macd), ms = lastValue(m.signal);
  const aDx = adx(candles);
  const sr = supportResistance(candles);
  const vol = volumeAnalysis(candles);
  const brk = breakoutState(candles);
  const vs = volatilityState(candles);
  const mom = { roc5: r2(roc(closes, 5)), roc10: r2(roc(closes, 10)), roc20: r2(roc(closes, 20)) };

  // Transparent vote: each rule only votes when its inputs exist.
  const votes = []; // {name, vote:+1|-1|0, detail}
  if (isNum(e20)) votes.push({ name: 'Price vs EMA20', vote: last > e20 ? 1 : -1, detail: `close ${r2(last, 4)} ${last > e20 ? 'above' : 'below'} EMA20 ${r2(e20, 4)}` });
  if (isNum(e20) && isNum(e50)) votes.push({ name: 'EMA20 vs EMA50', vote: e20 > e50 ? 1 : -1, detail: `EMA20 ${r2(e20, 4)} ${e20 > e50 ? 'above' : 'below'} EMA50 ${r2(e50, 4)}` });
  if (isNum(rs)) votes.push({ name: 'RSI(14)', vote: rs >= 55 ? 1 : rs <= 45 ? -1 : 0, detail: `RSI ${r2(rs)}${rs >= 70 ? ' (overbought zone)' : rs <= 30 ? ' (oversold zone)' : ''}` });
  if (isNum(mh)) votes.push({ name: 'MACD histogram', vote: mh > 0 ? 1 : mh < 0 ? -1 : 0, detail: `histogram ${r2(mh, 4)} (MACD ${r2(ml, 4)} vs signal ${r2(ms, 4)})` });
  if (aDx && aDx.adx >= 20) votes.push({ name: 'Directional movement', vote: aDx.plusDI > aDx.minusDI ? 1 : -1, detail: `ADX ${r2(aDx.adx)} (trend present), +DI ${r2(aDx.plusDI)} vs −DI ${r2(aDx.minusDI)}` });
  if (brk && brk.state !== 'inside-range') votes.push({ name: 'Range break', vote: brk.state === 'breakout' ? 1 : -1, detail: `${brk.state} vs prior ${brk.lookback}-bar range` });

  const score = votes.reduce((s, v) => s + v.vote, 0);
  const cast = votes.filter((v) => v.vote !== 0).length || 1;
  const strength = Math.abs(score) / votes.length;
  const bias = votes.length < 3 ? 'neutral' : score >= 2 && strength >= 0.34 ? 'bullish' : score <= -2 && strength >= 0.34 ? 'bearish' : 'neutral';

  const atrV = vs && vs.atr14;
  const invalidation = bias === 'bullish'
    ? (sr.support[0] ? sr.support[0].level : (isNum(atrV) ? r2(last - 2 * atrV, 4) : null))
    : bias === 'bearish'
      ? (sr.resistance[0] ? sr.resistance[0].level : (isNum(atrV) ? r2(last + 2 * atrV, 4) : null))
      : null;

  const risks = [];
  if (isNum(rs) && rs >= 70) risks.push('RSI is in the overbought zone — momentum can fade or mean-revert.');
  if (isNum(rs) && rs <= 30) risks.push('RSI is in the oversold zone — selling pressure can persist or reverse.');
  if (vs && vs.state === 'high') risks.push('Volatility is high relative to its own recent history — wider swings, gaps and stop slippage are more likely.');
  if (aDx && aDx.adx < 20) risks.push('ADX is below 20 — no established trend, so directional signals are less reliable.');
  if (vol && vol.state === 'thin') risks.push('Volume is thin versus its 20-bar average — moves may lack participation.');
  if (!vol) risks.push('Volume is not available for this instrument/timeframe, so participation cannot be assessed.');
  if (votes.length - cast > 0 && bias === 'neutral') risks.push('Several indicators are neutral or conflicting.');

  return {
    ok: true,
    candlesUsed: candles.length,
    lastClose: r2(last, 4),
    bias, score, votes,
    trend: {
      strengthAdx: aDx ? r2(aDx.adx) : null,
      state: !aDx ? null : aDx.adx >= 25 ? 'strong' : aDx.adx >= 20 ? 'developing' : 'weak/range-bound',
      plusDI: aDx ? r2(aDx.plusDI) : null, minusDI: aDx ? r2(aDx.minusDI) : null,
    },
    levels: sr, momentum: mom, volume: vol, volatility: vs, breakout: brk,
    averages: { ema20: r2(e20, 4), ema50: r2(e50, 4), sma20: r2(s20, 4) },
    invalidation, risks,
  };
}

module.exports = { analyze, adx, supportResistance, volumeAnalysis, breakoutState, volatilityState, MIN_CANDLES };

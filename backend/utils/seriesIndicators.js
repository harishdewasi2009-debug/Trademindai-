// utils/seriesIndicators.js
// ══════════════════════════════════════════════════════════════════════════
//  Chart-grade indicator series, computed ONLY from real candles.
//  Unlike the legacy helpers in indicators.js (which pad warm-up bars with
//  seeded/neutral values for the scoring engine), every series here returns
//  `null` until enough real history exists — so a chart never draws an
//  indicator value that wasn't actually computable at that bar.
//
//  All functions are pure: (candles|closes) → array aligned 1:1 with input.
// ══════════════════════════════════════════════════════════════════════════

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Simple moving average; null until `period` values exist. */
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values (standard definition). */
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder RSI. null until `period` price changes exist. */
function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  const toRsi = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = toRsi();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + (d > 0 ? d : 0)) / period;
    loss = (loss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = toRsi();
  }
  return out;
}

/** MACD(12,26,9). Lines are null until each component is computable. */
function macd(closes, fast = 12, slow = 26, signalP = 9) {
  const eFast = ema(closes, fast);
  const eSlow = ema(closes, slow);
  const line = closes.map((_, i) => (eFast[i] !== null && eSlow[i] !== null ? eFast[i] - eSlow[i] : null));
  // Signal = EMA of the MACD line, computed over the defined part only.
  const first = line.findIndex((v) => v !== null);
  const signal = new Array(closes.length).fill(null);
  if (first !== -1) {
    const defined = line.slice(first);
    const sig = ema(defined, signalP);
    for (let i = 0; i < sig.length; i++) signal[first + i] = sig[i];
  }
  const hist = line.map((v, i) => (v !== null && signal[i] !== null ? v - signal[i] : null));
  return { macd: line, signal, hist };
}

/** Bollinger Bands (population std-dev, the common charting convention). */
function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (closes[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { upper, mid, lower };
}

/** Wilder ATR. First value at index `period` (needs a previous close for TR). */
function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) => (i === 0
    ? c.h - c.l
    : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c))));
  let a = 0;
  for (let i = 1; i <= period; i++) a += tr[i];
  a /= period;
  out[period] = a;
  for (let i = period + 1; i < candles.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}

/**
 * Session VWAP — resets at each new calendar day (by the candle timestamp's
 * date part), so it is only meaningful on intraday candles and only where
 * the instrument reports volume. Returns all-null when volume is absent.
 */
function vwap(candles, isIntraday) {
  const out = new Array(candles.length).fill(null);
  if (!isIntraday) return out;
  let day = null, pv = 0, vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = String(c.t).slice(0, 10);
    if (d !== day) { day = d; pv = 0; vol = 0; }
    if (isNum(c.v) && c.v > 0) {
      pv += ((c.h + c.l + c.c) / 3) * c.v;
      vol += c.v;
    }
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

const round = (v, dp = 4) => (v === null || v === undefined ? null : Number(v.toFixed(dp)));
const roundArr = (a, dp) => a.map((v) => round(v, dp));

/**
 * Computes every supported indicator for a candle array (oldest-first).
 * `requested` is a list of keys; omit for all.
 */
function computeSeries(candles, { requested, isIntraday = false } = {}) {
  const want = (k) => !requested || requested.includes(k);
  const closes = candles.map((c) => c.c);
  const out = {};
  if (want('ema20')) out.ema20 = roundArr(ema(closes, 20));
  if (want('ema50')) out.ema50 = roundArr(ema(closes, 50));
  if (want('ema200')) out.ema200 = roundArr(ema(closes, 200));
  if (want('sma20')) out.sma20 = roundArr(sma(closes, 20));
  if (want('rsi')) out.rsi = roundArr(rsi(closes, 14), 2);
  if (want('macd')) {
    const m = macd(closes);
    out.macd = { macd: roundArr(m.macd), signal: roundArr(m.signal), hist: roundArr(m.hist) };
  }
  if (want('bb')) {
    const b = bollinger(closes);
    out.bb = { upper: roundArr(b.upper), mid: roundArr(b.mid), lower: roundArr(b.lower) };
  }
  if (want('atr')) out.atr = roundArr(atr(candles, 14));
  if (want('vwap')) out.vwap = roundArr(vwap(candles, isIntraday));
  return out;
}

/** Last non-null value of an array (for summary snapshots). */
function lastValue(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined) return arr[i];
  return null;
}

const COMPUTABLE_INDICATORS = ['ema20', 'ema50', 'ema200', 'sma20', 'rsi', 'macd', 'bb', 'atr', 'vwap'];

module.exports = { sma, ema, rsi, macd, bollinger, atr, vwap, computeSeries, lastValue, COMPUTABLE_INDICATORS };

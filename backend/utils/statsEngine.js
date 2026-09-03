// utils/statsEngine.js
// ══════════════════════════════════════════════════════════════════════════
//  Statistical & risk engine — pure math over REAL closing-price series
//  (as already fetched by marketDataService). Same principle as
//  indicators.js: nothing here invents or randomizes a data point. If the
//  input candles are real, every number below is a real, reproducible
//  calculation over them.
//
//  COMPLIANCE: every function returns a MEASURED statistic about historical
//  data (volatility, drawdown, Sharpe, VaR, etc.), never a forecast, target,
//  or buy/sell instruction. Sharpe/Sortino/VaR describe what already
//  happened, not what will happen — callers must not present them as
//  guarantees of future performance.
// ══════════════════════════════════════════════════════════════════════════

const TRADING_DAYS_PER_YEAR = 252;

// ── Returns ──────────────────────────────────────────────────────────────
function dailyReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    out.push(closes[i - 1] ? (closes[i] - closes[i - 1]) / closes[i - 1] : 0);
  }
  return out;
}

function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    out.push(closes[i - 1] > 0 && closes[i] > 0 ? Math.log(closes[i] / closes[i - 1]) : 0);
  }
  return out;
}

/** Return over the trailing `bars` candles, as a percentage. */
function periodReturnPct(closes, bars) {
  if (closes.length < bars + 1) return null;
  const start = closes[closes.length - 1 - bars];
  const end = closes[closes.length - 1];
  return start ? Number((((end - start) / start) * 100).toFixed(2)) : null;
}

function cumulativeReturnPct(closes) {
  if (closes.length < 2) return null;
  return periodReturnPct(closes, closes.length - 1);
}

// ── Central moments / distribution ──────────────────────────────────────
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function stdev(arr, sample = true) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - (sample ? 1 : 0));
  return Math.sqrt(variance);
}

function variance(arr, sample = true) { return stdev(arr, sample) ** 2; }

/** Standard deviation of only the negative (below-target) returns — the
 *  denominator for the Sortino ratio, since upside volatility shouldn't be
 *  penalised the way downside volatility is. */
function downsideDeviation(returns, target = 0) {
  const downside = returns.filter((r) => r < target).map((r) => (r - target) ** 2);
  if (!downside.length) return 0;
  return Math.sqrt(downside.reduce((a, b) => a + b, 0) / returns.length);
}

function skewness(arr) {
  const n = arr.length;
  if (n < 3) return 0;
  const m = mean(arr), sd = stdev(arr, false);
  if (!sd) return 0;
  const s = arr.reduce((a, x) => a + ((x - m) / sd) ** 3, 0);
  return Number(((n / ((n - 1) * (n - 2))) * s).toFixed(3));
}

function kurtosis(arr) {
  // Excess kurtosis (normal distribution = 0).
  const n = arr.length;
  if (n < 4) return 0;
  const m = mean(arr), sd = stdev(arr, false);
  if (!sd) return 0;
  const s = arr.reduce((a, x) => a + ((x - m) / sd) ** 4, 0);
  const g2 = (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3)) * s
    - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return Number(g2.toFixed(3));
}

// ── Volatility ───────────────────────────────────────────────────────────
/** Annualised historical volatility (%) from daily returns. */
function historicalVolatilityPct(closes) {
  const rets = dailyReturns(closes);
  if (rets.length < 2) return null;
  return Number((stdev(rets) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100).toFixed(2));
}

// ── Drawdown ─────────────────────────────────────────────────────────────
/** Max drawdown (%) over the series, plus how many bars it took to recover
 *  (null if the series never made a new high after the trough, i.e. still
 *  underwater as of the last candle). */
function maxDrawdown(closes) {
  let peak = closes[0], peakIdx = 0;
  let maxDd = 0, troughIdx = 0, ddPeakIdx = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > peak) { peak = closes[i]; peakIdx = i; }
    const dd = peak ? (closes[i] - peak) / peak : 0;
    if (dd < maxDd) { maxDd = dd; troughIdx = i; ddPeakIdx = peakIdx; }
  }
  let recoveryBars = null;
  if (maxDd < 0) {
    const peakVal = closes[ddPeakIdx];
    for (let i = troughIdx + 1; i < closes.length; i++) {
      if (closes[i] >= peakVal) { recoveryBars = i - troughIdx; break; }
    }
  }
  return {
    maxDrawdownPct: Number((maxDd * 100).toFixed(2)),
    peakIndex: ddPeakIdx,
    troughIndex: troughIdx,
    recoveryBars, // null = hasn't recovered yet within this window
  };
}

// ── Risk-adjusted return ratios ─────────────────────────────────────────
/** Sharpe ratio, annualised, from daily returns and an annual risk-free
 *  rate (default 6.5% — a commonly used proxy for the Indian T-bill rate;
 *  callers can override). Describes historical risk-adjusted return, not a
 *  forecast. */
function sharpeRatio(closes, riskFreeAnnualPct = 6.5) {
  const rets = dailyReturns(closes);
  if (rets.length < 2) return null;
  const rf = riskFreeAnnualPct / 100 / TRADING_DAYS_PER_YEAR;
  const excess = rets.map((r) => r - rf);
  const sd = stdev(excess);
  if (!sd) return null;
  return Number(((mean(excess) / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR)).toFixed(2));
}

function sortinoRatio(closes, riskFreeAnnualPct = 6.5) {
  const rets = dailyReturns(closes);
  if (rets.length < 2) return null;
  const rf = riskFreeAnnualPct / 100 / TRADING_DAYS_PER_YEAR;
  const excess = rets.map((r) => r - rf);
  const dd = downsideDeviation(excess, 0);
  if (!dd) return null;
  return Number(((mean(excess) / dd) * Math.sqrt(TRADING_DAYS_PER_YEAR)).toFixed(2));
}

/** Calmar ratio = annualised return / |max drawdown|. */
function calmarRatio(closes) {
  const rets = dailyReturns(closes);
  if (rets.length < 2) return null;
  const annualReturn = mean(rets) * TRADING_DAYS_PER_YEAR;
  const { maxDrawdownPct } = maxDrawdown(closes);
  if (!maxDrawdownPct) return null;
  return Number((annualReturn / (Math.abs(maxDrawdownPct) / 100)).toFixed(2));
}

// ── Value at Risk ────────────────────────────────────────────────────────
/** Historical (non-parametric) VaR — the loss threshold not exceeded in
 *  `confidence`% of historical days. Conditional VaR (Expected Shortfall)
 *  is the average loss on days WORSE than that threshold. Both expressed
 *  as positive percentages (magnitude of loss). */
function historicalVaR(closes, confidence = 0.95) {
  const rets = dailyReturns(closes).slice().sort((a, b) => a - b);
  if (rets.length < 10) return { varPct: null, cVarPct: null };
  const idx = Math.floor((1 - confidence) * rets.length);
  const varReturn = rets[idx];
  const tail = rets.slice(0, idx + 1);
  const cVarReturn = tail.length ? mean(tail) : varReturn;
  return {
    varPct: Number((Math.abs(varReturn) * 100).toFixed(2)),
    cVarPct: Number((Math.abs(cVarReturn) * 100).toFixed(2)),
    confidence,
  };
}

// ── Correlation / beta / alpha vs a benchmark (e.g. NIFTY 50) ───────────
function correlation(retsA, retsB) {
  const n = Math.min(retsA.length, retsB.length);
  if (n < 3) return null;
  const a = retsA.slice(-n), b = retsB.slice(-n);
  const ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  const denom = Math.sqrt(va * vb);
  return denom ? Number((cov / denom).toFixed(3)) : null;
}

/** Beta (systematic risk vs benchmark) and Jensen's alpha (annualised %,
 *  the return NOT explained by beta-adjusted benchmark movement). */
function betaAlpha(stockCloses, benchmarkCloses, riskFreeAnnualPct = 6.5) {
  const rA = dailyReturns(stockCloses);
  const rB = dailyReturns(benchmarkCloses);
  const n = Math.min(rA.length, rB.length);
  if (n < 10) return { beta: null, alphaPct: null };
  const a = rA.slice(-n), b = rB.slice(-n);
  const mb = mean(b);
  const varB = b.reduce((s, x) => s + (x - mb) ** 2, 0) / n;
  if (!varB) return { beta: null, alphaPct: null };
  const ma = mean(a);
  const cov = a.reduce((s, x, i) => s + (x - ma) * (b[i] - mb), 0) / n;
  const beta = cov / varB;
  const rf = riskFreeAnnualPct / 100 / TRADING_DAYS_PER_YEAR;
  const expected = rf + beta * (mb - rf);
  const alphaDaily = ma - expected;
  return {
    beta: Number(beta.toFixed(2)),
    alphaPct: Number((alphaDaily * TRADING_DAYS_PER_YEAR * 100).toFixed(2)),
  };
}

/** Relative strength: how the stock's return over `bars` compares to the
 *  benchmark's return over the same window. >1 = outperforming. */
function relativeStrength(stockCloses, benchmarkCloses, bars = 20) {
  const s = periodReturnPct(stockCloses, bars);
  const b = periodReturnPct(benchmarkCloses, bars);
  if (s == null || b == null) return null;
  return {
    stockReturnPct: s,
    benchmarkReturnPct: b,
    relativeReturnPct: Number((s - b).toFixed(2)),
    // Ratio form guards against a benchmark return near zero blowing up.
    label: s > b ? 'Outperforming benchmark' : s < b ? 'Underperforming benchmark' : 'In line with benchmark',
  };
}

// ── Position sizing / risk-reward (generic, user supplies the inputs) ───
// COMPLIANCE: TradeMind never assumes the user's acceptable loss or capital
// — both are required inputs the user must supply themselves. This is a
// plain arithmetic calculator, not a recommendation of how much to risk.
function positionSize({ capital, riskPct, entryPrice, stopPrice }) {
  if (!capital || !riskPct || !entryPrice || !stopPrice) return null;
  const riskPerUnit = Math.abs(entryPrice - stopPrice);
  if (!riskPerUnit) return null;
  const maxLossAmount = capital * (riskPct / 100);
  const qty = Math.floor(maxLossAmount / riskPerUnit);
  return {
    maxLossAmount: Number(maxLossAmount.toFixed(2)),
    riskPerUnit: Number(riskPerUnit.toFixed(2)),
    suggestedQuantity: qty,
    positionValue: Number((qty * entryPrice).toFixed(2)),
  };
}

function riskReward({ entryPrice, stopPrice, targetPrice }) {
  if (!entryPrice || !stopPrice || !targetPrice) return null;
  const risk = Math.abs(entryPrice - stopPrice);
  const reward = Math.abs(targetPrice - entryPrice);
  if (!risk) return null;
  return {
    risk: Number(risk.toFixed(2)),
    reward: Number(reward.toFixed(2)),
    ratio: Number((reward / risk).toFixed(2)),
  };
}

/** Kelly criterion — the theoretically-optimal fraction of capital to risk
 *  per trade GIVEN a strategy's own historical win rate and average win/
 *  loss size (e.g. from a backtestEngine.js result). Uses "half-Kelly" as
 *  the headline figure too, since full Kelly is well known to be too
 *  aggressive/volatile for most real trading. Purely a historical-stats
 *  calculation over numbers the caller supplies — never a recommendation
 *  to risk any specific amount. */
function kellyFraction({ winRatePct, avgWinPct, avgLossPct }) {
  if (winRatePct == null || avgWinPct == null || avgLossPct == null || !avgLossPct) return null;
  const w = winRatePct / 100;
  const b = Math.abs(avgWinPct / avgLossPct); // win/loss size ratio
  if (!b) return null;
  const kelly = w - (1 - w) / b;
  return {
    fullKellyPct: Number((kelly * 100).toFixed(2)),
    halfKellyPct: Number(((kelly / 2) * 100).toFixed(2)),
    note: 'Theoretical optimum from this strategy\'s OWN historical win rate and win/loss size — full Kelly is commonly considered too aggressive in practice; many traders use half-Kelly or less. Not a recommendation of how much to risk.',
  };
}

module.exports = {
  dailyReturns, logReturns, periodReturnPct, cumulativeReturnPct,
  mean, stdev, variance, downsideDeviation, skewness, kurtosis,
  historicalVolatilityPct, maxDrawdown, sharpeRatio, sortinoRatio, calmarRatio,
  historicalVaR, correlation, betaAlpha, relativeStrength,
  positionSize, riskReward, kellyFraction, TRADING_DAYS_PER_YEAR,
};

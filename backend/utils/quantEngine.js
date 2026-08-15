// utils/quantEngine.js
// ══════════════════════════════════════════════════════════════════════════
//  TradeMind Quant Engine — 35 statistical / probabilistic / risk metrics.
//  Every function is pure math over REAL OHLCV candles (same Upstox candles
//  utils/indicators.js already uses) or the log-return series derived from
//  them. Nothing here calls an LLM and nothing here fabricates data — if the
//  input candles are real, every output below is a real computed number.
//
//  This module intentionally stays "quant terminal" territory rather than
//  "AI terminal": Bayesian regime %, HMM-style state classification, and PCA
//  factor compression are all closed-form / rule-based approximations, not
//  model inference — each is labeled as an ESTIMATE in its output, per the
//  compliance pattern already used in indicators.js.
// ══════════════════════════════════════════════════════════════════════════

const round = (n, d = 4) => (Number.isFinite(n) ? Number(n.toFixed(d)) : null);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const stdev = (arr, m = mean(arr)) => {
  if (arr.length < 2) return 0;
  const v = arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1);
  return Math.sqrt(v);
};

// 1. Log returns
function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}

// 2. Realized (historical) volatility — annualized
function realizedVolatility(returns, periodsPerYear = 252) {
  return round(stdev(returns) * Math.sqrt(periodsPerYear) * 100, 2); // %
}

// 3. EWMA (RiskMetrics-style) volatility — annualized
function ewmaVolatility(returns, lambda = 0.94, periodsPerYear = 252) {
  if (!returns.length) return null;
  let variance = returns[0] * returns[0];
  for (let i = 1; i < returns.length; i++) {
    variance = lambda * variance + (1 - lambda) * returns[i] * returns[i];
  }
  return round(Math.sqrt(variance) * Math.sqrt(periodsPerYear) * 100, 2); // %
}

// 4. ATR-based expected daily range, as % of price (reuses ATR concept)
function atrRangePct(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  const atr = mean(trs.slice(-period));
  return round((atr / candles[candles.length - 1].c) * 100, 2);
}

// 5. Z-score of latest price vs its own recent distribution
function zScore(values, lookback = 20) {
  const window = values.slice(-lookback);
  const m = mean(window), sd = stdev(window, m);
  const last = values[values.length - 1];
  return sd ? round((last - m) / sd, 2) : 0;
}

// 6. Pearson correlation between two return series
function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const x = a.slice(-n), y = b.slice(-n);
  const mx = mean(x), my = mean(y);
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; }
  return (vx && vy) ? round(cov / Math.sqrt(vx * vy), 3) : null;
}

// 7. Beta vs a benchmark return series
function beta(stockReturns, benchmarkReturns) {
  const n = Math.min(stockReturns.length, benchmarkReturns.length);
  if (n < 2) return null;
  const x = benchmarkReturns.slice(-n), y = stockReturns.slice(-n);
  const mx = mean(x), my = mean(y);
  let cov = 0, varX = 0;
  for (let i = 0; i < n; i++) { cov += (x[i] - mx) * (y[i] - my); varX += (x[i] - mx) ** 2; }
  return varX ? round(cov / varX, 3) : null;
}

// 8. Sharpe ratio (annualized, rf given as annual decimal e.g. 0.065)
function sharpeRatio(returns, rf = 0.065, periodsPerYear = 252) {
  if (returns.length < 2) return null;
  const periodRf = rf / periodsPerYear;
  const excess = returns.map((r) => r - periodRf);
  const sd = stdev(excess);
  return sd ? round((mean(excess) / sd) * Math.sqrt(periodsPerYear), 3) : null;
}

// 9. Sortino ratio (downside deviation only)
function sortinoRatio(returns, rf = 0.065, periodsPerYear = 252) {
  if (returns.length < 2) return null;
  const periodRf = rf / periodsPerYear;
  const excess = returns.map((r) => r - periodRf);
  const downside = excess.filter((r) => r < 0);
  const dd = Math.sqrt(mean(downside.map((r) => r * r)));
  return dd ? round((mean(excess) / dd) * Math.sqrt(periodsPerYear), 3) : null;
}

// 10. Maximum drawdown, from an equity/price series
function maxDrawdown(closes) {
  let peak = closes[0], mdd = 0;
  for (const p of closes) { peak = Math.max(peak, p); mdd = Math.max(mdd, (peak - p) / peak); }
  return round(mdd * 100, 2); // %
}

// 11. Expected value of a trade given win prob / avg win / avg loss
function expectedValue(winProb, avgWin, avgLoss) {
  return round(winProb * avgWin - (1 - winProb) * Math.abs(avgLoss), 4);
}

// 12. Kelly criterion position sizing fraction
function kellyCriterion(winProb, avgWin, avgLoss) {
  if (!avgLoss) return null;
  const b = Math.abs(avgWin / avgLoss);
  const f = (b * winProb - (1 - winProb)) / b;
  return round(Math.max(0, Math.min(f, 1)) * 100, 2); // % of capital, floored at 0
}

// 13. Shannon entropy of the up/down/flat move distribution — market uncertainty
function shannonEntropy(returns) {
  if (!returns.length) return null;
  const up = returns.filter((r) => r > 0.0005).length;
  const down = returns.filter((r) => r < -0.0005).length;
  const flat = returns.length - up - down;
  const probs = [up, down, flat].map((c) => c / returns.length).filter((p) => p > 0);
  const h = -probs.reduce((s, p) => s + p * Math.log2(p), 0);
  return round(h, 3); // max ~1.585 for 3 equally likely states
}

// 14. Autocorrelation at lag k — momentum (+) vs mean-reversion (-)
function autocorrelation(returns, lag = 1) {
  const n = returns.length - lag;
  if (n < 2) return null;
  const m = mean(returns);
  let num = 0, den = 0;
  for (let i = 0; i < returns.length; i++) den += (returns[i] - m) ** 2;
  for (let i = 0; i < n; i++) num += (returns[i] - m) * (returns[i + lag] - m);
  return den ? round(num / den, 3) : null;
}

// 15/16. Linear regression of closes over time + R² (trend slope & quality)
function linearRegression(values) {
  const n = values.length;
  if (n < 2) return { slope: null, intercept: null, r2: null };
  const xs = values.map((_, i) => i);
  const mx = mean(xs), my = mean(values);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (values[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0;
  const intercept = my - slope * mx;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = slope * xs[i] + intercept;
    ssRes += (values[i] - pred) ** 2;
    ssTot += (values[i] - my) ** 2;
  }
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;
  return { slope: round(slope, 5), intercept: round(intercept, 2), r2: round(r2, 3) };
}

// 17. Monte Carlo forward price simulation (percentile scenario fan)
function monteCarloSimulation(closes, returns, { horizonDays = 10, paths = 2000 } = {}) {
  if (returns.length < 5) return null;
  const mu = mean(returns), sigma = stdev(returns);
  const lastPrice = closes[closes.length - 1];
  const finals = [];
  for (let p = 0; p < paths; p++) {
    let price = lastPrice;
    for (let d = 0; d < horizonDays; d++) {
      // Box-Muller for a standard normal draw
      const u1 = Math.random() || 1e-9, u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      price *= Math.exp(mu - 0.5 * sigma * sigma + sigma * z);
    }
    finals.push(price);
  }
  finals.sort((a, b) => a - b);
  const pct = (q) => finals[Math.min(finals.length - 1, Math.floor(q * finals.length))];
  return {
    horizonDays, paths,
    p5: round(pct(0.05), 2), p25: round(pct(0.25), 2), median: round(pct(0.5), 2),
    p75: round(pct(0.75), 2), p95: round(pct(0.95), 2),
  };
}

// 18. Value at Risk (historical, one-day, given confidence)
function valueAtRisk(returns, confidence = 0.95) {
  if (returns.length < 5) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.max(0, Math.floor((1 - confidence) * sorted.length) - 1);
  return round(sorted[idx] * 100, 2); // % one-day loss at this confidence
}

// 19. Conditional VaR / Expected Shortfall — average loss beyond VaR
function conditionalVaR(returns, confidence = 0.95) {
  if (returns.length < 5) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const cutoff = Math.max(1, Math.floor((1 - confidence) * sorted.length));
  const tail = sorted.slice(0, cutoff);
  return tail.length ? round(mean(tail) * 100, 2) : null;
}

// 20. GARCH(1,1)-style conditional variance forecast (simplified closed-form
//     proxy, not a fitted MLE model — flagged as an estimate).
function garchVolatilityForecast(returns, periodsPerYear = 252) {
  if (returns.length < 10) return null;
  const longRunVar = mean(returns.map((r) => r * r));
  const omega = longRunVar * 0.05, alpha = 0.1, betaG = 0.85; // typical equity-index priors
  let variance = longRunVar;
  for (const r of returns) variance = omega + alpha * r * r + betaG * variance;
  return round(Math.sqrt(variance) * Math.sqrt(periodsPerYear) * 100, 2); // forecast annualized vol %
}

// 21. Bayesian regime-probability update (bullish/neutral/bearish) using a
//     simple Gaussian-likelihood update from a flat prior — an ESTIMATE.
function bayesianRegimeProbability(returns) {
  if (returns.length < 20) return null;
  const recent = returns.slice(-20);
  const m = mean(recent), sd = stdev(recent) || 0.0001;
  let prior = { bullish: 1 / 3, neutral: 1 / 3, bearish: 1 / 3 };
  const gaussLik = (x, mu, s) => Math.exp(-((x - mu) ** 2) / (2 * s * s));
  for (const r of recent) {
    const likB = gaussLik(r, sd * 0.6, sd), likN = gaussLik(r, 0, sd), likS = gaussLik(r, -sd * 0.6, sd);
    const post = {
      bullish: prior.bullish * likB, neutral: prior.neutral * likN, bearish: prior.bearish * likS,
    };
    const total = post.bullish + post.neutral + post.bearish || 1;
    prior = { bullish: post.bullish / total, neutral: post.neutral / total, bearish: post.bearish / total };
  }
  return {
    bullishPct: round(prior.bullish * 100, 1),
    neutralPct: round(prior.neutral * 100, 1),
    bearishPct: round(prior.bearish * 100, 1),
    note: 'Bayesian estimate from recent-return likelihoods vs a flat prior — not a guarantee.',
  };
}

// 22. Hidden-Markov-style regime classification (rule-based state proxy over
//     trend + volatility, not an EM-fitted HMM — flagged as an estimate).
function regimeClassification(returns, closes) {
  if (returns.length < 20) return null;
  const recentVol = stdev(returns.slice(-20));
  const longVol = stdev(returns) || recentVol || 0.0001;
  const { slope } = linearRegression(closes.slice(-20));
  const trendingUp = slope > 0;
  const highVol = recentVol > longVol * 1.15;
  let state;
  if (trendingUp && !highVol) state = 'TRENDING_UP → LOW VOLATILITY';
  else if (trendingUp && highVol) state = 'TRENDING_UP → HIGH VOLATILITY';
  else if (!trendingUp && highVol) state = 'TRENDING_DOWN → HIGH VOLATILITY';
  else state = 'CONSOLIDATION → LOW VOLATILITY';
  return { state, note: 'Rule-based trend/volatility state proxy — an approximation of HMM-style regime detection.' };
}

// 23. PCA-style factor compression across a small indicator set (2-factor
//     proxy via explained-variance share, not a full eigen-decomposition
//     across assets — flagged as an approximation).
function pcaFactorSummary(indicatorSeries) {
  // indicatorSeries: { trend:[...], momentum:[...], volatility:[...] } equal-length numeric arrays
  const keys = Object.keys(indicatorSeries).filter((k) => indicatorSeries[k]?.length);
  if (keys.length < 2) return null;
  const variances = keys.map((k) => stdev(indicatorSeries[k]) ** 2);
  const total = variances.reduce((a, b) => a + b, 0) || 1;
  const explained = keys.map((k, i) => ({ factor: k, varianceExplainedPct: round((variances[i] / total) * 100, 1) }))
    .sort((a, b) => b.varianceExplainedPct - a.varianceExplainedPct);
  return { components: explained, note: 'Variance-share approximation of PCA factor weighting.' };
}

// 24. Regime-switch flag — did today's state differ from the prior window's?
function regimeSwitchDetected(returns, closes) {
  const cur = regimeClassification(returns, closes);
  const prior = returns.length > 40 ? regimeClassification(returns.slice(0, -20), closes.slice(0, -20)) : null;
  if (!cur || !prior) return { switched: null };
  return { switched: cur.state !== prior.state, from: prior.state, to: cur.state };
}

// 25. Skewness — asymmetry of the return distribution
function skewness(returns) {
  const n = returns.length;
  if (n < 3) return null;
  const m = mean(returns), sd = stdev(returns);
  if (!sd) return 0;
  const s = returns.reduce((a, r) => a + ((r - m) / sd) ** 3, 0) * (n / ((n - 1) * (n - 2)));
  return round(s, 3);
}

// 26. Kurtosis (excess) — fat-tail risk
function kurtosis(returns) {
  const n = returns.length;
  if (n < 4) return null;
  const m = mean(returns), sd = stdev(returns);
  if (!sd) return 0;
  const k = (returns.reduce((a, r) => a + ((r - m) / sd) ** 4, 0) * (n * (n + 1))) / ((n - 1) * (n - 2) * (n - 3))
    - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  return round(k, 3);
}

// 27. Hurst exponent (rescaled-range, simplified single-window estimate) —
//     >0.5 trending/persistent, <0.5 mean-reverting, ~0.5 random walk.
function hurstExponent(returns) {
  const n = returns.length;
  if (n < 20) return null;
  const m = mean(returns);
  const deviations = returns.map((r) => r - m);
  let cum = 0;
  const cumulative = deviations.map((d) => (cum += d));
  const range = Math.max(...cumulative) - Math.min(...cumulative);
  const sd = stdev(returns) || 1e-9;
  const rs = range / sd;
  const h = Math.log(rs) / Math.log(n);
  return round(h, 3);
}

// 28. Ulcer Index — depth & duration of drawdowns combined
function ulcerIndex(closes) {
  let peak = closes[0];
  const sqDrawdowns = closes.map((p) => { peak = Math.max(peak, p); return ((p - peak) / peak) ** 2 * 100 * 100; });
  return round(Math.sqrt(mean(sqDrawdowns)), 2);
}

// 29. Calmar ratio — annualized return / max drawdown
function calmarRatio(returns, closes, periodsPerYear = 252) {
  const annReturn = mean(returns) * periodsPerYear;
  const mdd = maxDrawdown(closes) / 100;
  return mdd ? round(annReturn / mdd, 3) : null;
}

// 30. Treynor ratio — excess return per unit of systematic (beta) risk
function treynorRatio(returns, benchmarkReturns, rf = 0.065, periodsPerYear = 252) {
  const b = beta(returns, benchmarkReturns);
  if (!b) return null;
  const annExcess = mean(returns) * periodsPerYear - rf;
  return round(annExcess / b, 4);
}

// 31. Omega ratio — probability-weighted gains vs losses above/below a threshold
function omegaRatio(returns, threshold = 0) {
  const gains = returns.filter((r) => r > threshold).reduce((a, r) => a + (r - threshold), 0);
  const losses = returns.filter((r) => r < threshold).reduce((a, r) => a + (threshold - r), 0);
  return losses ? round(gains / losses, 3) : null;
}

// 32. Information ratio — active return vs benchmark, per unit tracking error
function informationRatio(returns, benchmarkReturns) {
  const n = Math.min(returns.length, benchmarkReturns.length);
  if (n < 2) return null;
  const active = returns.slice(-n).map((r, i) => r - benchmarkReturns.slice(-n)[i]);
  const te = stdev(active);
  return te ? round(mean(active) / te, 3) : null;
}

// 33. Win rate & profit factor from a return series (treats each period as a "trade")
function winRateProfitFactor(returns) {
  const wins = returns.filter((r) => r > 0), losses = returns.filter((r) => r < 0);
  const winRate = returns.length ? round((wins.length / returns.length) * 100, 1) : null;
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss ? round(grossWin / grossLoss, 2) : null;
  return { winRatePct: winRate, profitFactor, avgWin: round(mean(wins), 4), avgLoss: round(mean(losses), 4) };
}

// 34. Risk of ruin (simplified, from win rate + avg win/loss and a risked fraction)
function riskOfRuin(winProb, avgWin, avgLoss, riskFraction = 0.02) {
  if (!winProb || !avgLoss) return null;
  const edge = winProb * Math.abs(avgWin) - (1 - winProb) * Math.abs(avgLoss);
  if (edge <= 0) return 100; // no positive edge -> ruin approaches certainty over long run
  const a = (1 - winProb) / winProb;
  const ror = Math.pow(a, 1 / riskFraction) * 100;
  return round(Math.min(100, ror), 2);
}

// 35. Composite Quant Score — weighted blend of trend / momentum / volume /
//     volatility / regime / correlation / anomaly, 0-100. Weights should
//     ultimately be walk-forward-validated; these are documented starting
//     weights, not accuracy-tuned constants.
function compositeQuantScore({ trend, momentum, volume, volatility, regime, sentiment, crossAsset }) {
  const weights = { trend: 0.22, momentum: 0.18, volume: 0.14, volatility: 0.12, regime: 0.16, sentiment: 0.10, crossAsset: 0.08 };
  const parts = { trend, momentum, volume, volatility, regime, sentiment, crossAsset };
  let score = 0, usedWeight = 0;
  const breakdown = {};
  for (const k of Object.keys(weights)) {
    const v = parts[k];
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    const clamped = Math.max(-100, Math.min(100, v));
    score += clamped * weights[k];
    usedWeight += weights[k];
    breakdown[k] = round(clamped * weights[k], 2);
  }
  const normalized = usedWeight ? score / usedWeight : 0;
  return { score: round(50 + normalized / 2, 1), breakdown, note: 'Weights are documented starting points pending walk-forward validation, not accuracy-tuned constants.' };
}

// ── Orchestrator: builds the full quant report the UI/API consumes ───────
function buildQuantReport(candles, benchmarkCandles, opts = {}) {
  if (!candles || candles.length < 25) return null;
  const closes = candles.map((c) => c.c);
  const returns = logReturns(closes);
  const benchCloses = benchmarkCandles?.length ? benchmarkCandles.map((c) => c.c) : null;
  const benchReturns = benchCloses ? logReturns(benchCloses) : null;

  const regLR = linearRegression(closes.slice(-60));
  const trendScore = round(Math.max(-100, Math.min(100, regLR.slope ? (regLR.slope / closes[closes.length - 1]) * 100 * 500 : 0)), 2);
  const mom20 = returns.slice(-20).reduce((a, b) => a + b, 0);
  const momentumScore = round(Math.max(-100, Math.min(100, mom20 * 1000)), 2);
  const volLast = candles[candles.length - 1].v;
  const avgVol20 = mean(candles.slice(-20).map((c) => c.v)) || 1;
  const volumeScore = round(Math.max(-100, Math.min(100, ((volLast / avgVol20) - 1) * 100)), 2);
  const rv = realizedVolatility(returns);
  const volatilityScore = round(Math.max(-100, Math.min(100, 100 - rv)), 2); // lower realized vol -> higher "stability" score
  const regime = regimeClassification(returns, closes);
  const regimeScore = regime?.state?.includes('TRENDING_UP') ? 60 : regime?.state?.includes('CONSOLIDATION') ? 0 : regime?.state?.includes('TRENDING_DOWN') ? -60 : 0;

  const wr = winRateProfitFactor(returns);
  const ror = riskOfRuin((wr.winRatePct || 0) / 100, wr.avgWin || 0.001, wr.avgLoss || -0.001);

  const composite = compositeQuantScore({
    trend: trendScore, momentum: momentumScore, volume: volumeScore,
    volatility: volatilityScore, regime: regimeScore, sentiment: null, crossAsset: null,
  });

  return {
    signalStrength: composite.score,
    signalBreakdown: {
      trend: trendScore, momentum: momentumScore, volume: volumeScore,
      volatility: volatilityScore, regime: regimeScore,
    },
    returns: {
      logReturnLast: round(returns[returns.length - 1], 5),
    },
    volatility: {
      realizedVolatilityPct: rv,
      ewmaVolatilityPct: ewmaVolatility(returns),
      garchForecastVolatilityPct: garchVolatilityForecast(returns),
      atrRangePct: atrRangePct(candles),
    },
    momentum: {
      zScore20: zScore(closes, 20),
      autocorrelationLag1: autocorrelation(returns, 1),
      hurstExponent: hurstExponent(returns),
    },
    trend: {
      regressionSlope: regLR.slope,
      rSquared: regLR.r2,
    },
    risk: {
      maxDrawdownPct: maxDrawdown(closes),
      ulcerIndex: ulcerIndex(closes),
      valueAtRisk95Pct: valueAtRisk(returns, 0.95),
      conditionalVaR95Pct: conditionalVaR(returns, 0.95),
      skewness: skewness(returns),
      excessKurtosis: kurtosis(returns),
    },
    riskAdjustedReturn: {
      sharpeRatio: sharpeRatio(returns),
      sortinoRatio: sortinoRatio(returns),
      calmarRatio: calmarRatio(returns, closes),
      omegaRatio: omegaRatio(returns),
      beta: benchReturns ? beta(returns, benchReturns) : null,
      treynorRatio: benchReturns ? treynorRatio(returns, benchReturns) : null,
      informationRatio: benchReturns ? informationRatio(returns, benchReturns) : null,
      correlationToBenchmark: benchReturns ? correlation(returns, benchReturns) : null,
    },
    tradeStatistics: {
      winRatePct: wr.winRatePct,
      profitFactor: wr.profitFactor,
      avgWinPct: wr.avgWin ? round(wr.avgWin * 100, 3) : null,
      avgLossPct: wr.avgLoss ? round(wr.avgLoss * 100, 3) : null,
      expectedValuePct: round(expectedValue((wr.winRatePct || 0) / 100, wr.avgWin || 0, wr.avgLoss || 0) * 100, 3),
      kellyCriterionPct: kellyCriterion((wr.winRatePct || 0) / 100, wr.avgWin || 0, wr.avgLoss || 0),
      riskOfRuinPct: ror,
    },
    marketStructure: {
      entropy: shannonEntropy(returns),
      regime,
      regimeSwitch: regimeSwitchDetected(returns, closes),
      bayesianRegimeProbability: bayesianRegimeProbability(returns),
    },
    monteCarlo: monteCarloSimulation(closes, returns, { horizonDays: opts.horizonDays || 10 }),
    compositeScoreNote: composite.note,
    disclaimer: 'All figures are statistical estimates computed from historical price/volume data. They describe past and current behavior only and are not predictions, price targets, or investment advice.',
  };
}

module.exports = {
  logReturns, realizedVolatility, ewmaVolatility, atrRangePct, zScore, correlation, beta,
  sharpeRatio, sortinoRatio, maxDrawdown, expectedValue, kellyCriterion, shannonEntropy,
  autocorrelation, linearRegression, monteCarloSimulation, valueAtRisk, conditionalVaR,
  garchVolatilityForecast, bayesianRegimeProbability, regimeClassification, pcaFactorSummary,
  regimeSwitchDetected, skewness, kurtosis, hurstExponent, ulcerIndex, calmarRatio,
  treynorRatio, omegaRatio, informationRatio, winRateProfitFactor, riskOfRuin,
  compositeQuantScore, buildQuantReport,
};

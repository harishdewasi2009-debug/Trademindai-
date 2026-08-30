// utils/portfolioRiskEngine.js
// ══════════════════════════════════════════════════════════════════════════
//  Portfolio-level risk, computed from each holding's REAL candle history
//  and its REAL weight in the user's own portfolio (current value / total
//  portfolio value) — no assumed or default weighting. A single stock's
//  statsEngine.js output only tells you about that stock in isolation;
//  this file is what tells you whether the portfolio AS A WHOLE is
//  diversified or quietly concentrated in one correlated bet.
// ══════════════════════════════════════════════════════════════════════════

const stats = require('./statsEngine');

/**
 * @param {Array} holdings  [{ symbol, weight (0-1), candles }] — weight
 *   must already reflect each holding's real share of current portfolio
 *   value (computed by the caller from real holdings data), candles are
 *   each symbol's real OHLCV history over the SAME date range.
 * @param {Array} [benchmarkCandles] real index candles, for portfolio beta.
 */
function computePortfolioRisk(holdings, benchmarkCandles) {
  const usable = holdings.filter((h) => Array.isArray(h.candles) && h.candles.length > 20 && h.weight > 0);
  if (usable.length < 1) return { error: 'Not enough holdings with real candle history to compute portfolio risk.' };

  const returnsBySymbol = usable.map((h) => ({
    symbol: h.symbol,
    weight: h.weight,
    returns: stats.dailyReturns(h.candles.map((c) => c.c)),
  }));

  // ── Correlation matrix (pairwise, over the overlapping history) ──────
  const matrix = returnsBySymbol.map((a) => returnsBySymbol.map((b) => (
    a.symbol === b.symbol ? 1 : stats.correlation(a.returns, b.returns)
  )));

  // ── Concentration: Herfindahl-Hirschman Index on real weights ────────
  // 10000 = fully concentrated in one holding, ~10000/N = perfectly equal
  // weight across N holdings. Expressed here as a 0-100 "concentration
  // score" (higher = MORE concentrated / less diversified).
  const hhi = usable.reduce((s, h) => s + (h.weight * 100) ** 2, 0);
  const concentrationScore = Number((hhi / 100).toFixed(1)); // 0-100 scale

  // ── Portfolio volatility from real weights + real covariance ────────
  const n = returnsBySymbol.length;
  const len = Math.min(...returnsBySymbol.map((r) => r.returns.length));
  let portfolioVar = 0;
  const stdevs = returnsBySymbol.map((r) => stats.stdev(r.returns.slice(-len)));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const corr = i === j ? 1 : (matrix[i][j] ?? 0);
      portfolioVar += returnsBySymbol[i].weight * returnsBySymbol[j].weight * stdevs[i] * stdevs[j] * corr;
    }
  }
  const portfolioDailyVol = Math.sqrt(Math.max(0, portfolioVar));
  const portfolioAnnualVolPct = Number((portfolioDailyVol * Math.sqrt(stats.TRADING_DAYS_PER_YEAR) * 100).toFixed(2));

  // ── Diversification ratio: weighted-average of individual vols divided
  //    by the actual portfolio vol. >1 means diversification is reducing
  //    risk below what you'd get if everything moved in lock-step. ─────
  const weightedAvgVol = returnsBySymbol.reduce((s, r, i) => s + r.weight * stdevs[i], 0);
  const diversificationRatio = portfolioDailyVol ? Number((weightedAvgVol / portfolioDailyVol).toFixed(2)) : null;

  // ── Weighted portfolio returns series → portfolio-level VaR/drawdown ─
  const portfolioReturns = [];
  for (let i = 0; i < len; i++) {
    let r = 0;
    returnsBySymbol.forEach((rs) => { r += rs.weight * rs.returns[rs.returns.length - len + i]; });
    portfolioReturns.push(r);
  }
  const portfolioCloses = [100];
  portfolioReturns.forEach((r) => portfolioCloses.push(portfolioCloses[portfolioCloses.length - 1] * (1 + r)));
  const portfolioDrawdown = stats.maxDrawdown(portfolioCloses);
  const portfolioVaR = stats.historicalVaR(portfolioCloses);

  // ── Weighted beta vs benchmark ───────────────────────────────────────
  let weightedBeta = null;
  if (Array.isArray(benchmarkCandles) && benchmarkCandles.length > 20) {
    const benchCloses = benchmarkCandles.map((c) => c.c);
    let betaSum = 0, weightSum = 0;
    usable.forEach((h) => {
      const { beta } = stats.betaAlpha(h.candles.map((c) => c.c), benchCloses);
      if (beta != null) { betaSum += beta * h.weight; weightSum += h.weight; }
    });
    weightedBeta = weightSum ? Number((betaSum / weightSum).toFixed(2)) : null;
  }

  // ── Highly-correlated pair flags (>0.8) — the concrete "you're not as
  //    diversified as you think" callout, naming the actual pair. ─────
  const highCorrelationPairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = matrix[i][j];
      if (c != null && c >= 0.8) {
        highCorrelationPairs.push({ symbolA: returnsBySymbol[i].symbol, symbolB: returnsBySymbol[j].symbol, correlation: c });
      }
    }
  }

  return {
    holdingsAnalysed: usable.map((h) => h.symbol),
    weights: Object.fromEntries(usable.map((h) => [h.symbol, Number((h.weight * 100).toFixed(1))])),
    correlationMatrix: { symbols: returnsBySymbol.map((r) => r.symbol), matrix: matrix.map((row) => row.map((v) => (v == null ? null : Number(v.toFixed(2))))) },
    highCorrelationPairs,
    concentration: {
      score: concentrationScore, // higher = more concentrated
      label: concentrationScore >= 40 ? 'Concentrated' : concentrationScore >= 20 ? 'Moderately concentrated' : 'Well diversified by weight',
    },
    portfolioVolatility: { annualisedPct: portfolioAnnualVolPct, diversificationRatio },
    portfolioDrawdown,
    portfolioVaR,
    weightedBeta,
    note: 'Computed from real per-holding candle history and each holding\'s real weight in the portfolio (current value / total value). Correlation and volatility describe the historical relationship between holdings, not a forecast.',
  };
}

module.exports = { computePortfolioRisk };

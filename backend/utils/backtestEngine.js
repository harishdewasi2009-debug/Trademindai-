// utils/backtestEngine.js
// ══════════════════════════════════════════════════════════════════════════
//  Generic long-only backtesting engine over REAL historical candles. The
//  caller supplies a `signalFn(candles, i)` rule that returns 'buy', 'sell'
//  (exit), or null for each bar — this file only runs the simulation and
//  computes performance metrics; it never invents price data or results.
//
//  COMPLIANCE: backtest metrics describe HISTORICAL hypothetical
//  performance of a rule applied to past data. Nothing here should be
//  presented as a guarantee of future results — see walk-forward/Monte
//  Carlo helpers below, which exist specifically to guard against
//  over-fitting a rule to one historical run.
// ══════════════════════════════════════════════════════════════════════════

const stats = require('./statsEngine');

/**
 * @param {Array} candles  real OHLCV candles, oldest-first
 * @param {Function} signalFn (candles, index) => 'buy' | 'sell' | null
 * @param {Object} opts
 *   initialCapital, brokeragePctPerTrade, slippagePct
 */
function runBacktest(candles, signalFn, opts = {}) {
  const {
    initialCapital = 100000,
    brokeragePctPerTrade = 0.05, // round-trip friction assumption; override with real broker rates
    slippagePct = 0.05,
  } = opts;

  const trades = [];
  const equityCurve = [];
  let cash = initialCapital, qty = 0, entryPrice = null, entryIndex = null;

  for (let i = 0; i < candles.length; i++) {
    const signal = signalFn(candles, i);
    const px = candles[i].c;

    if (signal === 'buy' && qty === 0) {
      const fillPrice = px * (1 + slippagePct / 100);
      qty = Math.floor(cash / fillPrice);
      if (qty > 0) {
        const cost = qty * fillPrice * (1 + brokeragePctPerTrade / 100);
        cash -= cost;
        entryPrice = fillPrice;
        entryIndex = i;
      }
    } else if (signal === 'sell' && qty > 0) {
      const fillPrice = px * (1 - slippagePct / 100);
      const proceeds = qty * fillPrice * (1 - brokeragePctPerTrade / 100);
      cash += proceeds;
      const pnlPct = ((fillPrice - entryPrice) / entryPrice) * 100;
      trades.push({
        entryIndex, exitIndex: i, entryPrice: Number(entryPrice.toFixed(2)), exitPrice: Number(fillPrice.toFixed(2)),
        qty, pnl: Number((proceeds - qty * entryPrice).toFixed(2)), pnlPct: Number(pnlPct.toFixed(2)),
        holdingBars: i - entryIndex,
      });
      qty = 0; entryPrice = null; entryIndex = null;
    }
    equityCurve.push(Number((cash + qty * px).toFixed(2)));
  }

  // Force-close an open position at the final candle so metrics reflect a
  // complete, fairly-compared run rather than leaving capital "trapped".
  if (qty > 0) {
    const px = candles[candles.length - 1].c;
    const proceeds = qty * px * (1 - brokeragePctPerTrade / 100);
    cash += proceeds;
    trades.push({
      entryIndex, exitIndex: candles.length - 1, entryPrice: Number(entryPrice.toFixed(2)), exitPrice: Number(px.toFixed(2)),
      qty, pnl: Number((proceeds - qty * entryPrice).toFixed(2)), pnlPct: Number((((px - entryPrice) / entryPrice) * 100).toFixed(2)),
      holdingBars: candles.length - 1 - entryIndex, forceClosed: true,
    });
    equityCurve[equityCurve.length - 1] = Number(cash.toFixed(2));
  }

  return { trades, equityCurve, metrics: computeBacktestMetrics(trades, equityCurve, initialCapital, candles.length) };
}

function computeBacktestMetrics(trades, equityCurve, initialCapital, barCount) {
  if (!trades.length) {
    return { totalReturnPct: 0, cagrPct: null, winRate: null, profitFactor: null, avgWinPct: null, avgLossPct: null, maxDrawdownPct: null, sharpe: null, numberOfTrades: 0, avgHoldingBars: null };
  }
  const finalEquity = equityCurve[equityCurve.length - 1];
  const totalReturnPct = Number((((finalEquity - initialCapital) / initialCapital) * 100).toFixed(2));
  const years = barCount / stats.TRADING_DAYS_PER_YEAR;
  const cagrPct = years > 0 && finalEquity > 0
    ? Number(((Math.pow(finalEquity / initialCapital, 1 / years) - 1) * 100).toFixed(2))
    : null;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = Number(((wins.length / trades.length) * 100).toFixed(1));
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss ? Number((grossProfit / grossLoss).toFixed(2)) : null;
  const avgWinPct = wins.length ? Number((wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length).toFixed(2)) : null;
  const avgLossPct = losses.length ? Number((losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length).toFixed(2)) : null;
  const avgHoldingBars = Number((trades.reduce((s, t) => s + t.holdingBars, 0) / trades.length).toFixed(1));

  const { maxDrawdownPct } = stats.maxDrawdown(equityCurve);
  const sharpe = stats.sharpeRatio(equityCurve);
  const kelly = stats.kellyFraction({ winRatePct: winRate, avgWinPct, avgLossPct });

  return {
    totalReturnPct, cagrPct, winRate, profitFactor, avgWinPct, avgLossPct,
    maxDrawdownPct, sharpe, numberOfTrades: trades.length, avgHoldingBars, kelly,
  };
}

/** Splits candles into sequential train/validation/test windows so a
 *  strategy can be tuned on `train`, checked on `validation`, and only
 *  finally judged on `test` (out-of-sample) — reduces the risk of a rule
 *  that only looks good because it was fit to the one history it was
 *  tested on. */
function walkForwardSplit(candles, { trainPct = 0.6, validationPct = 0.2 } = {}) {
  const n = candles.length;
  const trainEnd = Math.floor(n * trainPct);
  const validationEnd = Math.floor(n * (trainPct + validationPct));
  return {
    train: candles.slice(0, trainEnd),
    validation: candles.slice(trainEnd, validationEnd),
    test: candles.slice(validationEnd),
  };
}

/** Monte Carlo resampling of a backtest's own trade returns — randomly
 *  reshuffles the ORDER trades occurred in (bootstrap resampling with
 *  replacement) many times to show a range of plausible equity paths and
 *  drawdowns from the same set of real historical trade outcomes. This
 *  characterises sequence-of-returns risk; it does not create new,
 *  fabricated trade outcomes — every simulated path is built only from
 *  P&L percentages the backtest actually produced. */
function monteCarloSimulate(trades, { simulations = 500, initialCapital = 100000 } = {}) {
  if (!trades.length) return null;
  const pnlPcts = trades.map((t) => t.pnlPct / 100);
  const finalEquities = [];
  const maxDrawdowns = [];

  for (let s = 0; s < simulations; s++) {
    let equity = initialCapital;
    let peak = equity, maxDd = 0;
    const shuffled = [...pnlPcts];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (const r of shuffled) {
      equity *= (1 + r);
      if (equity > peak) peak = equity;
      const dd = peak ? (equity - peak) / peak : 0;
      if (dd < maxDd) maxDd = dd;
    }
    finalEquities.push(equity);
    maxDrawdowns.push(maxDd * 100);
  }

  finalEquities.sort((a, b) => a - b);
  maxDrawdowns.sort((a, b) => a - b);
  const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];

  return {
    simulations,
    finalEquity: {
      p5: Number(pct(finalEquities, 0.05).toFixed(0)),
      median: Number(pct(finalEquities, 0.5).toFixed(0)),
      p95: Number(pct(finalEquities, 0.95).toFixed(0)),
    },
    worstDrawdownPct: {
      p5: Number(pct(maxDrawdowns, 0.05).toFixed(2)),
      median: Number(pct(maxDrawdowns, 0.5).toFixed(2)),
      p95: Number(pct(maxDrawdowns, 0.95).toFixed(2)),
    },
    note: 'Reshuffles the sequence of this backtest\'s own real trade outcomes to show a range of plausible equity paths — a scenario range, not a prediction.',
  };
}

module.exports = { runBacktest, computeBacktestMetrics, walkForwardSplit, monteCarloSimulate };

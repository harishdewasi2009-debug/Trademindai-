// utils/quantReport.js
// ══════════════════════════════════════════════════════════════════════════
//  Aggregates indicators.js + quantIndicators.js + priceActionEngine.js +
//  statsEngine.js + marketContextEngine.js into ONE quant report per
//  symbol, with a grouped/weighted composite score that deliberately
//  avoids double-counting correlated indicators (see "Avoid double
//  counting" note below), full explainability, and a data-quality gate.
//
//  COMPLIANCE (same rule as indicators.js buildFullTechnicalReport): this
//  is a DESCRIPTION of what the real, computed data currently shows. It
//  does not return a buy/sell/hold verdict — SEBI Research Analyst /
//  Investment Adviser rules treat a "trading call" as regulated regardless
//  of whether a human, a formula, or an AI produced it, and TradeMind is
//  not SEBI-registered. The composite score is reported as a descriptive
//  "technical read strength", exactly like deriveSignal()'s vote tally.
// ══════════════════════════════════════════════════════════════════════════

const ind = require('./indicators');
const qi = require('./quantIndicators');
const pa = require('./priceActionEngine');
const stats = require('./statsEngine');
const ctx = require('./marketContextEngine');
const micro = require('./microstructureEngine');
const seasonality = require('./seasonalityEngine');
const events = require('./eventEngine');

/**
 * @param {Array} candles          real OHLCV candles for the symbol, oldest-first
 * @param {Object} [opts]
 * @param {Array}  [opts.benchmarkCandles]  real index candles (e.g. NIFTY 50) for correlation/beta/relative-strength
 * @param {Array}  [opts.timeframeSignals]  optional pre-computed [{timeframe, trend}] for multi-timeframe alignment
 */
function computeQuantReport(candles, opts = {}) {
  const dataQuality = ctx.assessDataQuality(candles);
  if (!candles || candles.length < 30) {
    return { error: 'Not enough real candle history to compute a quant report (need 30+ candles).', dataQuality };
  }

  const closes = candles.map((c) => c.c);
  const base = ind.computeAllIndicators(candles); // reuses the already-shipped core indicators
  if (!base) return { error: 'Core indicator computation failed.', dataQuality };

  // ── Extra momentum / volume / volatility ────────────────────────────
  const stoch = qi.calcStochastic(candles);
  const rsiSeries = ind.calcRSI(closes);
  const stochRsi = qi.calcStochRSI(rsiSeries);
  const cci = qi.calcCCI(candles);
  const roc = qi.calcROC(closes);
  const williamsR = qi.calcWilliamsR(candles);
  const mfi = qi.calcMFI(candles);
  const obv = qi.calcOBV(candles);
  const cmf = qi.calcCMF(candles);
  const donchian = qi.calcDonchian(candles);
  const atrSeries = ind.calcATR(candles);
  const atrPctSeries = atrSeries.map((a, i) => (closes[i] ? (a / closes[i]) * 100 : 0));
  const volPercentile = qi.calcVolatilityPercentile(atrPctSeries);
  const volumeSpikes = qi.detectVolumeSpikes(candles);
  const hma = qi.calcHMA(closes);
  const parabolicSar = qi.calcParabolicSAR(candles);
  const ichimoku = qi.calcIchimoku(candles);
  const pivots = qi.calcClassicPivots(candles[candles.length - 2]);

  const last = candles.length - 1;

  // ── Price action / structure ─────────────────────────────────────────
  const structure = pa.classifyMarketStructure(candles);
  const breakoutState = pa.detectBreakoutState(candles);
  const gaps = pa.detectGaps(candles).slice(-5);
  const extraCandlePatterns = pa.describeExtraCandlePatterns(candles);
  const srZones = pa.buildSupportResistanceZones(candles, {
    maLevels: [base.ema20, base.ema50, base.sma20, base.sma50],
  });

  // ── Statistics / risk ─────────────────────────────────────────────────
  const dailyRets = stats.dailyReturns(closes);
  const risk = {
    returns: {
      d1Pct: stats.periodReturnPct(closes, 1),
      w1Pct: stats.periodReturnPct(closes, 5),
      m1Pct: stats.periodReturnPct(closes, 21),
      cumulativePct: stats.cumulativeReturnPct(closes),
    },
    volatility: {
      stdevDailyPct: Number((stats.stdev(dailyRets) * 100).toFixed(3)),
      annualisedPct: stats.historicalVolatilityPct(closes),
      volatilityPercentile: volPercentile,
    },
    drawdown: stats.maxDrawdown(closes),
    sharpe: stats.sharpeRatio(closes),
    sortino: stats.sortinoRatio(closes),
    calmar: stats.calmarRatio(closes),
    valueAtRisk: stats.historicalVaR(closes),
    distribution: { skewness: stats.skewness(dailyRets), kurtosis: stats.kurtosis(dailyRets) },
  };

  // ── Divergences (RSI, MACD histogram, OBV, MFI) ──────────────────────
  const macdData = ind.calcMACD(closes);
  const divergences = [
    ...ctx.detectDivergence(candles, rsiSeries, 'RSI'),
    ...ctx.detectDivergence(candles, macdData.hist, 'MACD histogram'),
    ...ctx.detectDivergence(candles, obv, 'OBV'),
    ...ctx.detectDivergence(candles, mfi, 'MFI'),
  ];

  // ── Anomalies ─────────────────────────────────────────────────────────
  const anomalies = ctx.detectAnomalies(candles, { atrPctSeries });

  // ── Benchmark-relative (correlation / beta / alpha / relative strength) ─
  let benchmark = null;
  if (Array.isArray(opts.benchmarkCandles) && opts.benchmarkCandles.length > 20) {
    const benchCloses = opts.benchmarkCandles.map((c) => c.c);
    const benchRets = stats.dailyReturns(benchCloses);
    benchmark = {
      correlation: stats.correlation(dailyRets, benchRets),
      ...stats.betaAlpha(closes, benchCloses),
      relativeStrength20d: stats.relativeStrength(closes, benchCloses, Math.min(20, closes.length - 1, benchCloses.length - 1)),
    };
  }

  // ── Multi-timeframe alignment (only if caller supplied per-timeframe reads) ─
  const timeframeAlignment = opts.timeframeSignals ? ctx.calcTimeframeAlignment(opts.timeframeSignals) : null;

  // ── Microstructure / behavioural stats ───────────────────────────────
  const microstructure = {
    autocorrelationLag1: micro.calcAutocorrelation(dailyRets),
    hurst: micro.calcHurstExponent(closes),
    meanReversionZScore: micro.calcMeanReversionZScore(closes),
    liquidity: micro.calcLiquidityProfile(candles),
    volumeProfile: micro.calcVolumeProfile(candles),
  };

  // ── Seasonality (day-of-week / month) — small samples are flagged, not hidden ─
  const seasonalityReport = {
    dayOfWeek: seasonality.calcDayOfWeekSeasonality(candles),
    monthly: seasonality.calcMonthlySeasonality(candles),
  };

  // ── Timestamped event history (MA cross, RSI thresholds, MACD cross, Supertrend flip) ─
  const ema20Series = ind.calcEMA(closes, 20);
  const ema50Series = ind.calcEMA(closes, 50);
  const supertrendSeries = ind.calcSupertrend(candles).map((s) => (s.trendUp ? 'bullish' : 'bearish'));
  const eventTimeline = events.buildEventTimeline(candles, {
    ema20: ema20Series, ema50: ema50Series, rsi: rsiSeries,
    macdLine: macdData.macd, macdSignal: macdData.signal, supertrendDirection: supertrendSeries,
  });

  // ── Grouped, weighted composite score — AVOIDS DOUBLE COUNTING ───────
  // Rather than voting SMA20, EMA20, EMA21, EMA50 as four independent
  // "trend" points (they're highly correlated — essentially the same
  // signal counted 3-4×), every closely-related family of indicators is
  // first collapsed into ONE group sub-score, and only the GROUPS are
  // weighted against each other. Weights mirror the blueprint's
  // trend/momentum/volume/volatility/price-action/fundamentals split
  // (fundamentals omitted — no fundamentals data source is wired up yet,
  // so it is left out rather than fabricated; weight redistributed to the
  // remaining, data-backed groups).
  const clamp = (x) => Math.max(0, Math.min(100, x));

  const trendGroup = clamp(
    50
    + (base.ema20 > base.ema50 ? 12 : -12)
    + (base.supertrendDirection === 'bullish' ? 12 : -12)
    + (ichimoku.priceVsCloud.startsWith('Above') ? 13 : ichimoku.priceVsCloud.startsWith('Below') ? -13 : 0)
    + (structure.structure.includes('Higher Highs') ? 13 : structure.structure.includes('Lower Highs') ? -13 : 0)
  );
  const momentumGroup = clamp(
    50
    + (base.rsi - 50) * 0.5
    + (base.macdHistogram > 0 ? 15 : -15)
    + (stoch.k[last] - 50) * 0.3
    + (cci[last] > 100 ? 10 : cci[last] < -100 ? -10 : 0)
  );
  const volumeGroup = clamp(
    50
    + (base.volumeRatio && base.volumeRatio > 1.2 ? 15 : base.volumeRatio && base.volumeRatio < 0.7 ? -10 : 0)
    + (cmf[last] > 0 ? 15 : -15)
    + (obv[last] > obv[Math.max(0, last - 10)] ? 20 : -20)
  );
  const volatilityGroup = clamp(100 - Math.min(100, base.atrPct * 12)); // lower vol = higher score in this scheme (stability), consistent with existing buildFullTechnicalReport
  const priceActionGroup = clamp(
    50
    + (breakoutState.some((e) => e.type.includes('Breakout above')) ? 20 : 0)
    - (breakoutState.some((e) => e.type.includes('Breakdown below')) ? 20 : 0)
    + (srZones.supportZones[0] && base.currentPrice > srZones.supportZones[0].centre ? 10 : 0)
    - (divergences.some((d) => d.type === 'Bearish divergence') ? 15 : 0)
    + (divergences.some((d) => d.type === 'Bullish divergence') ? 15 : 0)
  );
  const marketGroup = clamp(50 + (benchmark?.relativeStrength20d?.relativeReturnPct || 0) * 2);

  const weights = benchmark
    ? { trend: 0.25, momentum: 0.22, volume: 0.17, volatility: 0.11, priceAction: 0.15, market: 0.10 }
    : { trend: 0.28, momentum: 0.25, volume: 0.19, volatility: 0.12, priceAction: 0.16, market: 0 };

  const overallScore = Math.round(
    trendGroup * weights.trend + momentumGroup * weights.momentum + volumeGroup * weights.volume
    + volatilityGroup * weights.volatility + priceActionGroup * weights.priceAction + marketGroup * weights.market
  );

  // ── Confidence — separate from score, per the blueprint's "confidence
  //    engine": how much of the picture is corroborated, discounted for
  //    poor data quality, thin history, or conflicting timeframes. ──────
  let confidence = 50;
  confidence += Math.min(20, Math.floor(candles.length / 25)); // more history seen = more confidence, capped
  confidence += dataQuality.score >= 95 ? 15 : dataQuality.score >= 80 ? 5 : -20;
  confidence += anomalies.length ? -10 : 5;
  if (timeframeAlignment) confidence += timeframeAlignment.alignmentScore >= 70 ? 15 : timeframeAlignment.alignmentScore < 40 ? -15 : 0;
  confidence = clamp(confidence);

  const scoreBand = overallScore >= 86 ? 'Very Strong' : overallScore >= 71 ? 'Strong' : overallScore >= 56 ? 'Positive'
    : overallScore >= 46 ? 'Neutral' : overallScore >= 31 ? 'Weak' : 'Very Weak';

  return {
    symbolMeta: { currentPrice: base.currentPrice, candleCount: candles.length },
    dataQuality,
    core: base, // the already-shipped indicators.js output, unchanged
    momentumExtra: {
      stochastic: { k: Number(stoch.k[last].toFixed(1)), d: Number(stoch.d[last].toFixed(1)) },
      stochRsi: Number(stochRsi[last].toFixed(1)),
      cci: Number(cci[last].toFixed(1)),
      roc: roc[last],
      williamsR: williamsR[last],
      mfi: Number(mfi[last].toFixed(1)),
    },
    volumeExtra: {
      obv: Math.round(obv[last]),
      obvTrend: obv[last] > obv[Math.max(0, last - 10)] ? 'Rising' : 'Falling',
      chaikinMoneyFlow: cmf[last],
      volumeSpikes,
    },
    volatilityExtra: {
      donchianUpper: Number(donchian.upper[last].toFixed(2)),
      donchianLower: Number(donchian.lower[last].toFixed(2)),
      hma: Number(hma[last].toFixed(2)),
      parabolicSar: parabolicSar[last],
      atrVolatilityPercentile: volPercentile,
    },
    ichimoku: { priceVsCloud: ichimoku.priceVsCloud, cloudTop: ichimoku.cloudTop, cloudBottom: ichimoku.cloudBottom },
    pivots,
    structure,
    breakoutState,
    gaps,
    extraCandlePatterns,
    supportResistanceZones: srZones,
    statistics: risk,
    divergences,
    anomalies,
    benchmark,
    timeframeAlignment,
    microstructure,
    seasonality: seasonalityReport,
    eventTimeline,
    compositeScore: {
      groups: {
        trend: Math.round(trendGroup), momentum: Math.round(momentumGroup), volume: Math.round(volumeGroup),
        volatility: Math.round(volatilityGroup), priceAction: Math.round(priceActionGroup),
        market: benchmark ? Math.round(marketGroup) : null,
      },
      weights,
      overallScore,
      scoreBand,
      confidence,
      methodologyNote: 'Correlated indicators (e.g. SMA20/EMA20/EMA21) are first collapsed into one group score each, and only the GROUPS are weighted — this avoids counting the same underlying trend/momentum signal multiple times. This is a descriptive strength reading of current data, not a buy/sell/hold instruction or a probability of future profit.',
    },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { computeQuantReport };

# Quant analysis engine (statistics, price-action structure, options Greeks, backtesting)

Adds a large, additional layer of real, deterministic quant computation on
top of the existing `utils/indicators.js` core — every number below is
computed from real OHLCV candles (or real Upstox option-chain data), the
same "no fabricated fallback" principle the codebase already follows.
Nothing here changes or removes any existing endpoint or file; it's
entirely additive, wired in through one new route.

## New files (`backend/utils/`)

- **`statsEngine.js`** — returns (daily/weekly/monthly/log/cumulative),
  standard deviation, downside deviation, skewness, kurtosis, annualised
  historical volatility, max drawdown + recovery time, Sharpe/Sortino/
  Calmar ratios, historical VaR & Conditional VaR, correlation/beta/alpha
  vs a benchmark, relative strength, plus a generic position-sizing and
  risk/reward calculator (both require the user's own capital/risk %, per
  the existing "never assume the user's acceptable loss" principle).
- **`quantIndicators.js`** — WMA, HMA, Stochastic, Stochastic RSI, CCI,
  ROC, Williams %R, MFI, OBV, Accumulation/Distribution line, Chaikin
  Money Flow, VPT, volume-spike detection, Donchian Channels, Keltner
  Channels, ATR-percentile (volatility percentile), Parabolic SAR,
  Ichimoku Cloud, classic floor-trader pivot points, anchored VWAP.
- **`priceActionEngine.js`** — swing-point detection, HH/HL/LH/LL market-
  structure classification, breakout/breakdown/retest detection, gap
  detection (with fill tracking), three more candlestick patterns (Morning
  Star, Evening Star, Harami, Inside/Outside Bar), and **zone-based**
  support/resistance (a price range, not a single number) with an
  explainable strength score = touch count + volume confirmation + moving-
  average confluence.
- **`marketContextEngine.js`** — market/volatility regime classification
  (bull/bear/sideways/high-vol) from index candles, bullish/bearish
  divergence detection (price vs RSI/MACD/OBV/MFI), anomaly detection
  (unusual volume, unusual price move, volatility spike, volume/price
  divergence), multi-timeframe alignment scoring, and a data-quality score
  (duplicate candles, bad OHLC, non-positive values, stale data) meant to
  be checked *before* trusting the rest of a report.
- **`optionsEngine.js`** — Black-Scholes Greeks (delta/gamma/theta/vega/
  rho) computed from each strike's own real market IV in the Upstox option
  chain, PCR by OI, Max Pain, and IV-implied expected move.
- **`backtestEngine.js`** — generic long-only backtest runner (brokerage +
  slippage assumptions included so results aren't unrealistically clean),
  CAGR/win-rate/profit-factor/Sharpe/drawdown metrics, a walk-forward
  train/validation/test splitter, and a Monte Carlo resampler that
  reshuffles a backtest's own real trade outcomes to show a range of
  plausible equity paths (sequence-of-returns risk) — never fabricates new
  trade outcomes.
- **`quantReport.js`** — aggregates all of the above (plus the existing
  `indicators.js`) into one `computeQuantReport(candles, opts)` report.
  Composite scoring is **grouped, not naively voted**: closely-correlated
  indicators (e.g. SMA20/EMA20/EMA21, or RSI/Stochastic/CCI) are first
  collapsed into one Trend / Momentum / Volume / Volatility / Price-Action
  / Market-relative sub-score each, and only those *groups* are weighted
  against each other — this is the "avoid double-counting" principle
  applied directly, instead of letting near-duplicate indicators each cast
  their own vote. A separate 0–100 confidence figure (data quality, history
  length, timeframe agreement, anomaly flags) is reported alongside the
  score rather than folded into it.

Fundamentals, earnings, sentiment/news, and market-breadth engines from the
original blueprint are intentionally **not** included yet — there's no
fundamentals/news data source wired into this backend, and fabricating
those numbers would break the "real data only" rule the rest of this
codebase follows. They're straightforward to add once a data source
(e.g. a financials API) is connected.

## Round 2 additions

- **`utils/portfolioRiskEngine.js`** — portfolio-level risk from each
  holding's REAL weight (current value / total portfolio value) and real
  candle history: pairwise correlation matrix, a list of highly-correlated
  pairs (≥0.8), concentration (Herfindahl-Hirschman Index), portfolio
  volatility + diversification ratio, portfolio-level VaR/max drawdown, and
  optional weighted beta vs a benchmark. Wired to a new
  `GET /api/portfolio/risk?benchmark=NIFTY` endpoint
  (`controllers/portfolioController.js` `getPortfolioRisk`,
  `routes/portfolioRoutes.js`) — fetches each holding's real 1-year daily
  candles with limited concurrency, same pattern as `getSignalsBatch()`.
- **`utils/seasonalityEngine.js`** — real calendar-effect statistics from
  candle timestamps: average return and positive-rate by day-of-week and
  by month, with sample size and a reliability flag on every row (a "best
  day" from 4 data points is reported differently than one from 400).
- **`utils/microstructureEngine.js`** — lag-1 return autocorrelation, a
  Hurst exponent (rescaled-range estimate of trending vs mean-reverting
  behaviour), a mean-reversion z-score (price vs its own N-period average
  in standard deviations), a turnover-based liquidity profile (no bid/ask
  data required), a volume-profile/Point-of-Control approximation from
  real OHLCV, and opening-range-breakout detection for intraday candles.
- **`utils/eventEngine.js`** — scans already-computed real indicator
  series for the exact bars where a classic event happened (EMA20/EMA50
  cross, RSI crossing 30/70, MACD signal-line cross, Supertrend flip) and
  returns a timestamped timeline — "what happened and when", not a signal.
- **`utils/statsEngine.js`** — added `kellyFraction()`: the Kelly-optimal
  risk fraction (full and half-Kelly) from a strategy's own historical win
  rate / average win / average loss (e.g. from `backtestEngine.js`).
  `backtestEngine.js`'s metrics now include this automatically.
- **`utils/quantReport.js`** — now also includes `microstructure`,
  `seasonality`, and `eventTimeline` sections in every quant report.


## Wiring

- **`services/marketDataService.js`** — new `getQuantReport(symbol,
  exchange, period, benchmarkUnderlying)`, cached 20 min like the existing
  signal/report caches. Fetches the symbol's real candles (reusing
  `getHistoricalCandles`) and, if `benchmarkUnderlying` is passed, the
  real index candles (reusing `getIndexHistoricalCandles`) for the
  correlation/beta/relative-strength section — a benchmark fetch failure
  degrades gracefully rather than failing the whole report.
- **`controllers/marketController.js`** — new `getQuantReport` handler.
- **`routes/marketRoutes.js`** — new route:
  `GET /api/market/quant/:symbol?exchange=&period=&benchmark=NIFTY|BANKNIFTY|SENSEX`
  (reuses the existing `validateMarketReport` validator and `marketLimiter`
  rate limit — same auth/shape as `/report/:symbol`).

## Compliance

Same rule as the existing `buildFullTechnicalReport()` / `deriveSignal()`:
every output is a **description of what real historical/current data
shows** — a statistic, a score, a Greek, a backtest result on the past —
never a buy/sell/hold instruction, a price target, or a promise about
future performance. SEBI's Research Analyst / Investment Adviser
regulations treat a "trading call" as regulated regardless of whether a
human, a formula, or an AI produced it; TradeMind is not SEBI-registered,
so nothing added here crosses that line.

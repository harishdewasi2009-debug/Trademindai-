// utils/eventEngine.js
// ══════════════════════════════════════════════════════════════════════════
//  Scans real indicator series for the exact bars where a classic technical
//  EVENT occurred (a moving-average cross, RSI crossing 30/70, a MACD
//  signal-line cross, a Supertrend flip) and returns a timestamped
//  timeline. Useful for "what actually happened and when" — e.g. showing
//  the last N crossover events on a chart, or feeding scannerAccuracy-style
//  tracking of how price behaved after past events. Every event is a
//  description of something that already happened in real data.
// ══════════════════════════════════════════════════════════════════════════

function crossEvents(seriesA, seriesB, candles, upLabel, downLabel) {
  const events = [];
  for (let i = 1; i < seriesA.length; i++) {
    if (seriesA[i - 1] == null || seriesB[i - 1] == null || seriesA[i] == null || seriesB[i] == null) continue;
    const wasBelow = seriesA[i - 1] <= seriesB[i - 1];
    const isAbove = seriesA[i] > seriesB[i];
    const wasAbove = seriesA[i - 1] >= seriesB[i - 1];
    const isBelow = seriesA[i] < seriesB[i];
    if (wasBelow && isAbove) events.push({ index: i, time: candles[i]?.t, type: upLabel, price: candles[i]?.c });
    else if (wasAbove && isBelow) events.push({ index: i, time: candles[i]?.t, type: downLabel, price: candles[i]?.c });
  }
  return events;
}

function thresholdCrossEvents(series, candles, threshold, aboveLabel, belowLabel) {
  const events = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1] == null || series[i] == null) continue;
    if (series[i - 1] < threshold && series[i] >= threshold) events.push({ index: i, time: candles[i]?.t, type: aboveLabel, value: Number(series[i].toFixed(2)), price: candles[i]?.c });
    if (series[i - 1] > threshold && series[i] <= threshold) events.push({ index: i, time: candles[i]?.t, type: belowLabel, value: Number(series[i].toFixed(2)), price: candles[i]?.c });
  }
  return events;
}

/** Builds a full event timeline from already-computed real series (pass in
 *  the outputs of indicators.js / quantIndicators.js so this file never
 *  recomputes anything, just scans for the moments the lines actually
 *  crossed). Returns the most recent `limit` events, newest first. */
function buildEventTimeline(candles, { ema20, ema50, rsi, macdLine, macdSignal, supertrendDirection }, limit = 20) {
  let events = [];

  if (ema20 && ema50) {
    events.push(...crossEvents(ema20, ema50, candles, 'EMA20 crossed above EMA50 (Golden Cross-style)', 'EMA20 crossed below EMA50 (Death Cross-style)'));
  }
  if (rsi) {
    events.push(...thresholdCrossEvents(rsi, candles, 30, 'RSI crossed back above 30 (exiting oversold)', 'RSI crossed below 30 (entering oversold)'));
    events.push(...thresholdCrossEvents(rsi, candles, 70, 'RSI crossed above 70 (entering overbought)', 'RSI crossed back below 70 (exiting overbought)'));
  }
  if (macdLine && macdSignal) {
    events.push(...crossEvents(macdLine, macdSignal, candles, 'MACD crossed above signal line (bullish cross)', 'MACD crossed below signal line (bearish cross)'));
  }
  if (Array.isArray(supertrendDirection)) {
    for (let i = 1; i < supertrendDirection.length; i++) {
      if (supertrendDirection[i] !== supertrendDirection[i - 1]) {
        events.push({
          index: i, time: candles[i]?.t,
          type: supertrendDirection[i] === 'bullish' ? 'Supertrend flipped bullish' : 'Supertrend flipped bearish',
          price: candles[i]?.c,
        });
      }
    }
  }

  events.sort((a, b) => b.index - a.index);
  return events.slice(0, limit);
}

module.exports = { crossEvents, thresholdCrossEvents, buildEventTimeline };

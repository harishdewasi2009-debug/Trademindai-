# Fix: chart's live price snapping back to a stale "closing" value every 60s (NSE + BSE)

## Symptom
On the Charts page, the price and the last candle itself would visibly
snap backward roughly once a minute — looked like the chart was only
capable of showing "the last 60 seconds of data" instead of a real live
quote, even after ticks arrived in between.

## Root cause (two layers — v1 of this fix only caught the first one)

**Layer 1 (title text)**: `renderMainChartWith()` runs on every
`CHART_REFRESH_MS` (60s) background candle poll, not just on a real
symbol/timeframe/exchange switch. It rebuilt `#chart-panel-title`'s
`innerHTML` from the REST candle's close every time, destroying the
`.hc-price` span the live WebSocket tick handler had been updating between
polls.

**Layer 2 (the actual candle series — the part that was still broken)**:
`renderLightweightMainChart()`'s `lwCandleSeries.setData(...)` is a full
replace of the whole series, including the last bar, sourced from the same
REST candle fetch. Even after fixing the title text, this line alone was
enough to visibly reset the candlestick itself (and therefore the price
users actually watch) back to the REST value every single poll — regardless
of how many live ticks had moved it in between. This is why the chart still
looked stuck on a 60-second cadence after the first fix.

## Fix
- `renderMainChartWith`: only fully rebuild the title on a genuine new
  chart; patch the existing price span in place otherwise, preferring the
  latest live tick over the candle close.
- `renderLightweightMainChart`: after `setData()` resets the last bar from
  REST data, immediately re-apply the latest known live WebSocket tick for
  the current symbol on top of it (`lwCandleSeries.update(...)`), so a poll
  landing can never regress a price the WebSocket had already shown.
- Same pattern applied to the homepage NIFTY 50 hero chart
  (`loadHeroChart`), which had the identical issue: its 60s REST poll fully
  replaces `heroCandles`, wiping out the live-tick patch from the previous
  fix unless it's reapplied after each poll.

## Files changed
- `frontend/index.html` (`renderMainChartWith`, `renderLightweightMainChart`,
  `loadHeroChart`)


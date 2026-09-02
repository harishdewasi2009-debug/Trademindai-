# Fix: chart's live price snapping back to a stale "closing" value every 60s (NSE + BSE)

## Symptom
On the Charts page, the price next to the symbol name would tick live for a
few seconds after a WebSocket update, then visibly jump back down/up to an
older value — repeating roughly once a minute. Looked like the chart was
only capable of showing "the last 60 seconds of data" instead of a real
live quote.

## Root cause
`renderMainChartWith()` (frontend/index.html) runs on **every**
`CHART_REFRESH_MS` (60s) background candle poll for the currently-open
chart, not just when the user actually switches symbol/timeframe/exchange.
It used to unconditionally rebuild `#chart-panel-title`'s `innerHTML` with
`last.c` — the close of the most recently fetched candle — every time it
ran. That destroyed and replaced the exact `.hc-price` `<span>` that the
live WebSocket tick handler (`connectLiveFeed`'s `onmessage`, see
`lastChartTick`) had been updating in real time between polls.

So the price would tick live for a bit, then every 60 seconds get stomped
back to a REST-fetched candle close — which is itself up to one candle
interval old (not the current LTP). This is exchange-agnostic (same code
path for NSE and BSE), which is why it looked identical on both.

## Fix
- Only rebuild the whole title element (new "LIVE" badge, fresh span, etc.)
  when this is genuinely a new chart (symbol/timeframe/exchange changed
  since the last render).
- On a same-chart background refresh, patch just the existing `.hc-price`
  span's text/color in place, and prefer the latest live WebSocket tick for
  this exact symbol over the candle's close when one is available — the
  tick is always newer.

## Files changed
- `frontend/index.html` (`renderMainChartWith`)

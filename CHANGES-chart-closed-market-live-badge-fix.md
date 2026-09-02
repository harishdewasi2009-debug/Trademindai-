# Fix: chart price/badge looked like it was still "live" (60s flicker) after market close (NSE + BSE)

## Symptom
On the Charts page, with the market CLOSED, the price and the "LIVE" badge
still appeared to update every ~60 seconds instead of holding still on the
official closing price.

## Root cause
Three places treated a WebSocket tick as trustworthy live data with no
check for whether the market was actually open:

1. `renderMainChartWith` always preferred `lastChartTick` over the REST
   candle's own close, and always rendered a hardcoded **LIVE** badge —
   never CLOSED.
2. `renderLightweightMainChart` re-applied `lastChartTick` on top of the
   freshly-fetched last bar on every 60s poll, regardless of market hours.
3. `connectLiveFeed`'s `onmessage` handler patched the candle/title from
   any tick for the charted symbol — including the one-time `snapshot`
   message the backend sends immediately on connect (`registerBrowserClient`
   in `liveFeedService.js`), which can hand back a **pre-close** tick even
   when the page is opened well after 15:30 IST.

With the market closed, no new ticks arrive, so `lastChartTick` is just
whatever the last pre-close tick happened to be — which can genuinely
differ slightly from the official settled close Upstox later returns in
the historical candle (e.g. after the closing auction). Every 60s REST
poll re-rendered with that stale tick under a badge still claiming LIVE,
which read as "delayed/flickering" rather than a clean static close.

## Fix
Gated all three spots on `isIndianMarketOpenNow()`:
- Title price now uses the REST candle's close (not `lastChartTick`) once
  the market is closed, and the badge honestly shows **CLOSED** instead of
  LIVE.
- The last-bar tick re-application in both `renderLightweightMainChart` and
  the WS `onmessage` handler is skipped entirely while the market is
  closed — the REST candle's own close is authoritative.
- `lastChartTick` itself is still recorded on every tick (including the
  connect-time snapshot) so it's ready to use the instant the market
  reopens — only the *application* of it to the visible chart is gated.

## Files changed
- `frontend/index.html` (`renderMainChartWith`, `renderLightweightMainChart`,
  `connectLiveFeed`'s `onmessage` handler)

## Related
See `CHANGES-chart-live-price-reset-fix.md` and
`CHANGES-hero-chart-live-price-fix.md` — those fixed the *during-market-
hours* version of "looks stuck on 60s", but assumed every WS tick received
was one worth showing as live. This fix adds the missing market-hours
check on top of that.

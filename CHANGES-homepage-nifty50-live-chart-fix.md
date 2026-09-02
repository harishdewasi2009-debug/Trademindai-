# Fix: Homepage NIFTY 50 hero chart stuck ~60s behind (not actually live)

## What was actually broken vs. what wasn't

There are two separate places in the app that show a NIFTY 50 (or NSE/BSE
equity) candlestick chart:

1. **The Charts page** (`#page-charts`, the TradingView/Lightweight-Charts
   panel) — for NSE_EQ, BSE_EQ, and the three indices alike, this was
   **already wired to live ticks**. `liveSocket.onmessage` patches
   `lwLastBar.close/high/low` from every incoming tick for whichever
   symbol+exchange is currently charted and calls `lwCandleSeries.update()`,
   so the forming candle and the price badge in the panel title already
   update several times a second, independent of the 60s
   `CHART_REFRESH_MS` REST re-fetch. This part did not need a fix — it was
   correctly built during an earlier pass (see the existing comments around
   `chartFeedKey` in `frontend/index.html`).

2. **The homepage hero chart** (`#heroChart`, the plain `<canvas>` chart
   above the fold showing NIFTY 50) — this had **no live-tick wiring at
   all**. It only ever redrew from `loadHeroChart()`'s REST poll on
   `CHART_REFRESH_MS` (60 seconds) — the same interval the backend's
   candle cache (`CANDLE_CACHE_TTL_MS`) uses — so it was always up to a
   full minute stale, even though a live NIFTY 50 tick was arriving over
   the same WebSocket (`/ws/market`) multiple times a second the entire
   time, and was already being used to update the ticker tape / indices
   strip's *price number*, just never the chart itself.

This second one is what produced the "60 sec delay, not real closing
data" symptom on the homepage NIFTY 50 section.

## Fix

Added a small branch inside the existing `liveSocket.onmessage` handler in
`frontend/index.html`: whenever a tick for `'NIFTY 50'` arrives and the
hero chart already has candles loaded, patch the *last (currently forming)*
candle's `close`/`high`/`low` from the tick price and call
`renderHeroChart()` immediately — the exact same pattern already used for
the Charts page's `lwLastBar`, just applied to the hero canvas.

```js
if(sym==='NIFTY 50' && typeof q.price==='number' && heroCandles && heroCandles.length){
  const p=q.price;
  const lastCandle=heroCandles[heroCandles.length-1];
  lastCandle.c=p;
  lastCandle.h=Math.max(lastCandle.h,p);
  lastCandle.l=Math.min(lastCandle.l,p);
  renderHeroChart();
}
```

The 60-second `loadHeroChart()` REST poll is left in place and still runs —
it's what fetches a genuinely new candle bar and backfills history when the
timeframe changes; it's just no longer the only thing moving the chart.
Between those polls, every live tick now nudges the last bar and redraws,
so the homepage NIFTY 50 chart tracks price in real time the same way the
Charts page already did.

## Scope / what did NOT change

- No backend changes — the Upstox WS feed already streams NIFTY 50 (see
  `INDEX_INSTRUMENT_KEYS` in `backend/services/liveFeedService.js`); this
  was purely a frontend gap.
- No changes to `CHART_REFRESH_MS` or the server-side 60s candle cache —
  those exist specifically to avoid re-hitting Upstox/rate limits (see
  `CHANGES-chart-range-and-mcx-live-quote-fix.md`), and are unrelated to
  this fix.
- BSE-specific hero chart: the homepage only ever shows NIFTY 50 (a single
  index, not exchange-switchable), so there's no separate BSE case here.

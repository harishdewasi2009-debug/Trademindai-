# Fix: homepage NIFTY 50 hero chart price only updating once a minute

## Symptom
Same "stuck on last 60 seconds of data" look as the Charts page bug, but on
the homepage's NIFTY 50 mini chart/price above the fold.

## Root cause
Unlike the Charts page panel, the homepage hero chart had **no WebSocket
wiring at all**. `hc-price` (and the candle drawn on `#heroChart`) were only
ever set inside `renderHeroChart()`, which only ever runs off the 60-second
REST candle poll (`loadHeroChart`, on `CHART_REFRESH_MS`). NIFTY 50 ticks
were already arriving over the live WebSocket the whole time (they already
keep `liveQuoteCache['NIFTY 50']` fresh for the indices ticker) — the hero
chart just never listened for them.

## Fix
`connectLiveFeed`'s WS message handler now also patches the in-progress
last candle in `heroCandles` (close/high/low) from each NIFTY 50 tick and
calls `renderHeroChart()` immediately, the same pattern already used for
the Charts page panel's live tick. The 60s REST poll still runs as before
and replaces `heroCandles` wholesale when it lands — the live tick just
fills the gap in between so the price isn't waiting up to 60s to move.

## Files changed
- `frontend/index.html` (`connectLiveFeed`'s `onmessage` handler)

## Related
See `CHANGES-chart-live-price-reset-fix.md` for the companion fix to the
Charts page's main panel, which had a live tick but was getting it
overwritten by the same 60s poll pattern.

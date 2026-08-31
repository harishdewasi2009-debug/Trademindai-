# Fix: Charts/analysis views showing wrong price for NSE, BSE, MCX

## Root cause
The main **Charts** page (candlestick chart + NSE/BSE/MCX toggle) was already
correctly threading the selected exchange through every request — that part
was fine.

The actual bug was in **five other features** that also fetch candle data and
display price, but silently dropped the exchange the user picked from search.
Without an explicit `?exchange=` param, the backend's `/api/market/candles/:symbol`
falls back to "try NSE, then BSE" auto-resolution — so:

- A BSE-only or BSE-selected stock quietly got NSE's (possibly different, or
  outright missing) data.
- MCX commodities aren't in that NSE→BSE fallback at all, so they either
  errored out or resolved to the wrong instrument.

This produced correct prices in the Screener (which already tagged every
symbol with `SYMBOL:EXCHANGE`) while Charts-adjacent views showed wrong
numbers for NSE/BSE/MCX picks.

## The actual Charts-page bug (found on second pass)
The Charts page itself (the main candlestick chart with the NSE/BSE/MCX
toggle) had a real bug too, separate from the six below:

`chartCurrentExchange` is "sticky" by design — switching to BSE and then
changing the timeframe should stay on BSE. But **only the search-dropdown
selection path** (`selectChartSearchResult`) reset it correctly when
switching stocks. If a user:
1. Loaded a stock and switched to **BSE** (or MCX) via the toggle buttons, then
2. **Typed a different symbol** directly into the box and hit **Load** or **Enter**
   (instead of picking it from the dropdown)...

...the chart kept using the *previous* stock's BSE/MCX selection for the
*new* symbol — silently showing that new symbol's BSE (or MCX) data instead
of NSE, while the Screener stayed correct (unaffected by this leftover
front-end state). This is the most likely explanation for "Charts shows the
wrong NSE/BSE price."

**Fix:** `loadChartSymbol()` now resets the exchange back to NSE (the
default) whenever the typed symbol differs from what's currently loaded —
unless the caller just explicitly set the exchange itself (search-dropdown
pick, or "View Chart" from a stock's detail modal), in which case that
exchange is correctly preserved.

## Fixed locations (frontend/index.html)
1. **Deep Analysis report** — multi-timeframe (daily/weekly) candle fetch now
   sends `analysisExchange` / `result.exchange`.
2. **"Check daily vs weekly" button** (`getMultiTimeframeView`) — now accepts
   and forwards the stock's exchange.
3. **Market Scanner — universe scan** (`fetchInBatches`) — now uses the
   `exchange` already attached to each symbol by `resolveScanSymbols()`
   instead of discarding it.
4. **Market Scanner — single-stock search** (`renderSingleStockScan`) — now
   receives and forwards the exchange chosen from the search dropdown.
5. **Technical Indicators panel** — added `indSymExchange` state, set from
   the search dropdown, with a staleness guard in case the user hand-types a
   different symbol afterward.
6. **Backtesting engine** (`runBacktest`) — same pattern: added
   `btSymExchange` state wired from the search dropdown.

All six now pass `?exchange=NSE_EQ|BSE_EQ|MCX_FO` to
`/api/market/candles/:symbol` whenever a specific exchange is known, and fall
back to the existing auto-resolution only when it truly isn't (plain manual
symbol entry with no dropdown pick).

## Suggested test pass
For each of the six views above, search and select:
- A dual-listed stock on **BSE** explicitly (e.g. via the BSE toggle/dropdown
  result) and confirm the price/candles match the Screener's BSE row.
- An **MCX** commodity (e.g. GOLD, CRUDEOIL) and confirm it loads real data
  instead of erroring or showing an unrelated price.
- Confirm NSE (default) behavior is unchanged.

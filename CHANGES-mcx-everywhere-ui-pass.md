# MCX everywhere (UI completion pass)

Follow-up to `CHANGES-mcx-upstox-integration.md`, which wired MCX into the
backend (search, resolution, alerts, live feed, accuracy tracking) but left
several frontend surfaces still NSE/BSE-only — either purely cosmetic
(labels, copy) or functionally incomplete (an MCX pick silently getting
dropped before it reached the API). This pass closes those gaps.

## Functional fixes (previously would have failed or misbehaved)

- **Watchlist "add" / Portfolio "add holding"** — search-result selection
  now threads the picked `exchange` (`NSE_EQ`/`BSE_EQ`/`MCX_FO`) through to
  `POST /api/watchlist` and `POST /api/portfolio`. Previously only the
  symbol was sent, so adding e.g. "GOLD" would try to resolve it as an
  NSE/BSE equity and fail — this was the explicit "not yet done" item
  flagged in the original MCX integration notes.
  - `registerStockSearch('pf-search-inp', ...)` / `('wl-search-inp', ...)`
    now capture `exchange` from the dropdown selection.
  - `promptAddHoldingWithSymbol()` / `addToWatchlistBySymbol()` accept an
    `exchange` param and include it in the request body when present.
- **Compare Analysis tab** — the two stock-search boxes used to share one
  `analysisExchange` variable, so comparing an MCX commodity against an
  NSE/BSE stock (or against each other) would apply the wrong exchange to
  one side. Added an independent `analysisExchange2` for the second box;
  `runCompareAnalysis()` now sends each stock's own resolved exchange.
- **Chart page** — added an "MCX" toggle next to the existing NSE/BSE
  buttons (`setChartExchange('MCX_FO', ...)`), and updated
  `syncChartExchangeToggle()`, the live-tick feed-key lookup
  (`MCX:<symbol>`, matching `liveFeedService.feedKeyFor()`), and the
  Screener's live-tick DOM-patching logic to recognize `MCX:`-prefixed
  ticks alongside the existing `BSE:` ones.
- **Screener exchange filter chips** — added an "MCX only" chip. While
  here, fixed a latent bug where the existing "NSE only"/"BSE only" chips
  sent lowercase `'nse'`/`'bse'`/`'all'` instead of the real exchange
  codes the backend's `/api/market/stocks?exchange=` expects
  (`NSE_EQ`/`BSE_EQ`/omitted) — those two filters were silently no-ops
  before this fix.
- **AI Analyze report label** — `/api/ai/analyze` now echoes back the
  `exchange` it actually used (the explicit one the user picked, or `null`
  for "Auto" — MCX is still never auto-tried, by design). The Quick and
  Compare result cards now show the real exchange (`NSE`/`BSE`/`MCX`)
  instead of a hardcoded "NSE/BSE" string.

## Cosmetic / copy fixes (labels, placeholders, marketing text)

- Search-bar placeholders on Analysis, Screener, Portfolio, Watchlist,
  Backtest, Indicators, and Options Chain now mention "or MCX commodity"
  (e.g. "Search any NSE, BSE stock, or MCX commodity…"), matching the
  Scanner's existing wording.
- Search dropdown loading/empty states ("Searching NSE + BSE…", "No
  matches on NSE or BSE…") updated to "…+ MCX…" / "…NSE, BSE, or MCX…"
  across all three generic/screener/chart search dropdowns.
- Marketing copy (page `<meta>` description/OG/Twitter tags, hero badge,
  hero subhead, trust pill, login subhead, AI Analyze section intro,
  Screener section intro) updated from "NSE & BSE" to "NSE, BSE & MCX"
  where the surrounding claim is about market coverage in general.
  Left the "Stocks covered — NSE & BSE" homepage stat cell as-is, since
  MCX contracts are commodities, not stocks, and the number quoted there
  is specifically the equity count.
- Live-feed connection status text ("NSE & BSE Live", "Connecting to live
  NSE/BSE data…") updated to include MCX.
- Legal/footer text (Disclaimer, Portfolio Tracker note, Data Sources
  list, Terms' IP clause) updated to mention MCX alongside NSE/BSE where
  it was describing the platform's data coverage or licensed sources.

## Second pass — remaining gaps found on a full re-sweep

- **Screener live-tick dedup key** — `subscribeScreenerLiveTicks()` built
  its per-symbol dedup key with a `BSE:` prefix only; an MCX row now gets
  its own `MCX:`-prefixed key too, matching `feedKeyFor()` on the backend
  and preventing a theoretical collision with an NSE symbol of the same
  bare name.
- **AI Trading Assistant (chat) system prompt** — was scoped to "NSE/BSE
  markets"; now says "NSE/BSE equity markets and MCX commodity markets."
- **AI Analyze system prompt** — was hardcoded to describe "one NSE/BSE
  stock" even though this same endpoint now accepts `exchange: 'MCX_FO'`
  and analyzes a commodity's front-month futures contract. Reworded to
  "one Indian market instrument — an NSE/BSE-listed stock, or an MCX
  commodity's front-month futures contract" so the model doesn't get a
  misleading frame when analyzing e.g. GOLD.
- **AI "Trade Ideas" scan-commentary prompt** — described its input as
  "a live NSE/BSE market scanner"; the Market Scanner has included an MCX
  universe since the first pass, so results can contain MCX rows. Updated
  to "NSE/BSE/MCX market scanner."


## Not changed (intentionally)

- The Dashboard's "All Stock Alerts" market-wide scan (`scope=all` in
  `alertService.js`) uses a small curated list of NSE large/mid-caps only
  — it was never NSE **and** BSE to begin with, so it's outside the scope
  of "everywhere NSE and BSE both appear." Left as-is.
- The Market Scanner's "NSE + BSE — top 150 each" ("ALL") universe chip
  intentionally stays NSE/BSE-only; MCX is its own separate, clearly
  labelled "MCX — commodities" chip right next to it, which is the
  correct place for it (mixing commodity futures into an equity-only
  "top 150" universe wouldn't make sense).
- `resolveInstrumentKey()`'s ambiguous-symbol default still tries NSE then
  BSE only — MCX is never auto-tried. This is a deliberate backend design
  choice (see the original MCX integration notes) so an equity ticker can
  never accidentally resolve to a commodity contract. The Analysis page's
  "Auto" mode (no exchange picked from search) therefore still shows a
  generic "NSE/BSE" label rather than guessing MCX.
- The homepage "Stocks covered" stat and its "NSE & BSE" sub-label were
  left alone (see above).

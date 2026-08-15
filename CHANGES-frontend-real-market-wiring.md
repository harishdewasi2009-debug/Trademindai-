# Frontend ↔ Upstox/market data wiring — fixes and additions

## Bugs fixed (frontend was silently broken against the real backend)
- `loadRealIndices()` read `i.name/i.symbol/i.price/i.value` — the real
  `GET /api/market/indices` response uses `{label, lastPrice, previousClose,
  changePct, stale}`. Only `changePct` happened to line up by accident, so
  the index ticker never actually showed a name or price.
- `loadRealStocks()` called `GET /api/market/stocks?limit=8` expecting
  `{stocks:[{symbol,name,price,changePercent,volume,pe,rsi,aiScore}]}` —
  that endpoint actually returns the raw paginated symbol universe
  (`{items:[{symbol,exchange,name}], total, page, ...}`) with **no price
  data at all**. `.slice(0,8)` on the resulting non-array threw on every
  page load, so the screener table, top movers, watchlist widget, and hero
  price were always empty. Now fetches real prices via
  `GET /api/market/quotes` (batch LTP) and real technical strength via
  `GET /api/market/signals` for a curated large-cap list.

## Added — real-time Upstox integration that had zero frontend usage
- **Live WebSocket feed**: `wss://<api host>/ws/market` (backend:
  `services/liveFeedService.js`) was fully built server-side but never
  connected from the frontend, which only ever polled REST every 15s. Now
  connects after sign-in, applies `tick`/`snapshot` messages to the ticker,
  screener, top movers and watchlist in real time, and reconnects with
  backoff on drop.
- **Options Chain page**: `GET /api/market/options-chain` (Elite feature)
  had a complete backend implementation and zero UI. Added a new dashboard
  page (underlying + expiry picker, call/put OI + LTP table).
- **Dashboard Screener**: rebuilt to page through the real ~5,000-symbol
  NSE/BSE universe (`/api/market/stocks`) with live quotes + rule-based
  strength scores per page, instead of reusing the 8-stock landing preview.
- **Symbol autocomplete**: added a shared `<datalist>` backed by
  `GET /api/market/search`, wired into the Watchlist / AI Analysis / Charts
  / Portfolio symbol inputs (debounced, min 2 chars).
- Chart and Watchlist pages now call `watch` on the live socket for
  symbols outside the default feed list, so charted/tracked stocks start
  streaming instead of staying on 15s polling only.

## Checked and left alone (already correct)
- `/api/payment/subscription/cancel`, `/api/alerts`, `/api/ai/analyze`,
  `/api/ai/chat`, `/api/ai/quota` — routes and payloads match what the
  frontend already sends.
- Email/password auth: intentionally disabled on the backend
  (`authRoutes.js` has signup/login commented out — Google Sign-In only by
  design). Did not build a frontend for it.

## Known gaps that still exist after this pass (all pre-existing, honestly
labeled in the app already — not touched in this pass)
- News & Sentiment page: no backend ingestion pipeline exists; page
  correctly shows "Coming soon," not fake data.
- Telegram/WhatsApp alert delivery, 2FA (TOTP), PDF report export: schema
  /config references exist but no implementation, per `backend/README.md`.
- The 12 "AI Tools" cards on the landing page (Sentiment, Comparator,
  Report Generator, etc.) are decorative — `POST /api/ai/insight` exists on
  the backend and is real, but no frontend UI calls it yet for any of these
  individual tools beyond the main AI Analysis / AI Chat pages.
- Nothing in this pass has been run against your live Upstox/Razorpay/
  Supabase keys — recommend a full smoke test (sign in, run an AI analysis,
  load the screener, open a chart, load an option chain, do a test payment)
  before flipping DNS to production.

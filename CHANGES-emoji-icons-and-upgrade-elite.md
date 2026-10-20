# Emoji icons + "Upgrade to Elite" flow (frontend/index.html only)

- Emoji icons (same style as the new design) on the top nav, mobile drawer,
  bottom bar, dashboard menu and bell: Markets 📈, Charts 📊, Analysis 🔮,
  Screener 🧪, Options Ω, Portfolio 💼, Watchlist ⭐, Alerts 🔔, etc.
- Notifications: each item shows an emoji badge (taken from the title's own
  emoji, else from type/category), also in the toast.
- "Upgrade to Elite" card: bottom of the mobile drawer, in the bell panel, and
  in the dashboard menu. Tap -> Pricing page, Elite plan scrolled to and
  highlighted -> Razorpay checkout opens. Logged-out users sign in first, then
  continue automatically. Hidden for users already on Elite.
- No backend changes needed.

## Mobile text-overflow fix (AI analysis, Screener, stock detail, chat)
- Key-level rows no longer use fixed 110px/150px columns on phones; they wrap.
- Report grids max 2 columns with shrinkable cells; long text wraps (overflow-wrap).
- Screener rows: symbol/name wrap, price column capped, no sideways shift.
- Chat/analysis bubbles use up to 92% width and wrap long words.

## Pro charts (Charts page · Markets page · every stock's detail popup)
- Shared pro layer (`tmProAttach`) on TradingView Lightweight Charts, now
  self-hosted at `frontend/assets/lightweight-charts-4.1.3.js` (CDN fallback).
- Live OHLC + change% + volume read-out that follows the crosshair / finger.
- Zoom − / + (right-edge anchored), Fit, Jump-to-latest, Full screen (phones too),
  pinch-zoom, wheel-zoom, drag-pan, drag-axis zoom, double-tap axis reset.
- Chart types: Candles, Hollow, Bars, Line, Area; Volume toggle.
- IST time axis + Indian number format (fixes UTC times on intraday charts).
- Charts page: new ranges 3M, YTD, 5Y, All (alongside 1D, 1M, 6M, 1Y).
- Stock popup: 30-point sparkline replaced by a full candlestick chart.
- Taller charts (500px desktop, ~62% of screen height on phones); auto-resize on rotate.

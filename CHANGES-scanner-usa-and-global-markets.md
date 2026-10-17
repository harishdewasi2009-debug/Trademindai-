# Scanner: every Markets-page market

**File changed:** `frontend/index.html` only (uses existing `/api/market/registry/*` endpoints; no backend change).

The Market Scanner now offers the same market groups as the Markets page, built live from `/api/market/registry/segments`:
Indian Indices, Futures & Options, Currency Derivatives, Commodity Derivatives, Global Indices (USA etc.), Global Indicators, and any other Upstox segment — plus **🌍 All markets** (every segment with instruments). Existing chips (Curated 30, NSE, BSE, MCX) are kept.

- A group with zero instruments in the Upstox master is shown disabled as "not on Upstox" — nothing substituted.
- Index/global/indicator segments are scanned by `instrument_key` via `/registry/candles`.
- Derivative segments are scanned as nearest-expiry **futures** per underlying (options not scanned; contracts with <21 daily candles skipped).
- No-volume instruments: breakout falls back to price-only (labelled); ₹/$ aware; market badge per row; index/contract rows open in Markets.
- Caps keep scans bounded: 100 per segment, 40–60 per segment in All markets (150 for NSE/BSE stocks).

**Limitation:** Upstox has no individual US stocks; USA = global indices only.

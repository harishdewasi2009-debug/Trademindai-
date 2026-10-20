# Sector Heatmap (Dashboard → Sector Heatmap)

**File changed:** `frontend/index.html` only (no backend change; uses existing `/api/market/candles` + `/api/market/stocks`).

- New dashboard section **Sector Heatmap**, in the sidebar (under Market Scanner) and in "Browse all" (Market Analysis).
- Built from the Scanner's own pipeline: real daily candles via `fetchInBatches`, the same `calcRSI` / `calcEMA` / `calcMACD` maths and `runScanRule` scan rules.
- Tiles per sector, coloured red→green by: 1-day change, 5-day change, 20-day momentum, or Technical bias (−4…+4 from RSI, EMA20/50, MACD, price vs EMA20).
- Each tile shows stock count, advancers/decliners, bullish/bearish counts. Tap a sector → its stocks (tap a stock to open Analysis) plus Scanner signal counts (breakouts, volume spikes, MACD reversals, oversold bounces, gaps).
- Universe: Curated 30 (fast) or NSE top 150. 60-second cache, Refresh button.
- **Limitation:** Upstox has no sector field, so symbol→sector is a built-in table (`HM_SECTOR_MAP`). Unmapped symbols are left out and counted on screen, never guessed. Extend the table to cover more stocks.

## AI analysis on the heatmap
- New **AI analysis** panel under the heatmap (button: "Get AI analysis"). Sends the computed sector numbers (and the selected sector's stocks, if one is open) to `POST /api/ai/insight` with new kind `sectorHeatmap`.
- Backend: `sectorHeatmap` added to `VALID_INSIGHT_KINDS` (aiRoutes.js) and a prompt in `INSIGHT_PROMPTS` (aiService.js). The insight route already runs on DeepSeek V3 for every plan; the heatmap UI only says "AI analysis" — no model name or model chips are shown.
- Prompt is descriptive only: no buy/sell/hold, no predictions, no invented news (same compliance stance as the other insight prompts).

## "AI analysis" label everywhere (no AI model names in the UI)
- Plans (Free/Pro/Elite cards), plan comparison table, FAQ, feature hub, home page, Analysis/F&O/Portfolio chip strips, result footers ("Model: …"), chat timestamps and the public SEO pages (pricing, features, etc.) now say **AI analysis** instead of DeepSeek V3 / Gemini / ChatGPT / Claude.
- `modelDisplayName()` always returns "AI analysis".
- Unchanged on purpose: backend model config/API keys (internal), and the Privacy Policy's third-party AI provider disclosure (legal wording — change only if your counsel agrees).

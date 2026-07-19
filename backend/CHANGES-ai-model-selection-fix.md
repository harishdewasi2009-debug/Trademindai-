# AI Model Selection — what was actually wrong, and what changed

The request that came with this batch ("let users choose which AI model(s)
run before generating an analysis, on every AI feature") turned out to be
**mostly already built**. There's a real "Select AI models" chip UI
(`toggleChip` / `getSelectedModelIds` / `runMultiModelInsight` in
`frontend/index.html`) already driving Stock Analysis, Deep Research,
Compare Stocks, Portfolio Scan, Portfolio Health Check, and the Option
Strategy Advisor — parallel per-model calls, independent per-model cards,
partial-failure handling, all present. So instead of rebuilding that from
scratch, this batch fixes the specific places it was missing or silently
broken.

## 1. Model selection was a no-op on 6 of the AI features (real bug)

`POST /api/ai/insight` powers Trade Ideas, Portfolio Health, Market Brief,
Option Strategy, Backtest Advisor, and Multi-Timeframe. The frontend has
sent a `model` field on every one of these calls for a while — but the
route handler only ever destructured `{ kind, context }` from the request
body and silently dropped `model`. `getAIInsight()` in turn always walked
the plan's default model cascade top-to-bottom, so **ticking a different
model chip on Portfolio Health or Option Strategy Advisor had zero effect**
— you always got whatever the top of the cascade was for your plan.

Fixed in `backend/routes/aiRoutes.js` and `backend/services/aiService.js`:
`/api/ai/insight` now maps the chip's `data-model` value to a plans.js
model key and passes it through; `getAIInsight(kind, context, plan,
modelKey)` calls that exact model when one is given, and only falls back
to the cascade when it isn't (kept for any older/direct API callers).
Picking an unavailable-on-your-plan model now returns a clear 403 instead
of quietly substituting a different model.

## 2. ChatGPT could never actually answer an insight-type request

Even once (1) is fixed, selecting "GPT-4o" on Portfolio Health or Option
Strategy would still have failed — there was no plain-text ChatGPT caller
in `aiService.js` at all (`callGeminiPlain`/`callClaudePlain`/
`callDeepSeekPlain` existed, no `callGPTPlain`), and `insightCascadeForPlan()`
never included GPT-4o for Pro or Elite, even though both plans pay for it
(see `analyzeStock`'s own Pro/Elite branches, which do call it). Added
`callGPTPlain` and put GPT-4o / GPT-4o-high into the Pro/Elite cascades.

## 3. Two PRD-named features had no model selector at all

"Market Summary" (AI Morning Market Brief) and "AI Recommendation" (AI
Trade Ideas, on the scanner page) were single-model, no chips, no choice —
`generateMarketBrief()` and `generateAITradeIdeas()` called `/api/ai/insight`
directly with no `model`. Both now render a chip strip
(`modelChipsHtml()`, a new reusable builder using the exact same markup as
the existing static strips) and go through `runMultiModelInsight()`, the
same helper Portfolio Health/Option Strategy already use — so 1 model
selected = 1 focused answer, 2+ = independent per-model cards.

## 4. No "Select all" / "Clear all", no persistence

Neither existed anywhere. `refreshModelChipLocks()` (already called on
every page/section that has a chip strip) now also attaches a small
Select all / Clear all toolbar to every `.ai-chips` group on the page and
restores that strip's last selection from `localStorage`
(`tm_ai_models_<containerId>`) — falling back to the single default model
if nothing was saved, or if a saved model is no longer on the user's plan.
`toggleChip()` / `selectAllChips()` / `clearAllChips()` all persist on
every change. This applies to every existing chip strip automatically, not
just the two new ones.

## 5. Minor: stale Claude model ids in `config/plans.js`

`plans.js` still listed `claude-sonnet-4-6` / `claude-opus-4-7` as the
`modelId` for Pro/Elite (the actual API calls in `aiService.js` already use
the corrected `claude-sonnet-5` / `claude-opus-4-8` — see that file's own
FIX comment). `plans.js`'s `modelId` is only surfaced for display (the
`/api/ai/quota` per-model breakdown), so this was a display-only mismatch,
not a broken call — but there's no reason for the two files to disagree.
Corrected to match.

## What was intentionally left alone

- **Sentiment Analysis**: per `backend/README.md`, this is a real
  "Coming Soon" — no news ingestion/scoring pipeline exists yet. Adding a
  model selector to a feature with no underlying data pipeline would just
  be a UI selector controlling nothing real, which is the exact "looks
  live, isn't" pattern this codebase has been actively cleaned out of
  elsewhere. Left as Coming Soon.
- **Technical Analysis / Risk Analysis / Support & Resistance / Swing /
  Intraday**: these aren't separate pages in this app — they're fields
  within the single Quick Analysis / Deep Research report (technical
  score, risk scoring, support/resistance block, and the "Analysis
  timeframe" dropdown covering intraday through long-term). That report
  already runs through the model-selection chip strip on the Analysis
  page, so no separate wiring was needed.

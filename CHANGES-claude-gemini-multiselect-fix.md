# "Claude/Gemini not working" + "selecting 2+ AI doesn't run all of them" — root cause + fix

## The bug

The Analysis page's "Select AI models" chips have worked correctly for a
while on Trade Ideas, Deep Research, Compare Stocks, Portfolio Health, etc.
(all powered by `/api/ai/insight`). But the main **Quick Analysis** report —
`/api/ai/analyze` — never actually looked at which chips were ticked.

`runAnalysis()` in `frontend/index.html` was already sending the selection
correctly:

```js
models: selectedModels, model: selectedModels[0]
```

But `POST /api/ai/analyze` in `backend/routes/aiRoutes.js` destructured only
`{ stockSymbol, horizon, riskTolerance, timeframe, exchange }` from the
request body — `models`/`model` were silently dropped — and
`analyzeStock()` in `backend/services/aiService.js` had no parameter for a
selection at all. Instead it always ran a **fixed, hardcoded model set per
plan tier**:

- Free  → Gemini Flash only
- Basic → Gemini Flash (DeepSeek V3 only as a failure fallback)
- Pro   → Gemini + Claude Sonnet + GPT-4o always, DeepSeek only as fallback
- Elite → all 4 flagship models always

So:

- Ticking **only "Claude Sonnet"** never actually isolated Claude's answer —
  you always got the plan's full-cascade merged consensus (which, on
  Pro/Elite, silently includes Gemini/GPT/DeepSeek's votes too). The result
  you saw wasn't really "Claude's opinion," which reads exactly like
  "Claude isn't working."
- Ticking **2+ chips** had no effect beyond whatever the plan already ran by
  default — e.g. a Pro user ticking "DeepSeek V3" alongside the others got
  nothing extra, since DeepSeek only ever ran as an invisible fallback if
  everything else failed.

## The fix

**`backend/routes/aiRoutes.js`** — `/analyze` now reads `models`
(array)/`model` (legacy single value) from the body, translates each
chip's `data-model` value to a `plans.js` model key via `CHIP_MODEL_TO_KEY`
(the same map `/insight` already used — hoisted above `/analyze` and shared
by both routes now), and passes it to `analyzeStock()` as
`selectedModelKeys`.

**`backend/services/aiService.js`** — `analyzeStock()` now accepts
`selectedModelKeys`. Every branch (Free/Basic/Pro/Elite) gates each
individual model call on a new `wantsModel(key)` check in addition to its
existing quota/env-key checks:

- **Free**: unaffected in practice (only one model was ever entitled).
- **Basic**: ticking both "Gemini Flash" and "DeepSeek V3" now runs both in
  parallel and returns a real per-model debate, instead of DeepSeek only
  ever firing as a silent failover.
- **Pro**: DeepSeek V3 (selectable on Pro/Elite too, not just Basic) now
  runs as a real parallel pick whenever it's explicitly ticked, not just as
  a last-resort fallback.
- **Elite**: each of the 4 flagship calls is now skipped if its chip wasn't
  ticked.

When `selectedModelKeys` is empty/absent (older or direct API callers that
never send `models`), every branch behaves **exactly as before** —
`wantsModel()` is a no-op in that case, so this is fully backward
compatible.

## Net effect

- Selecting a single model now genuinely runs only that model and returns
  its own answer.
- Selecting 2+ models now genuinely runs all of them in parallel and shows
  a real per-model debate, on every plan (not just Pro/Elite's own default
  cascades).
- If a selected model actually fails or is out of quota, the frontend's
  existing "you selected N models, but only X ran" note (already wired up
  in `runAnalysis()`) now reflects the truth instead of never triggering.

## Not touched

Claude/Gemini's underlying API callers (`callClaude`, `callGemini`), the
model IDs (`claude-sonnet-5`, `claude-opus-5`, `gemini-2.5-flash`,
`gemini-2.5-pro`), and the launch-trial `effectivePlanName()` fix from the
previous batch were all already correct and are unchanged. If Claude/Gemini
still error out after this fix, hit `GET /api/ai/diagnostics` (admin-only)
to check whether it's a missing/expired API key rather than a selection bug.

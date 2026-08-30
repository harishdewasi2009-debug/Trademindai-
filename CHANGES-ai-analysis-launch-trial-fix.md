# "Claude/Gemini/all AI analysis not working" — root cause + fix

## The bug

`POST /api/ai/analyze` was failing for essentially every non-Elite user, on
every model (Claude, Gemini, GPT, DeepSeek), specifically **while the
sitewide launch trial is active** (`config/plans.js` — Aug 16 – Sep 15,
2026; it's currently active as of this fix).

Root cause — a plan mismatch between the middleware and the handler:

- `enforceTokenQuota` and `attachAvailableModels` (the two middleware
  gating `/analyze`) both compute the token cap and `req.availableModelKeys`
  from `effectivePlanName(req)`, which returns `'elite'` for **every**
  signed-in user during the trial (by design — "every signed-in user gets
  full Elite-tier access at no charge").
- The route handler then called
  `analyzeStock({ ..., userPlan: req.user.plan })` — the user's REAL stored
  plan (free/basic/pro for almost everyone).
- `analyzeStock()` picks its free/basic/pro/elite code branch off
  `userPlan`, and each branch checks `isAvailable(availableModelKeys,
  'gemini_flash')` (or `'claude_sonnet'`, `'gpt4o'`, `'deepseek_v3'`, etc.).
- But `availableModelKeys` had been computed from **Elite's** model set —
  `'gemini_pro'`, `'claude_opus4'`, `'gpt4o_high'`, `'deepseek_r1'` — which
  contains none of those keys.
- Every `isAvailable()` check came back `false`, so every analysis threw
  `NO_MODELS_AVAILABLE` and the user saw *"You've used up this month's
  quota on every AI model available on your plan"* — a completely
  misleading message, since nothing was actually exhausted; the API keys
  could have been perfectly healthy the whole time.

This did not affect `/api/ai/insight` or `/api/ai/chat` — neither route
uses `attachAvailableModels`, and both already read `req.user.plan`
consistently on both the gating and the calling side.

## The fix

**`backend/routes/aiRoutes.js`** — `/analyze` now passes
`userPlan: effectivePlanName(req)` (imported from `middleware/planCheck.js`,
the same function the gating middleware already uses) instead of
`req.user.plan`, so the branch `analyzeStock()` runs and the
`availableModelKeys` it's checking against are always computed on the same
plan basis. Outside the trial window `effectivePlanName(req)` just returns
`req.user.plan` unchanged, so this is a no-op the rest of the year — and a
side effect of the fix is that free/basic/pro users now correctly get the
full Elite model lineup during the trial, matching what the trial banner
already promises.

## New: `GET /api/ai/diagnostics` (admin-only)

Every failure inside `/analyze`, `/chat`, `/insight` is deliberately
collapsed into one generic "AI analysis is temporarily unavailable"
message for end users (so a stranger can't fingerprint which vendor/model
is in use) — the real reason only ever reached `console.warn`/
`console.error` server logs, which made "all AI is broken" nearly
impossible to diagnose without already tailing logs.

This new endpoint does a real, minimal, cheap call to each configured
provider (or reports `missing_key` immediately, without calling anything,
if the env var isn't set) and returns the exact status for each:

```
GET /api/ai/diagnostics   (requireAuth + requireAdmin)
{
  "checkedAt": "...",
  "allHealthy": false,
  "providers": [
    { "provider": "gemini",   "status": "ok",          "model": "gemini-2.5-flash", "latencyMs": 412, "sampleReply": "OK" },
    { "provider": "claude",   "status": "error",       "model": "claude-sonnet-5",  "latencyMs": 88,  "message": "Claude 401: {\"error\":...invalid x-api-key...}" },
    { "provider": "openai",   "status": "missing_key", "envVar": "OPENAI_API_KEY",  "message": "OPENAI_API_KEY is not set on the server." },
    { "provider": "deepseek", "status": "ok",          "model": "deepseek-chat",    "latencyMs": 530, "sampleReply": "OK" }
  ]
}
```

Implemented as `checkProviderHealth()` in `backend/services/aiService.js`,
reusing the existing plain-text callers (`callGeminiPlain`/
`callClaudePlain`/`callGPTPlain`/`callDeepSeekPlain`). If you're still
seeing "AI analysis not working" after this fix, hit this endpoint as an
admin first — it will tell you immediately whether it's a missing/expired
key, a zero-balance account, or something else, instead of guessing from
the generic user-facing error.

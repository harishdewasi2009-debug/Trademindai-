# Verified accuracy + instrument key fixes

## Verified signals not working
- **Self-healing DB** (`db/autoMigrate.js`, run at boot and before each prediction insert): widens `prediction_history.recommendation` (every AI-analysis log insert was failing, so nothing could ever verify) and adds `exchange`. No manual `node db/migrate.js` needed.
- **Homepage panel** now aggregates all real-verified sources: AI Analyze reads, Screener signals (verify next trading day) and registry reads. Pending count shows even before the first verification.
- **MCX/BSE reads** can now be verified (exchange stored and used for the price lookup).
- **Scanner**: duplicate rows for "auto" exchange removed + unique index; signals are evaluated only after their target trading day's close (weekends/holidays skipped).
- **Missed cron**: hourly catch-up 16:00–23:00 IST, boot catch-up, and throttled catch-up on homepage load (host may sleep at 18:00).

## Market instrument keys
- Key validation no longer rejects real keys containing ( ) / + , etc. (`utils/instrumentKey.js`, used by REST + WebSocket).
- Quote matching decodes fully percent-encoded token echoes (spaces in index names) and falls back to the response key.
- A failed capability probe no longer blocks every instrument in a segment; 401 (bad token) is "inconclusive", not "access denied". Real Upstox errors are surfaced instead.
- Inline `onclick` keys escape `&`.

Deploy: push, let Render redeploy. First results appear after the next evaluation pass (screener signals: next trading day close).

# Plans + DeepSeek-only
- Every AI feature (analysis, insights, chat, diagnostics) now uses **DeepSeek V3 only**; all other model code paths and chips removed. Set `DEEPSEEK_API_KEY` on Render (server warns if missing).
- Plans: **Free ₹0 · Pro ₹499/mo (was ₹4,999) · Elite ₹999/mo (was ₹9,999)**, shown struck-through with "90% OFF". Basic plan removed; stored 'basic' users are treated as Pro. Price source: `backend/config/plans.js`.
- ⚠ Razorpay charges the amounts in plans.js (49900 / 99900 paise) — existing subscriptions are unaffected.

# Feature split
- Pro ₹499: Scanner/Screener (permanent), technical score, portfolio tracker, prediction history, watchlist 50, alerts, referral; AI limited to Free's 7 analyses + Morning Brief.
- Elite ₹999: everything in Pro + all AI features (1,499 analyses, AI chat, insights, backtesting, options, portfolio advisor).

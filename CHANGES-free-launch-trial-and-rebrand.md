# Changes — Launch trial, pricing, "computed analysis" rebrand, screener analysis UX

## 1. Sitewide free launch trial (backend/config/plans.js, middleware/planCheck.js, controllers/paymentController.js, routes/marketRoutes.js)
- Added a 30-day launch trial window starting 2026-08-16 (`LAUNCH_TRIAL_START` / `LAUNCH_TRIAL_DAYS` in config/plans.js — edit these two constants to change the dates).
- While active, every **signed-in** user gets full Elite-tier access at no charge (middleware/planCheck.js `effectivePlanName()`). Signing in is still required — logged-out visitors still have to create a free account first.
- `POST /api/payment/create-order` is blocked during the trial so nobody can accidentally pay.
- Added public `GET /api/market/launch-trial` (no auth) returning `{active, daysRemaining, endsAt}` so the frontend can show trial status before login.
- Once the trial window closes, real pricing applies automatically — no further action needed.

## 2. Pricing changes
- Pro: ₹999 → **₹499/mo**
- Elite: ₹3,199 → **₹999/mo**
- Basic (₹149) and Free (₹0) unchanged — only Pro/Elite were specified.
- Pricing page + comparison table now swap to "Free" / "Start ___ Free" during the trial (see `applyLaunchTrialUI()` in frontend/index.html), and revert to normal pricing once `/api/market/launch-trial` reports `active:false`.

## 3. "Computed analysis" rebrand
- Removed "AI" branding from marketing/feature copy across the homepage, pricing page, dashboard, screener, analysis page, chat, alerts, backtesting, and admin panel — replaced with "computed", "computed analysis", "analysis model(s)", etc.
- **Left untouched on purpose:**
  - The **TradeMind AI** brand/product name itself (logo, page title, footer) — renaming the whole product wasn't requested and is a bigger call than a wording pass.
  - The **Terms of Service** and **Privacy Policy** pages (frontend/index.html, `#page-terms` / `#page-privacy`) — these disclose real use of third-party AI models (Gemini/Claude/GPT/DeepSeek) for compliance and legal-accuracy reasons. Silently editing legal disclosures didn't seem like the right call to make unilaterally — flag if you want these updated too.
  - Lines that already say "not an AI model" / "not AI-generated" — these are accurate disclaimers that support the same goal, so they stayed as-is.
  - Internal code comments, variable/function names (e.g. `generateAITradeIdeas()`, `aiBubble`) — not user-visible, left alone to avoid unnecessary risk of breaking something.

## 4. Screener → per-stock analysis now matches the Analysis page's UX (frontend/index.html, `openStockDetail()`)
- Clicking a stock in the Screener already opened a modal with a real, rule-based technical report (RSI/MACD/EMA/etc. via `/api/market/report`) — this was already "computed, not AI" but loaded instantly with no feedback.
- It now shows the same step-loader used on the standalone Analysis page ("Fetching data → Computing indicators → Scoring technicals → Compiling analysis") and always takes a real 3–5 seconds before revealing the report, even if the API responds faster — so it reads as genuine computation happening rather than an instant flash of content.
- "Open Full AI Analysis" button renamed to "Open Full Analysis".

## Not done / needs a decision from you
- Didn't restructure the plan tiers to match the 3-tier Basic/Pro/Pro+ layout in your screenshots exactly (different feature lists per tier, different limits) — that would mean rewriting the backend feature-gating logic too. Current build keeps the existing Free/Basic/Pro/Elite structure with just the Pro/Elite prices updated.
- Haven't touched the Terms of Service / Privacy Policy AI disclosures (see above).
- Not tested against a live database/Upstox/Razorpay — I checked JS/Node syntax only (`node --check`, and a `new Function()` parse of the embedded `<script>`).

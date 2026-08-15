# Changes: Pro ₹499 / Elite ₹999 replan, AI Analysis consolidation, More page, zoom fix

## 1. Plan restructure (backend `config/plans.js` — single source of truth)
- Removed the Basic (₹149) tier entirely.
- **Pro — ₹499/mo**: Gemini 2.5 Flash only, 250,000 tokens/month, 3,000 tokens/request.
- **Elite — ₹999/mo**: Gemini 2.5 Pro only, 250,000 tokens/month, 4,000 tokens/request.
- Free tier unchanged (Gemini 2.5 Flash, 50k tokens/mo, 7-day Screener trial).
- Replaced the old complex multi-model parallel-cascade + consensus/debate
  system (Gemini + Claude + GPT + DeepSeek running together) with one model
  per paid tier — simpler, cheaper, and removes the confusing "AI Model
  Debate" output.

## 2. Backend cleanup (`services/aiService.js` + controllers/middleware)
- Simplified `analyzeStock()`'s Pro branch to a single Gemini Flash call,
  Elite branch to a single Gemini Pro call. Removed the Basic branch and
  all Claude/GPT/DeepSeek parallel-call logic for these tiers.
- Simplified `insightCascadeForPlan()` to match.
- Removed `'basic'` from every plan-validation array: `watchlistController.js`
  (WATCHLIST_LIMITS), `paymentController.js`, `adminController.js`,
  `middleware/validate.js`.
- Updated `README.md`'s plan/model description and env var note.

## 3. Fixed pricing/plan-ID mismatches (frontend)
- The landing pricing cards already *displayed* ₹499/₹999 but their buttons
  called the wrong backend plan IDs (`choosePlan('basic')` for the ₹499
  card, `choosePlan('pro')` for the ₹999 card) — now correctly wired to
  `'pro'` / `'elite'`.
- Renamed the "Pro+" card and compare-table column to "Elite".
- Fixed the Subscription page's "Change plan" buttons, which still showed
  stale ₹799 Basic / ₹1,999 Pro pricing from before the redesign.

## 4. Consolidated AI Analysis + AI Chat into one page
- Removed the standalone "AI Chat" nav item and `page-chat` page.
- The AI Analysis page (`page-ai`) now includes a "Ask a follow-up" chat
  box below the analysis result, so there's one AI entry point instead of
  two.

## 5. Screener: simple search bar + per-row "Analyze" action
- Added a plain "Jump to a symbol" search input (reusing the existing
  `/api/market/search` autocomplete) above the exchange tabs.
- Added an "Analyze" button to every screener row and wired both it and
  the new search bar to `goAnalyzeSymbol()`, which jumps to AI Analysis
  with the symbol pre-filled and auto-runs the analysis.

## 6. "More" page — 35-feature catalog
- Added a "More" entry to both the sidebar nav and the mobile bottom nav.
- New `page-more` renders all 35 platform features (AI Analysis, Markets &
  Data, Portfolio & Watchlist, Alerts & Notifications, Account & Platform),
  each tagged Free/Pro ₹499/Elite ₹999 with a lock icon if the user's
  current plan doesn't include it; tapping an unlocked card jumps straight
  to that feature's page, a locked card jumps to Subscription.

## 7. Mobile double-tap-zoom fix
- No `touch-action` rule existed anywhere in the stylesheet. Custom
  clickable elements (nav items, feature cards, tabs — anything that isn't
  a native `<button>`/`<a>` recognized cleanly by the browser) could
  register a slightly-mistimed second tap as a double-tap and trigger the
  native pinch-zoom-in gesture.
- Added `touch-action: manipulation` to buttons, links, nav items, cards,
  and tabs. This does **not** touch the viewport meta tag and does not
  disable the user's own pinch-to-zoom anywhere on the page — it only
  removes the accidental double-tap zoom on tap targets.

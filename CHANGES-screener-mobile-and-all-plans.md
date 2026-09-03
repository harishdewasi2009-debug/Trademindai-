# Screener: mobile timeframe UI, all-plans access, stale-data-on-nav fix

## 1. Timeframe filter — mobile usability

The Screener sidebar's "Timeframe" filter was 14 separate chip buttons
stacked vertically (`#scr-tf-1m` … `#scr-tf-5y`). On mobile this forced a
long scroll inside an already-narrow sidebar and was awkward to tap
precisely.

**Fix (frontend/index.html):** replaced the 14-button grid with a single
native `<select>` (`#scr-tf-select`), the same `tm-inp` component already
used by the Analysis page's "Analysis timeframe" dropdown. `setScreenerTimeframe(period)`
now just takes the select's value directly instead of also taking the
clicked chip element and manually clearing 13 sibling `.active` classes.

## 2. AI Stock Screener — available on every plan, requires sign-in (matches Analysis page)

Previously: `'screener'` was removed from the Free plan's `features` in
`config/plans.js`, and `GET /api/market/stocks` required both
`requireAuth` and `requireFeature('screener')` — so Free users were
blocked even when signed in.

**Fix:**
- `backend/config/plans.js`: `'screener'` added back to the Free plan's
  `features` list (Basic/Pro/Elite already had it).
- `backend/routes/marketRoutes.js`: `GET /api/market/stocks` keeps
  `requireAuth` + `requireFeature('screener')` — sign-in is required
  (same gate the Analysis page already uses), but since every plan now
  has `'screener'` in its features list, any signed-in user on any plan,
  including Free, gets full access once signed in.
- `frontend/index.html`: `show('screener')` redirects logged-out visitors
  straight to the Google/email sign-in screen and back automatically on
  success, mirroring `show('analysis')`'s existing gate exactly
  (`postLoginRedirect` / `goToPostLoginDestination()`).
- Pricing page: Free plan card now lists "AI Stock Screener"; the plan
  comparison table's Screener row is a checkmark across all 4 plans;
  the homepage feature grid's Screener tag changed from "Basic +" to
  "All Plans".

Note: `/api/market/options-chain` still requires auth + `'options_analysis'`
(Elite-only) — that gate is untouched, this batch only touches the
Screener specifically.

## 3. Stale data shown for ~2s when navigating back to the Screener

`renderScreener()` intentionally skips its loading spinner when
`#screener-results` already has `dataset.loaded === 'true'`, so the ~3s
live-tick auto-refresh (`renderScreenerThrottled`) can update the list in
place without a visible blink while the market is open. But
`show('screener')` reused that same flag on every navigation into the
page — so leaving the Screener and coming back (e.g. Dashboard →
Screener, or any nav link) left the *previous* visit's stock list frozen
on screen for ~1-2 seconds while a fresh fetch quietly ran underneath,
then silently swapped in. Looked like the page opened with old/wrong
data.

**Fix (frontend/index.html):** `show('screener')` now resets
`#screener-results`'s `dataset.loaded` back to `'false'` before calling
`renderScreener()`, so every genuine page visit starts from the loading
state and shows fresh data as soon as it arrives. The live-tick refresh
path (`renderScreenerThrottled`, called every ~3s while already on the
page) is untouched and still updates without flicker.

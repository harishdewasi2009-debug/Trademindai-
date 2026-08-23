# Screener: Free plan changed from unlimited to a 7-day trial

## Problem

A previous fix (`CHANGES-screener-mobile-and-all-plans.md`) put `'screener'`
into the Free plan's `features` list in `config/plans.js`, so any signed-in
Free user got **permanent, unlimited** access to the AI Stock Screener —
same as paid plans.

Requested change: Free users should get the Screener for **7 days after
signup**, then lose access and be prompted to upgrade — not unlimited
forever.

## Fix

**`backend/config/plans.js`**
- Added `FREE_SCREENER_TRIAL_DAYS = 7` (exported).
- `'screener'` stays in the Free plan's `features` list, but the comment
  now makes clear it only means "trial-eligible" for Free — the actual
  time-boxing happens in the new middleware below. Basic/Pro/Elite are
  unaffected; `'screener'` in their lists still means permanent access.

**`backend/middleware/planCheck.js`**
- Added `requireScreenerAccess` (new export), used **instead of**
  `requireFeature('screener')` for the Screener route only.
  - If the plan doesn't have `'screener'` at all → same 403 as
    `requireFeature` always gave.
  - If the plan has `'screener'` and is **not** Free → passes through,
    exactly like before (permanent access).
  - If the plan has `'screener'` and **is** Free → computes
    `trialEndsAt = user.created_at + 7 days`. Before that, passes through
    (and attaches `req.screenerTrialEndsAt` for anything downstream that
    wants it). After that, blocks with a 403:
    _"Your 7-day free trial of the AI Stock Screener has ended. Upgrade to
    a paid plan to keep using it."_
- Every other `requireFeature(...)` call elsewhere in the codebase is
  untouched — this only changes the Screener's own route.

**`backend/routes/marketRoutes.js`**
- `GET /api/market/stocks`: `requireFeature('screener')` →
  `requireScreenerAccess`. Still requires `requireAuth` first (sign-in is
  still mandatory on every plan, that part of the last fix is unchanged).

**`frontend/index.html`**
- Pricing page → Free plan card: "AI Stock Screener" now shows an amber
  "7-Day Trial" badge instead of a plain green checkmark.
- Pricing page → comparison table: the Screener row's Free column now
  reads "7-day trial" instead of a checkmark (Basic/Pro/Elite columns
  unchanged — still checkmarks, meaning permanent).
- Homepage feature grid: Screener's tag changed from "All Plans" to
  "7-Day Free Trial".
- `show('screener')`: stale comment corrected (it previously said Free
  got full/unlimited access once signed in — no longer true). The
  sign-in gate itself (redirect logged-out visitors to login) is
  unchanged.
- New `renderScreenerTrialBanner()` (called on every navigation into the
  Screener page): for signed-in Free users still inside their trial
  window, shows a small dismissable-style banner — _"N days left in your
  free AI Stock Screener trial. Upgrade to keep unlimited access after it
  ends."_ — with a "View plans" button. Hidden entirely for paid plans,
  logged-out visitors, or once the trial has actually expired (in the
  expired case, the existing `renderScreener()` → `e.isPlanGate` error
  branch already shows a full lock screen with the backend's exact
  "trial has ended" message and its own upgrade button, so the banner
  doesn't duplicate that).
- This banner is purely a client-side courtesy heads-up computed from
  `currentUser.created_at` (already present on `currentUser` via the
  backend's `sanitizeUser()`); the real enforcement is 100% server-side
  in `requireScreenerAccess`, so there's no way to bypass the trial by
  editing client state.

## Not changed

- `GET /api/market/options-chain` (Elite-only, `'options_analysis'`) —
  untouched.
- Every other `requireFeature(...)` gate in the app — untouched.
- Basic/Pro/Elite Screener access — still permanent, no trial logic
  applies to them.

## Follow-up: homepage 7-day trial mention

**`frontend/index.html`** — added one pill to the homepage hero's trust
strip (`.hero-trust-strip`), matching the existing pill style: `7-Day Free
Screener Trial`. No other homepage changes.



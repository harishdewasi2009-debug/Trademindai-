# Fix: users get signed out on every page load instead of staying signed in until they Sign out

## The symptom
A user signs in, then on their next visit (or even a refresh) is dropped
back to the login screen — even though the frontend already has a full
"stay signed in" flow (`tryRestoreSession()` → `tryRefreshToken()` →
30-day refresh-token cookie) that's supposed to prevent exactly this.

## Root cause
The frontend (Vercel/Netlify) and backend (Render) are on **two different
domains**, so every auth cookie is a *cross-site* cookie. Browsers only ever
deliver a cross-site cookie on a `fetch()`/XHR call if it was set with
`SameSite=None; Secure`. A `SameSite=Lax` cookie — what this app fell back to
whenever `NODE_ENV` wasn't the exact string `'production'` — is **never**
attached to cross-site `fetch()` calls at all, only to top-level page
navigations.

`backend/controllers/authController.js` was deciding `secure`/`sameSite`
from a single `IS_PROD = process.env.NODE_ENV === 'production'` flag. If
`NODE_ENV` was left unset, misspelled, or just not configured on the hosting
dashboard (an easy thing to miss on Render), the refreshToken cookie quietly
stopped being sent on `POST /api/auth/refresh`, `tryRestoreSession()` on the
frontend silently failed on every page load, and the user was forced to log
in again — even though their session was still valid in the `sessions`
table for the full 30 days.

## The fix
`accessCookieOpts(req)` / `refreshCookieOpts(req)` now decide `secure` /
`sameSite` **per request**, from `req.secure`, instead of trusting an env
var to be spelled exactly right:

- `req.secure` is reliable here because `server.js` already sets
  `app.set('trust proxy', 1)`, so Express correctly reads the
  `X-Forwarded-Proto` header Render's proxy sends.
- Any request arriving over HTTPS (i.e. every real deployment) now gets
  `Secure; SameSite=None` regardless of `NODE_ENV`.
- Plain-HTTP local dev (`http://localhost`) still falls back to
  `SameSite=Lax` without `Secure`, since browsers refuse `Secure` cookies
  over non-HTTPS anyway.

This makes "stay signed in until Sign out" work correctly on the real
deployment without depending on `NODE_ENV` being set perfectly. No frontend
changes were needed — its session-restore logic was already correct; it just
never received the cookie it needed.

## Files changed
- `backend/controllers/authController.js`

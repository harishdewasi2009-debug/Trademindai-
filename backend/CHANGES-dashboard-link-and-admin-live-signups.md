# Dashboard nav link + live sign-ups in Admin panel

## 1. "Dashboard" wasn't showing in the site UI

The Dashboard page itself worked fine (`show('dashboard')` → `renderDashboard()`),
but there was no actual **"Dashboard" link** in either nav bar — only a bare bell
icon (no label) in the top-right, and an "AI Assistant" item in the mobile
drawer that happened to open it. A first-time visitor had no way to tell the
Dashboard existed.

**Fix:** added a proper labeled "Dashboard" link, right after "Home", in both:
- Desktop nav bar (`.nav-links`)
- Mobile sidebar drawer

It uses the same `data-page="dashboard"` + `onclick="show('dashboard')"` pattern
as every other nav item, so the existing auth gate (`show()` redirects to
`/login` if not signed in, then back to Dashboard on success) and active-state
highlighting keep working with no other changes needed.

## 2. Admin panel not showing new sign-ins

The backend was already correct — `GET /api/admin/users` returns every user
`ORDER BY created_at DESC`, so a brand-new sign-up/sign-in is always in that
result set. The problem was purely front-end: `loadAdminPanel()` (which
populates the "Recent sign-ups" table) only ever ran **once**, at the moment
you clicked into the Admin tab. If you left that tab open, new users kept
signing up behind the scenes but nothing re-fetched the list — it just sat
frozen on whatever it looked like when you opened it. The only way to see a
new sign-in was to leave and re-enter the Admin page, or hit "Refresh".

**Fix:** added a 15s auto-refresh loop for the Admin page, the same pattern
already used for the Screener's live auto-refresh:
- `startAdminAutoRefresh()` — begins polling `loadAdminPanel()` every 15s
  while `#page-admin` is the active page.
- `stopAdminAutoRefresh()` — clears the timer as soon as you navigate away,
  so it doesn't keep hitting the API in the background.
- Wired into `show()`: entering `admin` starts the poll, leaving it stops it.

New sign-ups/logins now appear in the "Recent sign-ups" table within 15s of
happening, without needing a manual refresh.

## Files touched
- `frontend/index.html`:
  - Desktop `.nav-links` — new "Dashboard" `<span class="nav-link">`
  - Mobile `.mobile-sidebar` — new "Dashboard" `<span class="nav-link">`
  - New `startAdminAutoRefresh()` / `stopAdminAutoRefresh()` functions
  - `show()` now calls these when entering/leaving the `admin` page

No backend changes were needed — `adminController.listUsers` was already
correct.

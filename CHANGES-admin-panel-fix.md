# Admin panel — fully working

Most of the admin panel was already wired to real endpoints (users, feedback,
referrals, advertiser enquiries, AI cost, prediction accuracy all pull real
data). What was broken/fake:

1. **"Export CSV" and "Refresh" buttons did nothing** — no `onclick` at all.
   - Refresh now calls `loadAdminPanel()`.
   - Export CSV now downloads the currently-loaded user list (name, email,
     plan, status, admin flag, signup date) as a real `.csv` file.

2. **"Risk flags & alerts" panel was 100% hardcoded fake data** — a
   permanent "User #1847 — 420 analysis runs" and "6 failed renewals today"
   that never changed no matter what was actually happening on the platform.
   - Added `GET /api/admin/risk-flags` (`adminController.getRiskFlags`):
     - Flags any real user whose AI calls in the last 24h are 3x+ their
       plan's fair daily rate (derived from `monthlyAiQueries` in
       `config/plans.js`).
     - Flags real failed payments in the last 24h (count + amount from the
       `payments` table).
   - Frontend now renders these live, or "No risk flags right now" when
     clean.

3. **"Platform Health Score" was a hardcoded `A+`** — never computed from
   anything.
   - Same `/api/admin/risk-flags` endpoint now returns a grade computed
     from the real 30-day payment success rate (`paid` vs `failed` in the
     `payments` table): A+ ≥95%, A ≥85%, B ≥70%, C below that, or "N/A" if
     there isn't enough payment history yet.

## Files touched
- `backend/controllers/adminController.js` — added `getRiskFlags`
- `backend/routes/adminRoutes.js` — added `GET /risk-flags`
- `frontend/index.html`:
  - `loadAdminPanel()` now also fetches `/api/admin/risk-flags` and renders
    real flags + health score
  - New `exportAdminUsersCsv()` function
  - Header buttons wired to `loadAdminPanel()` / `exportAdminUsersCsv()`
  - Static hardcoded risk-flag/health-score markup replaced with empty
    containers populated at runtime

No other admin sections needed changes — stats, plan distribution, AI model
costs, recent sign-ups, advertiser enquiries, feedback, referrals, and
prediction accuracy were already reading from real `/api/admin/*` data.

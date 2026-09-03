# Fix: "signal timed out" on Sign in (Google and email/password)

## Root cause
`apiFetch()` in `frontend/index.html` gives every backend request a 20s
abort timeout (`API_TIMEOUT_MS`), so a hung request always settles instead
of hanging forever. That part is correct and intentional (see
`CHANGES-chart-cold-start-fix.md`).

The problem: the backend is a Render free-tier web service that spins down
after ~15 minutes idle, and waking it back up can take 30-60+ seconds —
longer than the 20s window. `CHANGES-chart-cold-start-fix.md` describes a
prewarm ping + `backendWarm` flag + fast-retry loop that was meant to paper
over this, but that code was never actually present in `frontend/index.html`
(the changelog and the code had drifted apart). So whichever request
happened to be the *first* one to hit a sleeping backend — very often
Google/email sign-in, since that's usually the first thing a new visitor
does — would abort after 20s with a raw `AbortError` ("signal timed out"),
and `handleGoogleCredential`/`submitLogin`/`submitSignup` just displayed
`e.message` verbatim with no explanation or retry.

## What changed (frontend/index.html only — no backend changes needed)
1. **Prewarm ping** — a fire-and-forget request to `/health` fires the
   moment the script starts executing, so the backend starts waking up as
   early as possible, ideally before the user finishes interacting with the
   sign-in form.
2. **`backendWarm` flag** — set true the first time *any* request gets *any*
   response from the backend (even an error status — that still proves the
   process is up and answering).
3. **Cold-start-aware retry in `apiFetch`** — if a request times out before
   we've ever heard back from the backend, it's treated as a likely cold
   start rather than a real failure: `apiFetch` automatically retries once
   with a longer 45s window. This applies to every caller (sign-in, sign-up,
   Google auth, forgot/reset password, etc.) since it's centralized in
   `apiFetch` rather than patched per call site.
4. **Friendlier failure message** — if the retry also fails, the user sees
   "The server is taking longer than usual to wake up. Please try again in
   a few seconds." instead of the raw browser `AbortError` text.

## What this does NOT fix
Same caveat as the chart fix: this shortens and explains the wait, it
doesn't eliminate the cold start itself. To remove it entirely: upgrade the
Render backend off the free plan, or add a scheduled ping to `/health`
every ~10 minutes (UptimeRobot, cron-job.org, GitHub Actions cron, etc.) to
keep the free instance awake.

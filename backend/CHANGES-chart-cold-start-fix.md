# Fix: charts take a long time to appear right after deploy / after the site's been idle

## Root cause
The backend (`API_BASE_URL` in `frontend/index.html`) is a Render web
service. Render's free tier spins the service down after ~15 minutes with
no traffic, and waking it back up can take 30-60+ seconds. Previously the
first request to actually hit the backend after a cold start was often the
chart's own candle fetch, which has a 35s abort timeout — shorter than a
cold start can take. That request would time out, get cached as "no data"
for 50s (`REAL_CANDLE_CACHE_MS`), and only retry on the next 60s poll
(`CHART_REFRESH_MS`) — so an empty chart could persist for 60-90+ seconds
even though the backend was working the whole time, just not fast enough
for that first request's window.

This is infrastructure behavior (Render free-tier cold start), not a bug in
the candle-fetching logic itself, which is why it can look "random" between
deploys — how long it's slow for depends on how long the backend had been
asleep before that particular visit.

## What changed (frontend/index.html only — no backend changes needed)

1. **Prewarm ping** — an immediate, fire-and-forget request to `/health`
   fires the moment the page's script starts executing (before anything
   else), so the backend starts waking up as early as possible instead of
   waiting for the chart to ask for real data.
2. **`backendWarm` tracking** — set true the first time *any* request gets
   *any* response from the backend (even an error status — that still
   proves the process is up and answering).
3. **Short failure-cache TTL until warm** — candle-fetch failures are only
   cached for 4s (instead of the normal 50s) until `backendWarm` is true,
   so retries happen quickly during a cold start.
4. **Fast retry loops** — new 5s intervals (both for the main chart and the
   homepage hero chart) that only run until `backendWarm` flips true, then
   become permanent no-ops. This is what actually drives the faster
   retries above — the existing 60s polls were too infrequent on their own.
5. **"Waking up the server…" overlay** — a small spinner + message now
   covers the main chart while waiting on the very first cold-start
   response, instead of leaving it blank with no explanation. It clears
   itself automatically once data arrives, once the backend is confirmed
   warm, or after 70s at the latest (safety net).
6. **Hero chart status pill** — shows "Waking up server…" instead of the
   more alarming "Data unavailable" during the same window.

## What this does NOT fix
None of the above stops the backend from sleeping in the first place —
that's inherent to Render's free tier. It only makes the wait shorter and
clearly communicated. To eliminate the cold start entirely, either:
- upgrade the Render backend off the free plan (paid instances stay warm), or
- add a scheduled ping to `/health` every ~10 minutes (e.g. UptimeRobot,
  cron-job.org, or a GitHub Actions cron) to keep the free instance awake.

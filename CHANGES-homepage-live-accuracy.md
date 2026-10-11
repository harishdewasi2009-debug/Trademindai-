# Homepage — Live AI Accuracy

- New public, read-only endpoint `GET /api/market/public-accuracy` (backend/services/publicAccuracyService.js). Returns only aggregates + timestamps from verified `prediction_history` rows. 60s server cache.
- Homepage section "TRADEMIND AI — LIVE AI ACCURACY" (frontend/index.html, id `live-accuracy`): overall accuracy, today's accuracy, today's change, verified count, pending, +5 pp daily goal bar, daily trend, last-updated, live/stale/unavailable states. Auto-refreshes every 60s.
- Per request: NO Correct/Incorrect counts and NO "previous day" figure are shown. Nothing before the launch date is exposed — counting and the daily chart start at `PUBLIC_ACCURACY_START_DATE` (env, default 2026-08-16) and a new day is added automatically every day.
- Unavailable data shows "Accuracy data is being collected" — never 0%. Real accuracy is never adjusted; +5 pp is only a goal.
- Deploy: backend redeploy (no migration needed) + frontend redeploy.

## Calendar + real-data fix
- Homepage "Daily accuracy calendar": launch month → current month only; future days hidden; each day opens automatically.
- **Required for real data:** `prediction_history.recommendation` was VARCHAR(10) but values like `moderate_bullish` are 16 chars, so every prediction insert failed (silently logged) and nothing could ever be verified. schema.sql now widens it to VARCHAR(30). Run `node db/migrate.js` once on the production DB.
- Verification runs daily 18:00 IST (existing cron); a prediction is verified after its horizon (7/30/90 days), so the first results appear 7+ days after the first analyses are logged post-migration.

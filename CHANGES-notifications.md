# Notifications — watchlist, portfolio, screener, sector heat, top movers, MCX

A real background alert system (previously alerts were only computed when a user opened the page, and the
bell icon did nothing).

## What users get
| Alert | Trigger | Example |
|---|---|---|
| **Top movers** | NSE top-150 (BSE fallback) stock crosses +/-3, 5, 7, 10, 15, 20% vs previous close | "🚀 WIPRO up +6.4% today" |
| **Sector heat** | A sector's average move crosses 1/2/3/4/6% **and** ≥60% of its stocks agree (min 3 stocks) | "🔥 IT sector heating up +3.2%" |
| **Screener signals** | Screener daily signal is *strong bullish/bearish* with strength ≥ user's minimum (default 80) | "🟢 TCS — strong bullish technical alignment" |
| **Watchlist** | Watchlist stock day-move milestone, or a strong screener signal on it | "⭐ Watchlist: TCS up +5.1%" |
| **Price alerts** | Watchlist `alert_price` / `alert_direction` is crossed (fires once per alert level) | "🎯 TCS hit your price alert" |
| **Portfolio** | Holding day-move milestone + P&L vs buy price at +/-10, 20, 30, 50, 100% | "🏆 TCS is up 20.0% on your buy price" |
| **MCX** | Commodity front-month crosses +/-2, 3, 5, 10% (MCX session 09:00–23:30 IST) | "📈 MCX GOLD up +2.30%" |

Channels: in-app bell (unread badge + dropdown + toast), email (personal alerts only, max 10/day), and
browser/phone Web Push (works with the tab closed). Every category and threshold is user-configurable
in **Dashboard → Alerts → Notification settings**.

Each event is deduped per user (`UNIQUE(user_id, dedupe_key)`), so the 5-minute scanner never repeats itself.
Wording is descriptive only — no buy/sell calls, no promised price moves (matches the app's compliance stance).

## Files
Backend (new): `services/notificationService.js` (storage + email/push delivery), `services/notificationEngine.js`
(scanners), `routes/notificationRoutes.js`, `utils/notificationRules.js` (pure rules), `utils/sectorMap.js`
(sector map + curated top-150), `db/notificationsSchema.js`, tests `tests/notificationRules.test.js`,
`tests/notificationEngine.test.js`.
Backend (edited): `server.js` (mount `/api/notifications`), `services/tokenScheduler.js` (cron), `db/autoMigrate.js` +
`db/schema.sql` (tables), `config/index.js` (VAPID), `middleware/rateLimit.js` (bell polling limiter), `package.json`
(`web-push`), `.env.example`.
Frontend: `index.html` (bell, dropdown, toast, notification centre/settings, push opt-in), new `sw.js` (service worker).

## Schedule (IST)
- every 5 min, Mon–Fri 09:00–23:55 → personal + market scans (each exchange checks its own session/holidays)
- 09:02–15:57 every 5 min → screener signal scan (runs just after the coverage batch writes signals)
- 03:30 daily → delete notifications older than 30 days

## Deploy checklist
1. `cd backend && npm install` (adds `web-push`).
2. Tables are created automatically at boot (autoMigrate) — no manual migration needed.
3. **Optional, for phone/browser push:** `npx web-push generate-vapid-keys`, then set `VAPID_PUBLIC_KEY`,
   `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` on the backend. Without them, in-app + email still work and the push toggle is disabled.
4. Email needs your existing SMTP settings (same as password-reset mail).
5. Verify after deploy: Dashboard → Alerts → **Send test**; admins can also `POST /api/notifications/admin/run`
   to run all scanners immediately.

## Honest limitations
- Needs a live Upstox token (same dependency as the rest of market data). No token → scans quietly do nothing.
- "Top 150" is a curated liquid list in `utils/sectorMap.js` (the old UI's "top 150" was just the first 150 alphabetically).
  BSE is used as a fallback for names NSE can't resolve; BSE-only small caps are deliberately excluded (circuit-limited noise).
- "Bullish/bearish" alerts reflect indicator alignment from the Screener — not a probability of price going up.
- Sector mapping is a static table (Upstox has no sector field); unmapped stocks are skipped, never guessed.
- Not run against a live Postgres/Upstox in the build sandbox. Rule logic and engine decision flow are unit-tested
  (`npm test`); the SQL and delivery paths are verified by the deploy checklist above.

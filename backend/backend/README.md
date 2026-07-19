# TradeMind AI — Backend

Node.js + Express + PostgreSQL backend covering auth, database, payments,
**and AI analysis** — real, runnable code, not a mockup. It will not run
anywhere until you complete the external setup steps below (these require
dashboards/accounts only you can create).

## What's actually implemented here

- **Auth**: email/password signup+login (bcrypt), Google Sign-In (verified server-side), JWT access + refresh tokens, device session tracking, logout/revoke
- **Database**: full PostgreSQL schema (`db/schema.sql`) — users, subscriptions, payments, portfolio, watchlist, ai_requests, prediction_history, api_usage, referrals, advertisers, admin_logs, webhook_events
- **Payments**: Razorpay order creation, signature verification (frontend callback AND webhook, both required), idempotent subscription activation, referral crediting on first payment
- **Referrals**: `/api/referral` returns the user's real referral code (auto-generated on first request) and real referral history from the `referrals` table — crediting happens via `referralService.js` when a referred user's first payment is captured
- **AI analysis**: `services/aiService.js` calls Gemini, Claude, ChatGPT, and DeepSeek **directly** (no separate AI engine process — API keys live in this repo's `.env`, never sent to the frontend). Plan-based routing:
  - Free → Gemini Flash only
  - Basic → Gemini Flash, falls back to DeepSeek V3 on failure
  - Pro → Gemini Flash + Claude Sonnet + ChatGPT called in parallel, consensus result (DeepSeek V3 fallback if all three fail)
  - Elite → Gemini Pro + Claude Opus + ChatGPT + DeepSeek R1 called in parallel, consensus + per-model debate
- **Per-model cost protection**: each model has its own `maxOutputTokens` (caps a single call) and its own `monthlyTokenQuota` (caps that model's total usage per user per month) — defined per plan in `config/plans.js`. `middleware/planCheck.js` enforces these in three layers: `enforceTokenQuota` (plan-wide monthly token budget), `enforceAiQueryLimit` (plan-wide monthly request count), `attachAvailableModels` (skips any individual model whose own sub-quota is exhausted, instead of calling it anyway). See the worst-case cost math in the comments at the top of `config/plans.js`.
- **Per-model cost logging**: every `/api/ai/analyze` call writes one `ai_requests` row per model actually called (tagged with a shared `request_id` so monthly query-count limits still count it as one request), so per-model spend is exact, not approximated.
- **Plan enforcement**: feature gating (`requireFeature`) reads from one config file (`config/plans.js`)
- **Admin**: stats endpoint (users, revenue, AI cost by model, plan distribution), user list, manual plan override, per-user API cost monitoring
- **Security**: helmet, CORS locked to your frontend origin, rate limiting (general + stricter on auth/payment), parameterized SQL everywhere (no injection risk), httpOnly cookies

## What's intentionally NOT in this repo yet

- **Telegram / WhatsApp alert delivery** — schema and `plans.js` reference these as planned features; the frontend shows them as "Coming Soon." No bot, no webhook, no delivery code exists yet.
- **News Sentiment AI** — same status: planned, not implemented. No news ingestion or scoring pipeline exists. The frontend page shows a "Coming Soon" empty state, not fabricated data.
- **2FA (TOTP)** — schema has the columns (`two_fa_enabled`, `two_fa_secret`), no implementation yet.
- **PDF report generation** — listed as an Elite feature in `plans.js`, not implemented.
- **WebSocket market data / live streaming quotes** — Upstox REST integration exists for quotes/candles (see `.env.example`); WebSocket streaming is not built.

If you wire a route to any feature in this list before building the real integration, you'll recreate the same "looks live, isn't" problem this codebase had with its admin/referral dashboards before this cleanup — don't.

## Setup steps (things only YOU can do, in external dashboards)

### 1. Database — Supabase (or any PostgreSQL host)
1. Create a project at supabase.com
2. Project Settings → Database → copy the connection string → paste into `.env` as `DATABASE_URL`
3. Run `npm install` then `npm run migrate` (applies `db/schema.sql`)
4. Optional: `node db/seed.js` to create a test admin login

### 2. Google Sign-In
1. Go to console.cloud.google.com → create a project
2. APIs & Services → OAuth consent screen → configure (External, add your app name/logo)
3. Credentials → Create Credentials → OAuth Client ID → type "Web application"
4. Add your frontend URL to "Authorized JavaScript origins"
5. Copy Client ID into `.env` as `GOOGLE_CLIENT_ID` (the secret isn't actually needed for the ID-token-verification flow used here, but keep it for future use)
6. On the frontend, use Google Identity Services to render the Sign-In button and get an `idToken`, then `POST` it to `/api/auth/google`

### 3. Razorpay
1. Sign up at razorpay.com, complete KYC (required before you can accept real payments — this takes a few days)
2. Dashboard → Settings → API Keys → generate Test keys first, paste into `.env`
3. Dashboard → Settings → Webhooks → add endpoint `https://yourdomain.com/api/payment/webhook`, subscribe to `payment.captured` and `payment.failed`, copy the webhook secret into `.env`
4. Test with Razorpay's test card numbers before going live
5. Switch to Live keys only after KYC is approved and you've tested the full flow

### 4. AI provider API keys
At minimum `GEMINI_API_KEY` is required (powers Free + Basic). Add `CLAUDE_API_KEY`,
`OPENAI_API_KEY`, and `DEEPSEEK_API_KEY` to enable the Pro and Elite model stacks —
see the comments in `.env.example` for exactly which keys gate which plan, and
where to get each one (Google AI Studio, Anthropic Console, OpenAI Platform,
DeepSeek Platform). Missing keys don't crash the server — `aiService.js` just
skips that model in the parallel call and uses whichever models do have keys.

### 5. Environment variables
```
cp .env.example .env
# fill in every value — server.js will refuse to start if DATABASE_URL or JWT secrets are missing
```

Generate strong JWT secrets with:
```
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Running locally
```
npm install
npm run migrate
npm run dev          # nodemon, restarts on file changes
# server runs on http://localhost:5000, health check at /health
```

## Deploying
This is a plain Express app — deploys to Render, Railway, Fly.io, or a VPS with PM2.
None of this works on Vercel/Netlify as-is (those are serverless/static-first;
a long-running Express server fits a container/VM host better, especially once
WebSocket market data is added later).

## API surface (for your frontend to call)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | /api/auth/signup | – | Email/password signup |
| POST | /api/auth/login | – | Email/password login |
| POST | /api/auth/google | – | Google Sign-In (send idToken) |
| POST | /api/auth/refresh | – | Get new access token via refresh cookie |
| POST | /api/auth/logout | – | Revoke session |
| GET | /api/auth/me | ✅ | Current user |
| GET | /api/auth/sessions | ✅ | Device login history |
| DELETE | /api/auth/sessions/:id | ✅ | Revoke a device |
| POST | /api/payment/create-order | ✅ | Start Razorpay checkout |
| POST | /api/payment/verify | ✅ | Confirm payment, activate plan |
| POST | /api/payment/webhook | – (Razorpay only, signature-verified) | Server-to-server payment confirmation |
| GET | /api/payment/history | ✅ | Billing history |
| GET/POST/PUT/DELETE | /api/portfolio | ✅ | Holdings CRUD + P&L |
| GET/POST/DELETE | /api/watchlist | ✅ | Watchlist CRUD (plan-limited) |
| POST | /api/ai/analyze | ✅ | Real multi-model AI analysis (see above) |
| GET | /api/ai/quota | ✅ | Monthly token/query usage, plan-wide AND per-model breakdown |
| GET | /api/referral | ✅ | Real referral code, stats, and history |
| GET | /api/admin/stats | ✅ admin | Dashboard metrics |
| GET | /api/admin/users | ✅ admin | User list |
| PATCH | /api/admin/users/:id/plan | ✅ admin | Manual plan override |
| GET | /api/admin/api-usage | ✅ admin | Per-user AI cost |

## Honest gaps / what to build next
- Telegram/WhatsApp alert delivery (bot + webhook + dispatch logic)
- News Sentiment AI (ingestion pipeline + scoring)
- 2FA (TOTP) — schema ready, no implementation
- PDF report generation (Elite feature, listed but not built)
- WebSocket market data streaming
- Frontend itself isn't in this folder — this is backend-only

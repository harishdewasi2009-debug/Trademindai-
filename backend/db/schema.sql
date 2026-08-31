-- ══════════════════════════════════════════════════════════════
-- TradeMind AI — PostgreSQL Schema
-- Run with: psql $DATABASE_URL -f db/schema.sql
-- Or via the migrate.js script (node db/migrate.js)
-- ══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── USERS ──
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            VARCHAR(120) NOT NULL,
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255),              -- NULL if user only ever signed up via Google
  google_id       VARCHAR(255) UNIQUE,
  phone           VARCHAR(20),
  plan            VARCHAR(20) NOT NULL DEFAULT 'free',   -- free | basic | pro | elite
  subscription_status VARCHAR(20) NOT NULL DEFAULT 'inactive', -- inactive | active | cancelled | past_due
  is_admin        BOOLEAN NOT NULL DEFAULT FALSE,
  two_fa_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
  two_fa_secret   VARCHAR(255),
  referral_code   VARCHAR(20) UNIQUE,
  referred_by     UUID REFERENCES users(id),
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);

-- ── SESSIONS / DEVICE LOGIN HISTORY ──
CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(255) NOT NULL,
  device_label    VARCHAR(255),       -- e.g. "Chrome on Windows"
  ip_address      VARCHAR(64),
  user_agent      TEXT,
  is_revoked      BOOLEAN NOT NULL DEFAULT FALSE,
  last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- ── PASSWORD RESETS ──
-- One-time tokens for the "forgot password" flow. We store only a hash of the
-- token (never the raw token) — same pattern as the refresh-token sessions above.
CREATE TABLE IF NOT EXISTS password_resets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      VARCHAR(255) NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON password_resets(token_hash);

-- ── SUBSCRIPTIONS ──
CREATE TABLE IF NOT EXISTS subscriptions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_name       VARCHAR(20) NOT NULL,      -- basic | pro | elite
  amount          NUMERIC(10,2) NOT NULL,
  razorpay_subscription_id VARCHAR(255),
  razorpay_plan_id VARCHAR(255),
  start_date      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expiry_date     TIMESTAMPTZ NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'active', -- active | expired | cancelled | past_due
  auto_renew      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

-- ── PAYMENTS ──
CREATE TABLE IF NOT EXISTS payments (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id       UUID REFERENCES subscriptions(id),
  razorpay_order_id     VARCHAR(255) NOT NULL,
  razorpay_payment_id   VARCHAR(255),
  razorpay_signature    VARCHAR(255),
  amount                NUMERIC(10,2) NOT NULL,
  currency              VARCHAR(10) NOT NULL DEFAULT 'INR',
  plan_name             VARCHAR(20) NOT NULL,
  status                VARCHAR(20) NOT NULL DEFAULT 'created', -- created | paid | failed | refunded
  failure_reason        TEXT,
  invoice_url           TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(razorpay_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_payment_id ON payments(razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;

-- ── PORTFOLIO ──
CREATE TABLE IF NOT EXISTS portfolios (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_symbol    VARCHAR(30) NOT NULL,
  stock_name      VARCHAR(120),
  quantity        NUMERIC(14,4) NOT NULL,
  buy_price       NUMERIC(12,2) NOT NULL,
  current_price   NUMERIC(12,2),
  sector          VARCHAR(60),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portfolios_user_id ON portfolios(user_id);

-- ── WATCHLIST ──
CREATE TABLE IF NOT EXISTS watchlist (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_symbol    VARCHAR(30) NOT NULL,
  stock_name      VARCHAR(120),
  alert_price     NUMERIC(12,2),
  alert_direction VARCHAR(10),     -- above | below
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, stock_symbol)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_user_id ON watchlist(user_id);

-- ── AI REQUESTS (every AI call logged for cost tracking) ──
-- FIX: added request_id and model_key. Pro/Elite call multiple models in
-- PARALLEL per user action, and each model now gets its own row (previously
-- all models for one request were merged into a single row with a joined
-- model_used string like "gemini-2.5-flash+claude-sonnet-4-6+gpt-4o", which
-- made per-model cost/quota tracking impossible). request_id groups the rows
-- belonging to one logical user request (so monthlyAiQueries counts requests,
-- not individual model calls); model_key is the plans.js key (e.g.
-- 'claude_sonnet') for exact per-model quota lookups, separate from
-- model_used which stays as the literal API model id for display/debugging.
CREATE TABLE IF NOT EXISTS ai_requests (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  request_id      UUID NOT NULL DEFAULT uuid_generate_v4(), -- groups multi-model rows from one user action
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stock_symbol    VARCHAR(30),
  request_type    VARCHAR(40) NOT NULL,   -- quick_analysis | deep_research | chat | screener | portfolio_scan
  model_used      VARCHAR(60) NOT NULL,   -- internal only — never exposed to frontend response
  model_key       VARCHAR(40),            -- plans.js aiModels key, e.g. 'claude_sonnet' (NULL for legacy rows)
  tokens_input    INTEGER DEFAULT 0,
  tokens_output   INTEGER DEFAULT 0,
  cost_usd        NUMERIC(10,6) DEFAULT 0,
  latency_ms      INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Safe to re-run against an existing DB that predates request_id/model_key:
ALTER TABLE ai_requests ADD COLUMN IF NOT EXISTS request_id UUID NOT NULL DEFAULT uuid_generate_v4();
ALTER TABLE ai_requests ADD COLUMN IF NOT EXISTS model_key  VARCHAR(40);
CREATE INDEX IF NOT EXISTS idx_ai_requests_user_id ON ai_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_requests_created_at ON ai_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_ai_requests_request_id ON ai_requests(request_id);
CREATE INDEX IF NOT EXISTS idx_ai_requests_model_key ON ai_requests(user_id, model_key, created_at);

-- ── PREDICTION HISTORY (for accuracy tracking) ──
CREATE TABLE IF NOT EXISTS prediction_history (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  stock_symbol      VARCHAR(30) NOT NULL,
  recommendation    VARCHAR(10) NOT NULL,   -- buy | sell | hold
  entry_price       NUMERIC(12,2) NOT NULL,
  target_price      NUMERIC(12,2),
  horizon_days      INTEGER NOT NULL DEFAULT 30,
  confidence_score  NUMERIC(5,2),
  actual_price_at_horizon NUMERIC(12,2),
  outcome           VARCHAR(12),   -- pending | correct | incorrect
  evaluated_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prediction_history_symbol ON prediction_history(stock_symbol);
CREATE INDEX IF NOT EXISTS idx_prediction_history_outcome ON prediction_history(outcome);

-- ── SCANNER SIGNAL HISTORY (accuracy tracking for the Screener's rule-based
-- bullish/bearish/neutral bias — separate from prediction_history above,
-- which only covers the manual "AI Analyze" deep-dive on a single stock.
-- The Screener computes a technical signal for every stock it scans, for
-- every Time Interval chip (1m ... 5y); this table logs one row per
-- symbol+timeframe+day (first signal of the day, market-hours only) so the
-- admin panel can show accuracy across the FULL scanned market, broken
-- down by timeframe, not just the small number of stocks a user manually
-- ran deep AI analysis on. ──
CREATE TABLE IF NOT EXISTS scanner_signal_history (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  stock_symbol             VARCHAR(30) NOT NULL,
  exchange                 VARCHAR(10),
  timeframe                VARCHAR(10) NOT NULL DEFAULT '1d',  -- Screener Time Interval chip: 1m,5m,15m,30m,1h,4h,1d,1w,1mo,3mo,6mo,1y,3y,5y
  signal                   VARCHAR(20) NOT NULL,                -- strong_bullish | strong_bearish | neutral
  strength_score           INTEGER,                             -- 0-100 technical strength (see indicators.js deriveSignal)
  entry_price              NUMERIC(12,2) NOT NULL,
  horizon_days             INTEGER NOT NULL,                    -- how far out this timeframe is checked (see TIMEFRAME_HORIZON_DAYS)
  actual_price_at_horizon  NUMERIC(12,2),
  outcome                  VARCHAR(12) NOT NULL DEFAULT 'pending', -- pending | correct | incorrect
  signal_date              DATE NOT NULL DEFAULT CURRENT_DATE,   -- IST trading day the signal was generated on
  evaluated_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stock_symbol, exchange, timeframe, signal_date)
);
CREATE INDEX IF NOT EXISTS idx_scanner_signal_symbol ON scanner_signal_history(stock_symbol);
CREATE INDEX IF NOT EXISTS idx_scanner_signal_outcome ON scanner_signal_history(outcome);
CREATE INDEX IF NOT EXISTS idx_scanner_signal_timeframe ON scanner_signal_history(timeframe);

-- ── API USAGE (daily rollup per user per provider, for plan limits + cost control) ──
CREATE TABLE IF NOT EXISTS api_usage (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        VARCHAR(40) NOT NULL,    -- openai | gemini | claude | deepseek
  usage_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  request_count   INTEGER NOT NULL DEFAULT 0,
  tokens_total    INTEGER NOT NULL DEFAULT 0,
  cost_usd        NUMERIC(10,6) NOT NULL DEFAULT 0,
  UNIQUE(user_id, provider, usage_date)
);
CREATE INDEX IF NOT EXISTS idx_api_usage_user_date ON api_usage(user_id, usage_date);

-- ── REFERRALS ──
CREATE TABLE IF NOT EXISTS referrals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credit_amount   NUMERIC(10,2) NOT NULL DEFAULT 500,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | credited
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(referrer_id, referred_id)
);

-- ── ADVERTISERS ──
CREATE TABLE IF NOT EXISTS advertisers (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_name    VARCHAR(150) NOT NULL,
  contact_email   VARCHAR(255) NOT NULL,
  monthly_budget  NUMERIC(12,2),
  placement       VARCHAR(60),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | active | paused | ended
  impressions     INTEGER NOT NULL DEFAULT 0,
  clicks          INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── ADMIN LOGS ──
CREATE TABLE IF NOT EXISTS admin_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id        UUID REFERENCES users(id),
  action          VARCHAR(255) NOT NULL,
  target_table    VARCHAR(60),
  target_id       UUID,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── WEBHOOK EVENTS (idempotency log for Razorpay webhooks) ──
CREATE TABLE IF NOT EXISTS webhook_events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider        VARCHAR(30) NOT NULL DEFAULT 'razorpay',
  event_id        VARCHAR(255) NOT NULL,
  event_type      VARCHAR(100),
  payload         JSONB,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, event_id)
);

-- ── BROKER TOKENS (Upstox OAuth access token — one app-level connection,
--    shared across all users; NOT a per-user broker login) ──
CREATE TABLE IF NOT EXISTS broker_tokens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider        VARCHAR(30) NOT NULL DEFAULT 'upstox',
  access_token    TEXT NOT NULL,
  -- Upstox tokens are calendar-day-scoped: they expire ~3:30am IST the day
  -- after issue, regardless of issue time. We store the literal expiry we
  -- compute at insert time rather than trusting any "expires_in" field.
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider)
);

-- Per-USER Upstox broker connection — separate from broker_tokens above,
-- which is the one shared admin token that powers market data (quotes,
-- candles, option chain) for every visitor. This table is for each
-- individual trader connecting THEIR OWN Upstox account so we can show
-- their real holdings/positions/orders — a different login than the
-- shared market-data one.
CREATE TABLE IF NOT EXISTS user_broker_tokens (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        VARCHAR(30) NOT NULL DEFAULT 'upstox',
  access_token    TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);

-- ── INSTRUMENT CACHE (maps plain trading symbols, e.g. "RELIANCE", to the
--    Upstox instrument_key, e.g. "NSE_EQ|INE002A01018". Upstox's full
--    instrument master is a ~30MB JSON/CSV refreshed daily; we cache the
--    rows we actually need instead of re-downloading it per request) ──
CREATE TABLE IF NOT EXISTS instrument_cache (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  exchange        VARCHAR(20) NOT NULL DEFAULT 'NSE_EQ',
  trading_symbol  VARCHAR(40) NOT NULL,
  instrument_key  VARCHAR(80) NOT NULL,
  name            VARCHAR(200),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(exchange, trading_symbol)
);
CREATE INDEX IF NOT EXISTS idx_instrument_cache_symbol ON instrument_cache(trading_symbol);

-- ── FEEDBACK (Dashboard "Feedback" section — subject/category/rating/message) ──
CREATE TABLE IF NOT EXISTS feedback (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject     VARCHAR(150) NOT NULL,
  category    VARCHAR(40) NOT NULL,
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  message     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_user_id ON feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);

-- ── updated_at auto-touch trigger ──
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS trg_portfolios_updated_at ON portfolios;
CREATE TRIGGER trg_portfolios_updated_at BEFORE UPDATE ON portfolios
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

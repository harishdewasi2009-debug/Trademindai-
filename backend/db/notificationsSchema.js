// db/notificationsSchema.js — notification tables. Idempotent; used by both
// autoMigrate.js (self-healing at boot) and mirrored in schema.sql.
module.exports = [
  `CREATE TABLE IF NOT EXISTS notifications (
     id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
     user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     type        VARCHAR(30) NOT NULL,
     category    VARCHAR(20) NOT NULL,
     severity    VARCHAR(10) NOT NULL DEFAULT 'info',
     symbol      VARCHAR(40),
     exchange    VARCHAR(10),
     title       VARCHAR(200) NOT NULL,
     body        TEXT,
     data        JSONB,
     dedupe_key  VARCHAR(200) NOT NULL,
     read_at     TIMESTAMPTZ,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (user_id, dedupe_key)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (user_id) WHERE read_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS notification_prefs (
     user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     in_app             BOOLEAN NOT NULL DEFAULT TRUE,
     email              BOOLEAN NOT NULL DEFAULT FALSE,
     push               BOOLEAN NOT NULL DEFAULT FALSE,
     watchlist          BOOLEAN NOT NULL DEFAULT TRUE,
     portfolio          BOOLEAN NOT NULL DEFAULT TRUE,
     price_alerts       BOOLEAN NOT NULL DEFAULT TRUE,
     screener           BOOLEAN NOT NULL DEFAULT TRUE,
     sector_heat        BOOLEAN NOT NULL DEFAULT TRUE,
     top_movers         BOOLEAN NOT NULL DEFAULT TRUE,
     mcx                BOOLEAN NOT NULL DEFAULT TRUE,
     move_threshold     NUMERIC(5,1) NOT NULL DEFAULT 5,
     sector_threshold   NUMERIC(5,1) NOT NULL DEFAULT 2,
     watchlist_threshold NUMERIC(5,1) NOT NULL DEFAULT 3,
     min_signal_score   INTEGER NOT NULL DEFAULT 80,
     updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
     id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
     user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     endpoint    TEXT NOT NULL UNIQUE,
     p256dh      TEXT NOT NULL,
     auth        TEXT NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_id)`,
];

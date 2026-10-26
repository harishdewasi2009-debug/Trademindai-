// services/notificationService.js
// Storage + delivery for notifications: in-app (DB rows the bell reads),
// email (existing nodemailer setup) and browser/phone Web Push (optional —
// needs the `web-push` package and VAPID keys; silently skipped otherwise).
//
// Every notification has a dedupe_key and UNIQUE(user_id, dedupe_key), so the
// scan engine can run every few minutes and a user is told about a given
// event exactly once.

const { query } = require('../db/pool');
const { config } = require('../config');
const { DEFAULT_PREFS } = require('../utils/notificationRules');

const MAX_EMAILS_PER_USER_PER_DAY = 10;
const PREF_BOOL_KEYS = ['in_app', 'email', 'push', 'watchlist', 'portfolio', 'price_alerts', 'screener', 'sector_heat', 'top_movers', 'mcx'];
const PREF_NUM_LIMITS = {
  move_threshold: [2, 25], sector_threshold: [0.5, 10],
  watchlist_threshold: [1, 25], min_signal_score: [50, 100],
};

// ── Web Push (lazy, optional) ───────────────────────────────────────────
let webpush = null;
let pushReady = false;
function initPush() {
  if (pushReady) return true;
  if (!config.vapid.publicKey || !config.vapid.privateKey) return false;
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey);
    pushReady = true;
  } catch (e) {
    console.warn('[notifications] web-push unavailable — push disabled:', e.message);
  }
  return pushReady;
}
const pushEnabled = () => initPush();

// ── Prefs ───────────────────────────────────────────────────────────────
async function getPrefs(userId) {
  const { rows } = await query('SELECT * FROM notification_prefs WHERE user_id = $1', [userId]);
  return { ...DEFAULT_PREFS, ...(rows[0] ? clean(rows[0]) : {}) };
}
function clean(row) {
  const out = {};
  for (const k of PREF_BOOL_KEYS) out[k] = !!row[k];
  for (const k of Object.keys(PREF_NUM_LIMITS)) out[k] = Number(row[k]);
  return out;
}
async function updatePrefs(userId, input = {}) {
  const current = await getPrefs(userId);
  const next = { ...current };
  for (const k of PREF_BOOL_KEYS) if (typeof input[k] === 'boolean') next[k] = input[k];
  for (const [k, [lo, hi]] of Object.entries(PREF_NUM_LIMITS)) {
    const n = Number(input[k]);
    if (input[k] !== undefined && Number.isFinite(n)) next[k] = Math.min(hi, Math.max(lo, k === 'min_signal_score' ? Math.round(n) : n));
  }
  await query(
    `INSERT INTO notification_prefs (user_id, ${PREF_BOOL_KEYS.join(', ')}, ${Object.keys(PREF_NUM_LIMITS).join(', ')}, updated_at)
     VALUES ($1, ${[...PREF_BOOL_KEYS, ...Object.keys(PREF_NUM_LIMITS)].map((_, i) => `$${i + 2}`).join(', ')}, now())
     ON CONFLICT (user_id) DO UPDATE SET
       ${[...PREF_BOOL_KEYS, ...Object.keys(PREF_NUM_LIMITS)].map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, updated_at = now()`,
    [userId, ...PREF_BOOL_KEYS.map((k) => next[k]), ...Object.keys(PREF_NUM_LIMITS).map((k) => next[k])]
  );
  return next;
}

// ── Creating notifications ──────────────────────────────────────────────
/**
 * Insert one notification for one user (deduped). Returns the row, or null if
 * the user already got this event. Delivery to email/push honours prefs.
 * opts.email: whether this type may be emailed (personal alerts only).
 */
async function notifyUser(userId, n, opts = {}) {
  const { rows } = await query(
    `INSERT INTO notifications (user_id, type, category, severity, symbol, exchange, title, body, data, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING *`,
    [userId, n.type, n.category, n.severity || 'info', n.symbol || null, n.exchange || null,
      n.title.slice(0, 200), n.body || null, n.data ? JSON.stringify(n.data) : null, n.dedupeKey]
  );
  if (!rows[0]) return null;
  deliverExternal([userId], rows[0], opts).catch((e) => console.warn('[notifications] delivery failed:', e.message));
  return rows[0];
}

/**
 * Broadcast one market-wide event to every user whose prefs allow it.
 * prefFilter: SQL boolean expression over alias `p` (prefs, may be NULL-joined)
 * e.g. "COALESCE(p.top_movers, TRUE) AND COALESCE(p.move_threshold, 5) <= $N"
 * Returns the user ids that newly received it.
 */
async function broadcast(n, prefFilter = 'TRUE', filterParams = []) {
  const base = 9; // number of fixed params below
  const shifted = prefFilter.replace(/\$(\d+)/g, (_, i) => `$${Number(i) + base}`);
  const { rows } = await query(
    `INSERT INTO notifications (user_id, type, category, severity, symbol, exchange, title, body, data, dedupe_key)
     SELECT u.id, $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::varchar, $7::text, $8::jsonb, $9::varchar
       FROM users u LEFT JOIN notification_prefs p ON p.user_id = u.id
      WHERE COALESCE(p.in_app, TRUE) AND (${shifted})
     ON CONFLICT (user_id, dedupe_key) DO NOTHING
     RETURNING id, user_id`,
    [n.type, n.category, n.severity || 'info', n.symbol || null, n.exchange || null,
      n.title.slice(0, 200), n.body || null, n.data ? JSON.stringify(n.data) : null, n.dedupeKey, ...filterParams]
  );
  const userIds = rows.map((r) => r.user_id);
  if (userIds.length) {
    // Market-wide events go to push only (never email — would be spam).
    deliverExternal(userIds, { ...n, symbol: n.symbol, data: n.data }, { email: false })
      .catch((e) => console.warn('[notifications] broadcast delivery failed:', e.message));
  }
  return userIds;
}

// ── External delivery ───────────────────────────────────────────────────
async function deliverExternal(userIds, n, { email = false } = {}) {
  if (!userIds.length) return;
  const { rows: users } = await query(
    `SELECT u.id, u.email, u.name, COALESCE(p.email, FALSE) AS want_email, COALESCE(p.push, FALSE) AS want_push
       FROM users u LEFT JOIN notification_prefs p ON p.user_id = u.id WHERE u.id = ANY($1::uuid[])`,
    [userIds]
  );

  // Web Push
  const pushUsers = users.filter((u) => u.want_push).map((u) => u.id);
  if (pushUsers.length && initPush()) {
    const { rows: subs } = await query('SELECT * FROM push_subscriptions WHERE user_id = ANY($1::uuid[])', [pushUsers]);
    const payload = JSON.stringify({ title: n.title, body: n.body || '', tag: n.dedupeKey || n.dedupe_key, url: '/#alerts', symbol: n.symbol || null });
    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' });
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) await query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]).catch(() => {});
        else console.warn('[notifications] push failed:', err.statusCode || err.message);
      }
    }));
  }

  // Email (personal alerts only, daily cap per user)
  if (email) {
    const { sendEmail } = require('./emailService');
    for (const u of users.filter((x) => x.want_email)) {
      try {
        const { rows } = await query(
          `SELECT COUNT(*)::int AS n FROM notifications
            WHERE user_id = $1 AND created_at > now() - interval '24 hours' AND category IN ('watchlist','portfolio','price')`,
          [u.id]
        );
        if (rows[0].n > MAX_EMAILS_PER_USER_PER_DAY) continue;
        await sendEmail({
          to: u.email,
          subject: `TradeMind AI alert: ${n.title}`,
          text: `${n.title}\n\n${n.body || ''}\n\nTechnical/price alerts are informational only, not investment advice.\nManage notifications: ${config.frontendUrl}`,
          html: `<div style="font-family:Arial,sans-serif;max-width:480px"><h3 style="margin:0 0 8px">${esc(n.title)}</h3><p style="color:#444">${esc(n.body || '')}</p><p style="font-size:12px;color:#888">Informational only — not investment advice. <a href="${config.frontendUrl}">Manage notifications</a></p></div>`,
        });
      } catch (e) { console.warn('[notifications] email failed:', e.message); }
    }
  }
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Reading / managing ──────────────────────────────────────────────────
async function list(userId, { limit = 30, before, unreadOnly = false } = {}) {
  const params = [userId, Math.min(Math.max(Number(limit) || 30, 1), 100)];
  let where = 'user_id = $1';
  if (unreadOnly) where += ' AND read_at IS NULL';
  if (before) { params.push(before); where += ` AND created_at < $${params.length}`; }
  const { rows } = await query(
    `SELECT id, type, category, severity, symbol, exchange, title, body, data, read_at, created_at
       FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT $2`, params);
  return rows;
}
async function unreadCount(userId) {
  const { rows } = await query('SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
  return rows[0].n;
}
async function markRead(userId, ids) {
  if (ids === 'all') await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
  else if (Array.isArray(ids) && ids.length) await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL', [userId, ids.slice(0, 200)]);
}
async function remove(userId, id) {
  if (id === 'all') await query('DELETE FROM notifications WHERE user_id = $1', [userId]);
  else await query('DELETE FROM notifications WHERE user_id = $1 AND id = $2', [userId, id]);
}
async function pruneOld() {
  await query(`DELETE FROM notifications WHERE created_at < now() - interval '30 days'`);
}

// ── Push subscriptions ──────────────────────────────────────────────────
async function savePushSubscription(userId, sub) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('Invalid push subscription');
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]);
}
async function removePushSubscription(userId, endpoint) {
  await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

module.exports = {
  getPrefs, updatePrefs, notifyUser, broadcast, list, unreadCount, markRead, remove, pruneOld,
  savePushSubscription, removePushSubscription, pushEnabled,
  vapidPublicKey: () => config.vapid.publicKey,
};

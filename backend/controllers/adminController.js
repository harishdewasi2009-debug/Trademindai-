// controllers/adminController.js
const { query } = require('../db/pool');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const { getAccuracyStats, evaluateDuePredictions, listAllPredictions } = require('../services/predictionAccuracyService');
const { config } = require('../config');

// AI provider bills come back from ai_requests.cost_usd in USD (that's what
// every model provider charges in) — this converts to INR purely for
// display in the admin panel. See config/index.js usdToInr for the rate.
const toInr = (usd) => Number((Number(usd || 0) * config.usdToInr).toFixed(2));

// ── GET /api/admin/stats ──
const getStats = asyncHandler(async (req, res) => {
  const [users, revenue, activeSubsByPlan, aiUsage, todayAi] = await Promise.all([
    query(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS new_this_week
      FROM users`),
    query(`SELECT COALESCE(SUM(amount),0)::float AS total
      FROM payments WHERE status = 'paid' AND created_at >= date_trunc('month', now())`),
    query(`SELECT plan, COUNT(*)::int AS count FROM users WHERE subscription_status = 'active' GROUP BY plan`),
    query(`SELECT model_used, COUNT(*)::int AS calls, COALESCE(SUM(cost_usd),0)::float AS cost
      FROM ai_requests WHERE created_at >= now() - interval '30 days' GROUP BY model_used ORDER BY calls DESC`),
    query(`SELECT COUNT(*)::int AS count FROM ai_requests WHERE created_at >= CURRENT_DATE`),
  ]);

  // FIX: AI cost was only ever shown to the admin in raw USD (what the
  // model providers actually bill in), even though everything else in the
  // admin panel — revenue, ARPU, plan pricing — is in INR. Attach the real
  // INR-converted figure per model and as a total so admin cost tracking
  // reads in the same currency as the business's own numbers.
  const aiUsageWithInr = aiUsage.rows.map((r) => ({ ...r, costInr: toInr(r.cost) }));
  const totalAiCostUsd = aiUsage.rows.reduce((s, r) => s + Number(r.cost || 0), 0);

  res.json({
    totalUsers: users.rows[0].total,
    newUsersThisWeek: users.rows[0].new_this_week,
    monthlyRevenue: revenue.rows[0].total,
    activeSubsByPlan: activeSubsByPlan.rows,
    aiUsageLast30Days: aiUsageWithInr,
    aiQueriesToday: todayAi.rows[0].count,
    aiCostLast30DaysUsd: Number(totalAiCostUsd.toFixed(4)),
    aiCostLast30DaysInr: toInr(totalAiCostUsd),
    usdToInrRate: config.usdToInr,
  });
});

// ── GET /api/admin/users ──
const listUsers = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = 50;
  const { rows } = await query(
    `SELECT id, name, email, plan, subscription_status, is_admin, created_at
     FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, (page - 1) * limit]
  );
  res.json({ users: rows, page });
});

// ── PATCH /api/admin/users/:id/plan ── (manually override a user's plan, e.g. comp account / support fix)
const updateUserPlan = asyncHandler(async (req, res) => {
  const { plan } = req.body;
  if (!['free', 'basic', 'pro', 'elite'].includes(plan)) throw new AppError('Invalid plan.', 400);

  const { rows } = await query('UPDATE users SET plan = $1 WHERE id = $2 RETURNING id, name, email, plan', [plan, req.params.id]);
  if (!rows.length) throw new AppError('User not found.', 404);

  await query(
    `INSERT INTO admin_logs (admin_id, action, target_table, target_id, metadata)
     VALUES ($1, 'updated_user_plan', 'users', $2, $3)`,
    [req.user.id, req.params.id, JSON.stringify({ newPlan: plan })]
  );

  res.json({ user: rows[0] });
});

// ── GET /api/admin/api-usage ── (cost monitoring per user, flags heavy usage)
const getApiUsage = asyncHandler(async (req, res) => {
  const { rows } = await query(`
    SELECT u.id, u.name, u.email, u.plan,
      COUNT(ar.*)::int AS requests_30d,
      COALESCE(SUM(ar.cost_usd),0)::float AS cost_30d
    FROM users u
    LEFT JOIN ai_requests ar ON ar.user_id = u.id AND ar.created_at >= now() - interval '30 days'
    GROUP BY u.id, u.name, u.email, u.plan
    HAVING COUNT(ar.*) > 0
    ORDER BY cost_30d DESC
    LIMIT 100
  `);
  res.json({
    usage: rows.map((r) => ({ ...r, cost_30d_inr: toInr(r.cost_30d) })),
    usdToInrRate: config.usdToInr,
  });
});

// ── GET /api/admin/ai-accuracy ── (studies REAL price outcomes vs the AI's
// past sentiment reads, aggregated across ALL users — backward-looking
// quality check, not a new prediction. See predictionAccuracyService.js.)
const getAiAccuracy = asyncHandler(async (req, res) => {
  const stats = await getAccuracyStats();
  res.json(stats);
});

// ── POST /api/admin/ai-accuracy/evaluate-now ── (manual trigger, in case
// you don't want to wait for the 18:00 IST daily cron job)
const runAiAccuracyEvaluationNow = asyncHandler(async (req, res) => {
  const result = await evaluateDuePredictions();
  res.json({ message: 'Evaluation run complete.', ...result });
});

// ── GET /api/admin/predictions ── (full raw log of EVERY prediction ever
// logged — pending, correct, and incorrect — across every user and every
// date. This is the underlying data behind /ai-accuracy's aggregated
// numbers; nothing shown to a user via /api/ai/analyze ever falls out of
// this list, so the admin can always see exactly what was predicted, for
// whom, on what date, and (once evaluated) what really happened.)
const getAllPredictions = asyncHandler(async (req, res) => {
  const { page, limit, outcome, symbol, from, to } = req.query;
  const result = await listAllPredictions({ page, limit, outcome, symbol, from, to });
  res.json(result);
});

// ── GET /api/admin/advertisers ── (real enquiries submitted via the public
// "Advertise with us" form — controllers/advertiserController.js)
const listAdvertiserEnquiries = asyncHandler(async (req, res) => {
  const status = ['pending', 'active', 'paused', 'ended'].includes(req.query.status) ? req.query.status : undefined;
  const { rows } = await query(
    `SELECT id, company_name, contact_email, monthly_budget, placement, status, impressions, clicks, created_at
     FROM advertisers
     WHERE ($1::varchar IS NULL OR status = $1)
     ORDER BY created_at DESC
     LIMIT 200`,
    [status || null]
  );
  const { rows: pendingCount } = await query(`SELECT COUNT(*)::int AS count FROM advertisers WHERE status = 'pending'`);
  res.json({ enquiries: rows, pendingCount: pendingCount[0].count });
});

// ── PATCH /api/admin/advertisers/:id/status ── (approve/pause/end an enquiry)
const updateAdvertiserStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'active', 'paused', 'ended'].includes(status)) {
    throw new AppError('Invalid status.', 400);
  }
  const { rows } = await query(
    'UPDATE advertisers SET status = $1 WHERE id = $2 RETURNING id, company_name, contact_email, status',
    [status, req.params.id]
  );
  if (!rows.length) throw new AppError('Advertiser enquiry not found.', 404);

  await query(
    `INSERT INTO admin_logs (admin_id, action, target_table, target_id, metadata)
     VALUES ($1, 'updated_advertiser_status', 'advertisers', $2, $3)`,
    [req.user.id, req.params.id, JSON.stringify({ newStatus: status })]
  );

  res.json({ advertiser: rows[0] });
});

// ── GET /api/admin/feedback ── (every feedback form submission, newest first —
// backs the "User feedback" panel in the admin dashboard)
const listFeedback = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = 50;
  const category = req.query.category || undefined;

  const { rows } = await query(
    `SELECT f.id, f.subject, f.category, f.rating, f.message, f.created_at,
            u.name AS user_name, u.email AS user_email, u.plan AS user_plan
     FROM feedback f
     JOIN users u ON u.id = f.user_id
     WHERE ($1::varchar IS NULL OR f.category = $1)
     ORDER BY f.created_at DESC
     LIMIT $2 OFFSET $3`,
    [category || null, limit, (page - 1) * limit]
  );
  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS count FROM feedback WHERE ($1::varchar IS NULL OR category = $1)`,
    [category || null]
  );
  const { rows: avgRows } = await query(`SELECT ROUND(AVG(rating)::numeric,2) AS avg_rating, COUNT(*)::int AS total FROM feedback`);

  res.json({
    feedback: rows,
    page,
    total: countRows[0].count,
    totalPages: Math.max(1, Math.ceil(countRows[0].count / limit)),
    avgRating: avgRows[0].avg_rating != null ? Number(avgRows[0].avg_rating) : null,
    totalFeedback: avgRows[0].total,
  });
});

// ── GET /api/admin/referrals ── (every referral ever recorded, across all
// users — who referred whom, what plan they bought, and whether the referrer's
// credit has been paid out. Backs the "Referrals" panel in the admin dashboard.)
const listReferrals = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = 50;
  const status = ['pending', 'credited'].includes(req.query.status) ? req.query.status : undefined;

  const { rows } = await query(
    `SELECT r.id, r.credit_amount, r.status, r.created_at,
            ru.name AS referrer_name, ru.email AS referrer_email,
            du.name AS referred_name, du.email AS referred_email, du.plan AS referred_plan
     FROM referrals r
     JOIN users ru ON ru.id = r.referrer_id
     JOIN users du ON du.id = r.referred_id
     WHERE ($1::varchar IS NULL OR r.status = $1)
     ORDER BY r.created_at DESC
     LIMIT $2 OFFSET $3`,
    [status || null, limit, (page - 1) * limit]
  );
  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS count FROM referrals WHERE ($1::varchar IS NULL OR status = $1)`,
    [status || null]
  );
  const { rows: creditedRows } = await query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(credit_amount),0)::float AS total_credited
     FROM referrals WHERE status = 'credited'`
  );

  res.json({
    referrals: rows,
    page,
    total: countRows[0].count,
    totalPages: Math.max(1, Math.ceil(countRows[0].count / limit)),
    creditedCount: creditedRows[0].count,
    totalCreditedAmount: creditedRows[0].total_credited,
  });
});

module.exports = {
  getStats, listUsers, updateUserPlan, getApiUsage, getAiAccuracy, runAiAccuracyEvaluationNow,
  getAllPredictions, listAdvertiserEnquiries, updateAdvertiserStatus, listFeedback, listReferrals,
};

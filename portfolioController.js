// controllers/adminController.js
const { query } = require('../db/pool');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

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

  res.json({
    totalUsers: users.rows[0].total,
    newUsersThisWeek: users.rows[0].new_this_week,
    monthlyRevenue: revenue.rows[0].total,
    activeSubsByPlan: activeSubsByPlan.rows,
    aiUsageLast30Days: aiUsage.rows,
    aiQueriesToday: todayAi.rows[0].count,
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
  res.json({ usage: rows });
});

module.exports = { getStats, listUsers, updateUserPlan, getApiUsage };

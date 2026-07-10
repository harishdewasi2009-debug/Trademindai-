// middleware/planCheck.js
// Four jobs:
//   1. requireFeature(feature)      — block route unless user's plan includes the feature
//   2. enforceAiQueryLimit          — block once monthly REQUEST count is hit (backup gate)
//   3. enforceTokenQuota            — block once monthly TOKEN quota is hit (primary gate)
//                                     also attaches plan's maxTokensPerRequest to req
//                                     so aiService can cap output tokens correctly
//   4. attachAvailableModels        — computes which of this plan's models still have
//                                     quota left THIS model's own monthly budget, and
//                                     attaches the list so aiService skips exhausted
//                                     models instead of calling them and eating the cost
//                                     of a request that's over budget for that model.
//
// Flow for every /api/ai/analyze call:
//   requireAuth → enforceTokenQuota → enforceAiQueryLimit → attachAvailableModels → validateAiAnalyze → controller

const { query }                              = require('../db/pool');
const { getPlan, planHasFeature, getModelKeys } = require('../config/plans');
const AppError                               = require('../utils/AppError');
const asyncHandler                           = require('../utils/asyncHandler');

// ── 1. requireFeature ────────────────────────────────────────────────────
/** Must run after requireAuth. Usage: router.get('/backtest', requireAuth, requireFeature('backtesting'), handler) */
function requireFeature(feature) {
  return (req, res, next) => {
    if (!req.user) return next(new AppError('Not authenticated.', 401));
    if (!planHasFeature(req.user.plan, feature)) {
      return next(new AppError(
        `This feature requires a higher plan. Upgrade to unlock "${feature.replace(/_/g, ' ')}".`,
        403
      ));
    }
    next();
  };
}

// ── 2. enforceAiQueryLimit ───────────────────────────────────────────────
/**
 * Counts this user's AI requests so far this calendar month and blocks
 * if they've hit the plan's monthlyAiQueries cap (-1 = unlimited).
 * Acts as a secondary hard cap; the primary gate is enforceTokenQuota below.
 * Must run AFTER requireAuth and BEFORE the controller calls the AI engine.
 */
const enforceAiQueryLimit = asyncHandler(async (req, res, next) => {
  const plan = getPlan(req.user.plan);

  // Elite (and any plan with -1) is unlimited on request count
  if (plan.monthlyAiQueries === -1) {
    req.aiQuotaRemaining = null;
    return next();
  }

  // FIX: ai_requests now has one row PER MODEL CALLED (not one row per user
  // request), so COUNT(*) would overcount on Pro/Elite where every request
  // calls 3-4 models in parallel. COUNT(DISTINCT request_id) counts actual
  // user-initiated requests, which is what monthlyAiQueries is meant to cap.
  const { rows } = await query(
    `SELECT COUNT(DISTINCT request_id)::int AS count FROM ai_requests
     WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
    [req.user.id]
  );
  const used = rows[0].count;

  if (used >= plan.monthlyAiQueries) {
    throw new AppError(
      `You've used all ${plan.monthlyAiQueries} AI queries included in your ${plan.name} plan this month. Upgrade for more.`,
      429
    );
  }

  req.aiQuotaRemaining = plan.monthlyAiQueries - used - 1;
  next();
});

// ── 3. enforceTokenQuota ─────────────────────────────────────────────────
/**
 * PRIMARY cost-protection gate.
 *
 * Checks two things before allowing a request through:
 *   a) Monthly token budget — sum of (tokens_input + tokens_output) in ai_requests
 *      for this calendar month must be below the plan's monthlyTokenQuota.
 *   b) Attaches plan.maxTokensPerRequest to req so aiService can pass it as
 *      max_tokens when calling each model — preventing any single call from
 *      consuming more than the plan allows.
 *
 * Must run AFTER requireAuth and BEFORE the controller.
 */
const enforceTokenQuota = asyncHandler(async (req, res, next) => {
  const plan = getPlan(req.user.plan);

  // Attach per-request token cap so aiService can use it
  req.maxTokensPerRequest = plan.maxTokensPerRequest;

  // Sum tokens consumed this calendar month
  const { rows } = await query(
    `SELECT COALESCE(SUM(tokens_input + tokens_output), 0)::bigint AS tokens_used
     FROM ai_requests
     WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
    [req.user.id]
  );
  const tokensUsed = Number(rows[0].tokens_used);

  // Attach for response payload
  req.monthlyTokensUsed      = tokensUsed;
  req.monthlyTokenQuota      = plan.monthlyTokenQuota;
  req.monthlyTokensRemaining = Math.max(0, plan.monthlyTokenQuota - tokensUsed);

  if (tokensUsed >= plan.monthlyTokenQuota) {
    throw new AppError(
      `You've used your full ${(plan.monthlyTokenQuota / 1_000).toFixed(0)}K token quota for this month on the ${plan.name} plan. ` +
      `Upgrade your plan or wait until next month.`,
      429
    );
  }

  next();
});

// ── 4. attachAvailableModels ─────────────────────────────────────────────
/**
 * Computes which of this plan's models still have quota left THIS MONTH,
 * using each model's own monthlyTokenQuota from config/plans.js (not the
 * plan-wide total — see the per-model quota comments there).
 *
 * Attaches req.availableModelKeys = ['gemini_flash', 'gpt4o', ...] — only
 * the keys that still have headroom. aiService.analyzeStock() should skip
 * calling any model NOT in this list, instead of calling it and either
 * eating a cost that's over that model's own budget, or relying on the
 * model's API to reject the call after the fact.
 *
 * If EVERY model on the plan is exhausted, the request is allowed through
 * with an empty availableModelKeys array — aiService is expected to throw
 * a clear "no models available" error in that case rather than silently
 * calling something anyway. (enforceTokenQuota above already blocks the
 * plan-wide worst case before this point, so reaching "all models exhausted"
 * here should be rare in practice — it mainly catches the case where a user
 * concentrates usage on one or two models within an otherwise-unused quota.)
 *
 * Must run AFTER requireAuth, and should run before the AI controller calls
 * analyzeStock(). Order relative to enforceTokenQuota/enforceAiQueryLimit
 * doesn't matter functionally, but running it last (closest to the
 * controller) keeps the cheaper plan-wide checks as the first line of defense.
 */
const attachAvailableModels = asyncHandler(async (req, res, next) => {
  const plan = getPlan(req.user.plan);
  const modelKeys = getModelKeys(req.user.plan); // e.g. ['gemini_flash','claude_sonnet','gpt4o','deepseek_v3']

  // Real per-model usage this month, keyed by model_key (added to ai_requests
  // specifically so this query doesn't have to string-match model_used).
  const { rows } = await query(
    `SELECT model_key, COALESCE(SUM(tokens_input + tokens_output), 0)::bigint AS tokens_used
     FROM ai_requests
     WHERE user_id = $1 AND created_at >= date_trunc('month', now()) AND model_key IS NOT NULL
     GROUP BY model_key`,
    [req.user.id]
  );
  const usedByModel = Object.fromEntries(rows.map(r => [r.model_key, Number(r.tokens_used)]));

  const availableModelKeys = modelKeys.filter(key => {
    const cfg = plan.aiModels[key];
    const used = usedByModel[key] || 0;
    return used < cfg.monthlyTokenQuota;
  });

  req.availableModelKeys = availableModelKeys;
  req.modelUsageThisMonth = usedByModel; // handy for logging/debugging

  next();
});

module.exports = { requireFeature, enforceAiQueryLimit, enforceTokenQuota, attachAvailableModels };

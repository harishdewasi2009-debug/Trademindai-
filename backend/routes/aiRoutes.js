// routes/aiRoutes.js
// ══════════════════════════════════════════════════════════════════════════
//  TradeMind AI Routes
//  POST /api/ai/analyze   — main stock analysis (all plans)
//  POST /api/ai/chat      — AI trading assistant chat (pro + elite)
//  GET  /api/ai/quota     — remaining queries this month
// ══════════════════════════════════════════════════════════════════════════

const express     = require('express');
const router      = express.Router();
const crypto      = require('crypto');
const { requireAuth }        = require('../middleware/authMiddleware');
const { enforceAiQueryLimit, requireFeature, enforceTokenQuota, attachAvailableModels } = require('../middleware/planCheck');
const { aiLimiter }          = require('../middleware/rateLimit');
const { validateAiAnalyze }  = require('../middleware/validate');
const { query }              = require('../db/pool');
const asyncHandler           = require('../utils/asyncHandler');
const AppError               = require('../utils/AppError');
const { analyzeStock }       = require('../services/aiService');

// ── GET /api/ai/quota — how many queries are left this month ─────────────
router.get('/quota', requireAuth, asyncHandler(async (req, res) => {
  const { getPlan, getModelConfig } = require('../config/plans');
  const plan = getPlan(req.user.plan);

  // Monthly token usage (plan-wide total, across all models)
  const { rows: tokenRows } = await query(
    `SELECT COALESCE(SUM(tokens_input + tokens_output), 0)::bigint AS tokens_used
     FROM ai_requests
     WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
    [req.user.id]
  );
  const tokensUsed = Number(tokenRows[0].tokens_used);

  // FIX: per-model usage breakdown — lets the frontend show "Claude Sonnet:
  // 42K / 150K used" instead of just one plan-wide number. Grouped by
  // model_key (the plans.js key) so it lines up directly with aiModels config.
  const { rows: perModelRows } = await query(
    `SELECT model_key,
            COALESCE(SUM(tokens_input + tokens_output), 0)::bigint AS tokens_used
     FROM ai_requests
     WHERE user_id = $1 AND created_at >= date_trunc('month', now()) AND model_key IS NOT NULL
     GROUP BY model_key`,
    [req.user.id]
  );
  const usedByModel = Object.fromEntries(perModelRows.map(r => [r.model_key, Number(r.tokens_used)]));

  const modelBreakdown = Object.entries(plan.aiModels).map(([modelKey, cfg]) => {
    const used = usedByModel[modelKey] || 0;
    return {
      modelKey,
      modelId:           cfg.modelId,
      maxOutputTokens:   cfg.maxOutputTokens,
      tokensLimit:       cfg.monthlyTokenQuota,
      tokensUsed:        used,
      tokensRemaining:   Math.max(0, cfg.monthlyTokenQuota - used),
    };
  });

  if (plan.monthlyAiQueries === -1) {
    return res.json({
      plan:                 plan.name,
      unlimited:            true,
      queriesUsed:          null,
      queriesRemaining:     null,
      queriesLimit:         null,
      tokensUsed,
      tokensLimit:          plan.monthlyTokenQuota,
      tokensRemaining:      Math.max(0, plan.monthlyTokenQuota - tokensUsed),
      maxTokensPerRequest:  plan.maxTokensPerRequest,
      modelBreakdown,
    });
  }

  // FIX: count DISTINCT request_id, not raw rows — see note in planCheck.js.
  const { rows: queryRows } = await query(
    `SELECT COUNT(DISTINCT request_id)::int AS count FROM ai_requests
     WHERE user_id = $1 AND created_at >= date_trunc('month', now())`,
    [req.user.id]
  );
  const queriesUsed = queryRows[0].count;

  res.json({
    plan:                plan.name,
    unlimited:           false,
    queriesUsed,
    queriesRemaining:    Math.max(0, plan.monthlyAiQueries - queriesUsed),
    queriesLimit:        plan.monthlyAiQueries,
    tokensUsed,
    tokensLimit:         plan.monthlyTokenQuota,
    tokensRemaining:     Math.max(0, plan.monthlyTokenQuota - tokensUsed),
    maxTokensPerRequest: plan.maxTokensPerRequest,
    modelBreakdown,
  });
}));

// ── POST /api/ai/analyze — main analysis endpoint ────────────────────────
router.post(
  '/analyze',
  requireAuth,
  aiLimiter,
  enforceTokenQuota,        // PRIMARY: checks monthly token budget, attaches maxTokensPerRequest
  enforceAiQueryLimit,      // SECONDARY: checks monthly request count cap
  attachAvailableModels,    // TERTIARY: skip individual models whose own sub-quota is exhausted
  validateAiAnalyze,
  asyncHandler(async (req, res) => {
    const { stockSymbol, horizon, riskTolerance, exchange } = req.body;
    const start = Date.now();

    let analysisResult;
    try {
      analysisResult = await analyzeStock({
        stockSymbol,
        horizon,
        riskTolerance,
        exchange, // 'NSE_EQ' | 'BSE_EQ' | undefined (undefined = try NSE then BSE, same as before)
        userPlan: req.user.plan,
        availableModelKeys: req.availableModelKeys, // models whose own monthly quota isn't exhausted
      });
    } catch (err) {
      console.error('[/api/ai/analyze] AI call failed:', err.message);
      // If every model on the plan is exhausted, give a clear, actionable
      // message instead of the generic "temporarily unavailable" one.
      if (err.message === 'NO_MODELS_AVAILABLE') {
        throw new AppError(
          `You've used up this month's quota on every AI model available on your plan. ` +
          `Upgrade your plan or wait until next month for your quota to reset.`,
          429
        );
      }
      // Data Unavailable errors (Upstox not connected, symbol not found, no
      // real candles) come through as AppError already — surface the real
      // message so the user knows to connect Upstox, not a vague retry note.
      if (err instanceof AppError) throw err;
      throw new AppError(
        'AI analysis is temporarily unavailable. Please try again in a moment.',
        503
      );
    }

    const latencyMs = Date.now() - start;
    const { result, modelUsed, tokensInput, tokensOutput, costUsd, modelBreakdown } = analysisResult;
    const requestId = crypto.randomUUID(); // groups this request's per-model rows together

    // ── Log to ai_requests — ONE ROW PER MODEL CALLED ─────────────────────
    // FIX: previously this wrote a single row with model_used as a joined
    // string like "gemini-2.5-flash+claude-sonnet-4-6+gpt-4o" and the
    // COMBINED tokens/cost across all models in one row. That made it
    // impossible to tell which model actually consumed how many tokens —
    // any per-model quota or cost analysis was just a guess. Now each model
    // in modelBreakdown gets its own row with its own real token/cost figures,
    // tagged with the same request_id so query-count limits still count this
    // as ONE request, not N (one per model called).
    try {
      for (const m of modelBreakdown) {
        await query(
          `INSERT INTO ai_requests
             (request_id, user_id, stock_symbol, request_type, model_used, model_key,
              tokens_input, tokens_output, cost_usd, latency_ms)
           VALUES ($1, $2, $3, 'quick_analysis', $4, $5, $6, $7, $8, $9)`,
          [requestId, req.user.id, stockSymbol.toUpperCase(), m.model, m.modelKey,
           m.tokIn, m.tokOut, m.cost, latencyMs]
        );
      }
    } catch (dbErr) {
      // Non-fatal — log but don't block the response
      console.error('[/api/ai/analyze] DB log failed:', dbErr.message);
    }

    // ── Log to api_usage (daily rollup per provider) ─────────────────────
    // Now uses REAL per-model tokens/cost from modelBreakdown instead of
    // splitting the combined total evenly across providers (the old
    // deriveProviders() approach was an approximation; this is exact).
    try {
      const byProvider = {};
      for (const m of modelBreakdown) {
        const provider = providerForModelKey(m.modelKey);
        if (!byProvider[provider]) byProvider[provider] = { tokens: 0, cost: 0 };
        byProvider[provider].tokens += m.tokIn + m.tokOut;
        byProvider[provider].cost   += m.cost;
      }
      for (const [provider, agg] of Object.entries(byProvider)) {
        await query(
          `INSERT INTO api_usage (user_id, provider, usage_date, request_count, tokens_total, cost_usd)
           VALUES ($1, $2, CURRENT_DATE, 1, $3, $4)
           ON CONFLICT (user_id, provider, usage_date)
           DO UPDATE SET
             request_count = api_usage.request_count + 1,
             tokens_total  = api_usage.tokens_total  + EXCLUDED.tokens_total,
             cost_usd      = api_usage.cost_usd      + EXCLUDED.cost_usd`,
          [req.user.id, provider, agg.tokens, agg.cost]
        );
      }
    } catch (dbErr) {
      console.error('[/api/ai/analyze] api_usage log failed:', dbErr.message);
    }

    // ── Log to prediction_history ─────────────────────────────────────────
    try {
      if (result.signal && result.currentPrice) {
        await query(
          `INSERT INTO prediction_history
             (user_id, stock_symbol, recommendation, entry_price,
              target_price, horizon_days, confidence_score, outcome)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
          [
            req.user.id,
            stockSymbol.toUpperCase(),
            result.signal.toLowerCase(),
            result.currentPrice,
            result.priceTargets?.oneMonth || null,
            horizon === '1 week' ? 7 : horizon === '3 months' ? 90 : 30,
            result.confidence,
          ]
        );
      }
    } catch (dbErr) {
      console.error('[/api/ai/analyze] prediction_history log failed:', dbErr.message);
    }

    // ── Return result — internal fields already excluded by aiService ─────
    res.json({
      ...result,
      stockSymbol:               stockSymbol.toUpperCase(),
      analysedAt:                new Date().toISOString(),
      latencyMs,
      queriesRemainingThisMonth: req.aiQuotaRemaining,
      tokenQuota: {
        used:      req.monthlyTokensUsed,
        limit:     req.monthlyTokenQuota,
        remaining: req.monthlyTokensRemaining,
      },
    });
  })
);

// ── POST /api/ai/chat — AI trading assistant (Pro + Elite only) ───────────
router.post(
  '/chat',
  requireAuth,
  requireFeature('ai_chat'),
  aiLimiter,
  asyncHandler(async (req, res) => {
    const { message } = req.body;
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      throw new AppError('message is required.', 400);
    }
    if (message.length > 500) {
      throw new AppError('message must be 500 characters or less.', 400);
    }

    // Pick model based on plan: Pro → Claude Sonnet 4, Elite → Claude Opus 4
    const { MODELS } = require('../services/aiService');
    const isElite = req.user.plan === 'elite';
    const model   = isElite ? MODELS.CLAUDE_OPUS : MODELS.CLAUDE_SONNET;
    const apiKey  = process.env.CLAUDE_API_KEY;

    if (!apiKey) throw new AppError('AI chat is not configured on this server.', 501);

    const system = `You are TradeMind AI, a knowledgeable Indian stock market assistant.
Give concise, practical answers. Always add a brief disclaimer when giving specific investment opinions.
Today's date: ${new Date().toDateString()}. Focus on NSE/BSE markets.`;

    let reply;
    try {
      const res2 = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 512,
          system,
          messages: [{ role: 'user', content: message.trim() }],
          temperature: 0.4,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res2.ok) throw new Error(`Claude chat ${res2.status}`);
      const data = await res2.json();
      reply = data.content?.[0]?.text || 'Sorry, I could not generate a response.';

      // Log chat usage
      await query(
        `INSERT INTO ai_requests
           (user_id, stock_symbol, request_type, model_used,
            tokens_input, tokens_output, cost_usd, latency_ms)
         VALUES ($1, NULL, 'chat', $2, $3, $4, 0, 0)`,
        [req.user.id, model, data.usage?.input_tokens || 0, data.usage?.output_tokens || 0]
      );
    } catch (err) {
      console.error('[/api/ai/chat] failed:', err.message);
      throw new AppError('AI chat is temporarily unavailable.', 503);
    }

    res.json({ reply, model: isElite ? 'Claude Opus 4.7' : 'Claude Sonnet 4.6' });
  })
);

// ── POST /api/ai/insight — real-data-grounded AI commentary ──────────────
// Powers: Trade Idea Generator, Portfolio Health Check, Morning Market
// Brief, Option Strategy Advisor, Backtest Advisor, Multi-Timeframe view.
// Unlike /analyze, this doesn't produce a new Buy/Sell/Hold signal — it
// only explains/synthesizes REAL data the frontend already fetched from
// Upstox and passes in as `context`. Kept to one shared endpoint since all
// 6 features are the same shape: real data in, AI commentary out.
const VALID_INSIGHT_KINDS = ['tradeIdeas', 'portfolioHealth', 'marketBrief', 'optionStrategy', 'backtestAdvisor', 'multiTimeframe'];
router.post(
  '/insight',
  requireAuth,
  requireFeature('ai_chat'), // reuse the existing chat-tier gate — same cost class as chat
  aiLimiter,
  asyncHandler(async (req, res) => {
    const { kind, context } = req.body || {};
    if (!VALID_INSIGHT_KINDS.includes(kind)) {
      throw new AppError(`kind must be one of: ${VALID_INSIGHT_KINDS.join(', ')}`, 400);
    }
    if (!context || typeof context !== 'object') {
      throw new AppError('context object is required.', 400);
    }

    const { getAIInsight } = require('../services/aiService');
    let text;
    try {
      text = await getAIInsight(kind, context);
    } catch (err) {
      console.error(`[/api/ai/insight:${kind}] failed:`, err.message);
      throw new AppError('AI insight is temporarily unavailable.', 503);
    }

    await query(
      `INSERT INTO ai_requests
         (user_id, stock_symbol, request_type, model_used,
          tokens_input, tokens_output, cost_usd, latency_ms)
       VALUES ($1, NULL, $2, $3, 0, 0, 0, 0)`,
      [req.user.id, `insight_${kind}`, 'gemini-2.5-flash']
    );

    res.json({ kind, text });
  })
);

// ── Helpers ───────────────────────────────────────────────────────────────

/** Exact modelKey → provider mapping (replaces the old string-matching
 *  deriveProviders() approach now that we log per-model, not per-request). */
const MODEL_KEY_PROVIDERS = {
  gemini_flash:  'gemini',
  gemini_pro:    'gemini',
  claude_sonnet: 'claude',
  claude_opus4:  'claude',
  gpt4o:         'openai',
  gpt4o_high:    'openai',
  deepseek_v3:   'deepseek',
  deepseek_r1:   'deepseek',
};
function providerForModelKey(modelKey) {
  return MODEL_KEY_PROVIDERS[modelKey] || 'unknown';
}

module.exports = router;

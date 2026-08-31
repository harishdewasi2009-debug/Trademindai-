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
    const { stockSymbol, horizon, riskTolerance, timeframe, exchange } = req.body;
    const start = Date.now();

    let analysisResult;
    try {
      analysisResult = await analyzeStock({
        stockSymbol,
        horizon,
        riskTolerance,
        timeframe, // FIX: the Analysis page's "Analysis timeframe" dropdown (1 Minute..5 Year)
        // was being collected and sent by the frontend but silently dropped here —
        // every analysis was always computed on daily candles regardless of what
        // the user picked. See aiService.js fetchRealMarketContext().
        exchange, // 'NSE_EQ' | 'BSE_EQ' | undefined (undefined = try NSE then BSE, same as before)
        userPlan: req.user.plan,
        availableModelKeys: req.availableModelKeys, // models whose own monthly quota isn't exhausted
      });
    } catch (err) {
      console.error('[/api/ai/analyze] AI call failed:', err);
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
    // COMPLIANCE: this now records the descriptive "sentiment" reading
    // (e.g. "moderate_bullish") rather than a buy/sell/hold recommendation,
    // and does not store a target_price — this app doesn't predict future
    // prices. `recommendation`/`target_price` columns are kept for schema
    // compatibility but populated with the non-advisory equivalents.
    try {
      if (result.sentiment && result.currentPrice) {
        await query(
          `INSERT INTO prediction_history
             (user_id, stock_symbol, recommendation, entry_price,
              target_price, horizon_days, confidence_score, outcome)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
          [
            req.user.id,
            stockSymbol.toUpperCase(),
            result.sentiment,       // descriptive reading, e.g. "moderate_bullish" — not an instruction
            result.currentPrice,
            null,                   // no price prediction stored — see compliance note above
            // Matches every horizon value the frontend can actually send
            // (getAnalysisHorizonRisk() in index.html) — previously only
            // '1 week'/'3 months' were handled and everything else silently
            // fell back to 30, even a 6-12 month "long" horizon pick.
            { '1 week': 7, '1 month': 30, '3 months': 90 }[horizon] || 30,
            result.technicalScore,
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
    const plan = req.user.plan;

    // FIX (item: "AI Assistant should use the DeepSeek model according to
    // plan"): this used to ONLY ever try DeepSeek then fall back straight to
    // Claude — Gemini was never used for chat at all, and the order didn't
    // reflect what each plan actually pays for (e.g. Pro pays for Claude
    // Sonnet as its main model, with DeepSeek as a secondary option — the
    // old code had DeepSeek ahead of Claude on every plan). Now reuses the
    // exact same insightCascadeForPlan() cascade that /api/ai/insight
    // already uses (config/plans.js is the single source of truth for
    // which models each plan gets and in what order), just with the
    // chat-specific system prompt below instead of the insight one.
    const { MODELS, insightCascadeForPlan, callGeminiPlain, callClaudePlain, callDeepSeekPlain } = require('../services/aiService');

    // COMPLIANCE: TradeMind is not a SEBI-registered Investment Adviser or
    // Research Analyst. SEBI's regulations cover "trading calls" and
    // stop-loss/price-target guidance regardless of whether a human or an
    // AI produces them, so this assistant must never answer with a
    // buy/sell/hold instruction, a price target, or a specific entry/exit
    // level — even if the user directly asks for one. It can explain
    // concepts, describe what indicators show, and point the user to their
    // own research, but the decision must stay with the user.
    const system = `You are TradeMind AI, a knowledgeable Indian stock market data assistant. You are NOT a SEBI-registered Investment Adviser or Research Analyst, and you must never act like one.
Give concise, practical, educational answers about markets, indicators, and concepts.
If the user asks whether to buy, sell, or hold a specific stock, asks for a price target, entry point, or stop-loss level, or otherwise asks you to make a trading decision for them: do NOT provide one. Instead, explain what relevant data/indicators they could look at and encourage them to consult a SEBI-registered adviser for personalized recommendations. Never use the words "buy", "sell", or "hold" as an instruction, and never state or imply a future price.
Today's date: ${new Date().toDateString()}. Focus on NSE/BSE markets.`;

    const CHAT_CALLERS = { callGeminiPlain, callClaudePlain, callDeepSeekPlain };
    const cascade = insightCascadeForPlan(plan);

    let reply, modelUsed, modelLabel, lastErr;
    for (const step of cascade) {
      // Match each cascade entry's function reference back to a name so we
      // can (a) call the exported version of it and (b) skip cleanly when
      // that provider's API key isn't configured on this server.
      const fnName = step.fn.name; // 'callGeminiPlain' | 'callClaudePlain' | 'callDeepSeekPlain'
      const caller = CHAT_CALLERS[fnName];
      const keyPresent =
        (fnName === 'callGeminiPlain'   && !!process.env.GEMINI_API_KEY) ||
        (fnName === 'callClaudePlain'   && !!process.env.CLAUDE_API_KEY) ||
        (fnName === 'callDeepSeekPlain' && !!process.env.DEEPSEEK_API_KEY);
      if (!caller || !keyPresent) continue;

      try {
        const { text, model } = await caller(step.model, message.trim(), system);
        reply = text;
        modelUsed = model || step.model;
        modelLabel =
          fnName === 'callGeminiPlain'   ? (step.model === MODELS.GEMINI_PRO ? 'Gemini Pro' : 'Gemini Flash') :
          fnName === 'callClaudePlain'   ? (step.model === MODELS.CLAUDE_OPUS ? 'Claude Opus 4.7' : 'Claude Sonnet 4.6') :
          (step.model === MODELS.DEEPSEEK_R1 ? 'DeepSeek R1' : 'DeepSeek V3');

        await query(
          `INSERT INTO ai_requests
             (user_id, stock_symbol, request_type, model_used, model_key,
              tokens_input, tokens_output, cost_usd, latency_ms)
           VALUES ($1, NULL, 'chat', $2, $3, 0, 0, 0, 0)`,
          [req.user.id, modelUsed, fnName === 'callGeminiPlain' ? (plan === 'elite' ? 'gemini_pro' : 'gemini_flash')
                                  : fnName === 'callClaudePlain' ? (plan === 'elite' ? 'claude_opus4' : 'claude_sonnet')
                                  : (plan === 'elite' ? 'deepseek_r1' : 'deepseek_v3')]
        );
        break;
      } catch (err) {
        lastErr = err;
        console.warn(`[/api/ai/chat] ${fnName} (${step.model}) failed, trying next in cascade:`, err.message);
      }
    }

    if (reply === undefined) {
      console.error('[/api/ai/chat] All models in cascade failed:', lastErr?.message);
      throw new AppError('AI chat is temporarily unavailable.', 503);
    }

    res.json({ reply, model: modelLabel });
  })
);

// ── POST /api/ai/insight — real-data-grounded AI commentary ──────────────
// Powers: Trade Idea Generator, Portfolio Health Check, Morning Market
// Brief, Option Strategy Advisor, Backtest Advisor, Multi-Timeframe view
// (the latter is also what "Deep Research" runs as its second half).
// Unlike /analyze, this doesn't produce a new Buy/Sell/Hold signal — it
// only explains/synthesizes REAL data the frontend already fetched from
// Upstox and passes in as `context`. Kept to one shared endpoint since all
// 6 features are the same shape: real data in, AI commentary out.
//
// FIX: this used to require the 'ai_chat' feature (Pro+Elite only), but the
// Deep Research tab is shown to EVERY plan in the frontend, and
// insightCascadeForPlan() in aiService.js already has a real DeepSeek V3 +
// Gemini Flash cascade written specifically for the Basic plan — it could
// simply never run, so Basic users got a half-empty Deep Research report
// every time (the daily-vs-weekly section silently failed). Now gated on
// 'ai_insight' (Basic/Pro/Elite — see config/plans.js), so Basic users
// actually get the cascade that was already built for them. Free stays
// excluded, consistent with prediction_history and other Basic+ features.
const VALID_INSIGHT_KINDS = ['tradeIdeas', 'portfolioHealth', 'marketBrief', 'optionStrategy', 'backtestAdvisor', 'multiTimeframe'];

// FIX (root cause of "AI model selection has no effect anywhere except
// Stock Analysis"): the "Select AI models" chip strips send the chip's
// data-model attribute (a display-facing model id like "claude-sonnet-4.6"
// or "gpt-4o") as `model` in the request body. This route used to destructure
// only { kind, context } and drop that field entirely, so every insight
// call — Trade Ideas, Portfolio Health, Market Brief, Option Strategy,
// Backtest Advisor, Multi-Timeframe — always ran whatever the plan's
// default cascade picked, no matter which model(s) the user actually
// ticked. This map translates each chip's data-model value to the
// plans.js aiModels key aiService.getAIInsight() now accepts, so a
// specific selection is actually honored (and rejected with a clear 403
// if the user's plan doesn't include that model, instead of silently
// swapping in a different one).
const CHIP_MODEL_TO_KEY = {
  'gemini-2.5-flash':  'gemini_flash',
  'gemini-2.5-pro':    'gemini_pro',
  'claude-sonnet-4.6': 'claude_sonnet',
  'claude-opus-4.7':   'claude_opus4',
  'gpt-4o':            'gpt4o',
  'deepseek-v3':       'deepseek_v3',
  'deepseek-r1':       'deepseek_r1',
};

router.post(
  '/insight',
  requireAuth,
  requireFeature('ai_insight'),
  aiLimiter,
  asyncHandler(async (req, res) => {
    const { kind, context, model } = req.body || {};
    if (!VALID_INSIGHT_KINDS.includes(kind)) {
      throw new AppError(`kind must be one of: ${VALID_INSIGHT_KINDS.join(', ')}`, 400);
    }
    if (!context || typeof context !== 'object') {
      throw new AppError('context object is required.', 400);
    }

    let modelKey = model ? (CHIP_MODEL_TO_KEY[model] || null) : null;
    // Elite gets the higher-token-cap GPT-4o slot ('gpt4o_high') rather than
    // Pro's 'gpt4o' — same chip, same underlying model, different plan quota.
    if (modelKey === 'gpt4o' && req.user.plan === 'elite') modelKey = 'gpt4o_high';

    const { getAIInsight } = require('../services/aiService');
    let text, modelUsed;
    try {
      const result = await getAIInsight(kind, context, req.user.plan, modelKey);
      text = result.text;
      modelUsed = result.modelUsed;
    } catch (err) {
      if (err instanceof AppError) throw err;
      console.error(`[/api/ai/insight:${kind}] failed:`, err.message);
      throw new AppError('AI insight is temporarily unavailable.', 503);
    }

    await query(
      `INSERT INTO ai_requests
         (user_id, stock_symbol, request_type, model_used, model_key,
          tokens_input, tokens_output, cost_usd, latency_ms)
       VALUES ($1, NULL, $2, $3, $4, 0, 0, 0, 0)`,
      [req.user.id, `insight_${kind}`, modelUsed, modelKey]
    );

    res.json({ kind, text, model: modelUsed });
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

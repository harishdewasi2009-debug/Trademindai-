// config/plans.js
// ══════════════════════════════════════════════════════════════════════════
//  Single source of truth for plan pricing, AI query limits, token quotas,
//  per-request token caps, and feature gates.
//
//   Free  ₹0     — Gemini Flash only
//                  50,000 tokens/month | 1,500 tokens/request | ~10–15 analyses
//   Basic ₹149   — Gemini Flash + DeepSeek
//                  250,000 tokens/month | 2,000 tokens/request | ~150 analyses
//   Pro   ₹999   — Gemini + DeepSeek + Claude Sonnet (limited) + GPT (limited)
//                  1,000,000 tokens/month | 5,000 tokens/request | ~300–400 analyses
//   Elite ₹2999  — GPT premium + Claude premium + Gemini advanced + DeepSeek Pro
//                  3,000,000 tokens/month | 10,000 tokens/request | unlimited queries
//
//  UPDATED: Basic lowered 300k → 250k. Pro raised 800k → 1,000,000 (×1.25
//  per-model rescale). Elite raised 1,200,000 → 3,000,000 (×2.5 per-model
//  rescale). See per-plan comments below for the new worst-case cost math.
// ══════════════════════════════════════════════════════════════════════════

const PLANS = {
  free: {
    name: 'Free',
    amountInPaise: 0,

    // Token limits
    monthlyTokenQuota:   50_000,      // 50,000 tokens/month
    maxTokensPerRequest: 1_500,       // 1,500 tokens max per single request
    monthlyAiQueries:    15,          // ~10–15 analyses/month (hard cap as backup)

    // ── Per-model configuration ──────────────────────────────────────────
    // Models on this plan: Gemini Flash (only).
    // maxOutputTokens — passed as max_tokens to this model's API call.
    // monthlyTokenQuota — this model's own slice of the plan's total quota.
    //   (Sum of all models' monthlyTokenQuota below should not exceed the
    //   plan-level monthlyTokenQuota above; Free has one model so it's 1:1.)
    aiModels: {
      gemini_flash: {
        modelId:           'gemini-2.5-flash',
        maxOutputTokens:   1_500,
        monthlyTokenQuota: 50_000,        // ~₹1 worst-case AI cost/mo
      },
    },
    features: [
      'news_sentiment',
      'watchlist_5',
    ],
  },

  basic: {
    name: 'Basic',
    amountInPaise: 14900,             // ₹149

    // Token limits
    monthlyTokenQuota:   250_000,     // 250,000 tokens/month
    maxTokensPerRequest: 2_000,       // 2,000 tokens max per single request
    monthlyAiQueries:    150,         // ~150 analyses/month

    // Basic calls Gemini Flash first, falls back to DeepSeek only on failure
    // (not parallel) — so each model gets the FULL plan quota as its own
    // ceiling, since only one of them actually runs per request.
    // Models on this plan: Gemini Flash (primary), DeepSeek V3 (fallback).
    // Worst case is whichever single model actually runs maxing the
    // 250,000-token quota — DeepSeek is the pricier of the two, so ~₹16
    // worst-case/mo (Gemini-only worst case would be ~₹4).
    aiModels: {
      gemini_flash: {
        modelId:           'gemini-2.5-flash',
        maxOutputTokens:   2_000,
        monthlyTokenQuota: 250_000,        // ~₹4 worst-case AI cost/mo
      },
      deepseek_v3: {
        modelId:           'deepseek-chat',
        maxOutputTokens:   2_000,
        monthlyTokenQuota: 250_000,        // ~₹16 worst-case AI cost/mo
      },
    },
    features: [
      'news_sentiment',
      'prediction_history',
      'earnings_calendar',
      'watchlist_10',
    ],
  },

  pro: {
    name: 'Pro',
    amountInPaise: 99900,             // ₹999

    // Token limits
    // UPDATED: quota raised from 800,000 → 1,000,000 (×1.25). Per-model splits
    // below are scaled by the same 1.25 factor to preserve the original
    // cost-weighted ratios (expensive models — Sonnet, GPT-4o — still get
    // smaller individual ceilings than Gemini/DeepSeek). Combined worst-case
    // (every model maxing its own quota the same month) scales from ~₹289
    // to ~₹361 — still comfortably under the ₹999 price.
    monthlyTokenQuota:   1_000_000,   // 1,000,000 tokens/month
    maxTokensPerRequest: 5_000,       // 5,000 tokens max per single request
    monthlyAiQueries:    400,         // ~300–400 analyses/month

    // Pro calls Gemini Flash + Claude Sonnet + GPT-4o IN PARALLEL on every
    // request (see aiService.js), with DeepSeek as a fallback if all three
    // fail. Per-model quotas are split unevenly — Claude Sonnet and GPT-4o
    // (the two expensive models) get smaller individual ceilings than
    // Gemini/DeepSeek.
    // Models on this plan: Gemini Flash, Claude Sonnet, GPT-4o (DeepSeek V3
    // fallback only). Combined worst-case ~₹361/mo (Sonnet ~₹160 + GPT-4o
    // ~₹179 + Gemini ~₹6 + DeepSeek ~₹16) against the ₹999 price.
    aiModels: {
      gemini_flash: {
        modelId:           'gemini-2.5-flash',
        maxOutputTokens:   5_000,
        monthlyTokenQuota: 375_000,        // ~₹6 worst-case AI cost/mo
      },
      claude_sonnet: {
        modelId:           'claude-sonnet-4-6',
        maxOutputTokens:   5_000,
        monthlyTokenQuota: 187_500,        // ~₹160 worst-case AI cost/mo
      },
      gpt4o: {
        modelId:           'gpt-4o',
        maxOutputTokens:   5_000,
        monthlyTokenQuota: 187_500,        // ~₹179 worst-case AI cost/mo
      },
      deepseek_v3: {
        modelId:           'deepseek-chat',
        maxOutputTokens:   5_000,
        monthlyTokenQuota: 250_000,        // ~₹16 worst-case AI cost/mo
      },
    },
    features: [
      // NOTE: 'news_sentiment', 'telegram_alerts', 'whatsapp_alerts' are NOT
      // implemented in this backend yet (no route/service exists — see
      // backend/README.md and frontend "Coming Soon" badges). They're kept
      // here as planned features so requireFeature() checks won't break once
      // they ARE built, but nothing currently gates on them. Don't wire a
      // route to these without first building the actual integration.
      'news_sentiment',
      'prediction_history',
      'earnings_calendar',
      'price_targets',
      'portfolio_tracker',
      'screener',
      'ipo_analyzer',
      'telegram_alerts',
      'whatsapp_alerts',
      'watchlist_50',
      'ai_chat',
      'referral',
    ],
  },

  elite: {
    name: 'Elite',
    amountInPaise: 299900,            // ₹2,999

    // Token limits
    // UPDATED: quota raised from 1,200,000 → 3,000,000 (×2.5). Per-model
    // splits below are scaled by the same 2.5 factor to preserve the
    // original cost-weighted ratios (Claude Opus, the priciest model, still
    // gets the smallest individual slice). Combined worst-case (every model
    // maxing its own quota the same month) scales from ~₹758 to ~₹1,895 —
    // still under the ₹2,999 price, but with a noticeably thinner margin
    // than before, so keep an eye on real usage after rollout.
    monthlyTokenQuota:   3_000_000,   // 3,000,000 tokens/month
    maxTokensPerRequest: 10_000,      // 10,000 tokens max per single request
    monthlyAiQueries:    -1,          // unlimited requests (token quota is the real gate)

    // Elite calls ALL FOUR flagship models IN PARALLEL on every request
    // (see aiService.js consensus + debate logic). Claude Opus is by far
    // the most expensive model in the lineup, so it gets the smallest
    // individual quota; Gemini Pro, GPT-4o (high), and DeepSeek R1 get
    // proportionally more room since they're cheaper per token.
    // Models on this plan: Gemini Pro, Claude Opus 4, GPT-4o (high),
    // DeepSeek R1 — all four called on every request.
    // Combined worst-case ~₹1,895/mo against the ₹2,999 price. Only Opus's
    // share is independently verifiable from a known per-token rate
    // (~₹267 at its 375,000-token quota); Gemini Pro / GPT-4o-high /
    // DeepSeek R1 don't have documented per-token rates in this codebase,
    // so their individual shares of the ~₹1,895 total are estimates, not
    // a precise breakdown.
    aiModels: {
      gemini_pro: {
        modelId:           'gemini-2.5-pro',
        maxOutputTokens:   10_000,
        monthlyTokenQuota: 1_000_000,
      },
      claude_opus4: {
        modelId:           'claude-opus-4-7',
        maxOutputTokens:   10_000,
        monthlyTokenQuota: 375_000,        // ~₹267 worst-case AI cost/mo
      },
      gpt4o_high: {
        modelId:           'gpt-4o',
        maxOutputTokens:   10_000,
        monthlyTokenQuota: 750_000,
      },
      deepseek_r1: {
        modelId:           'deepseek-reasoner',
        maxOutputTokens:   10_000,
        monthlyTokenQuota: 875_000,
      },
    },
    features: [
      'news_sentiment',
      'prediction_history',
      'earnings_calendar',
      'price_targets',
      'portfolio_tracker',
      'screener',
      'ipo_analyzer',
      'telegram_alerts',
      'whatsapp_alerts',
      'watchlist_unlimited',
      'ai_chat',
      'referral',
      'consensus_analysis',
      'backtesting',
      'options_analysis',
      'fii_dii_tracker',
      'pdf_reports',
      'portfolio_advisor',
      'api_access',
      '2fa',
    ],
  },
};

function getPlan(planName) {
  return PLANS[(planName || 'free').toLowerCase()] || PLANS.free;
}

function planHasFeature(planName, feature) {
  return getPlan(planName).features.includes(feature);
}

/** Returns the per-model config object (modelId, maxOutputTokens, monthlyTokenQuota)
 *  for a given plan + model key, e.g. getModelConfig('pro', 'claude_sonnet'). */
function getModelConfig(planName, modelKey) {
  return getPlan(planName).aiModels[modelKey] || null;
}

/** Returns the list of model keys available on a plan, e.g. ['gemini_flash','claude_sonnet',...] */
function getModelKeys(planName) {
  return Object.keys(getPlan(planName).aiModels);
}

module.exports = { PLANS, getPlan, planHasFeature, getModelConfig, getModelKeys };

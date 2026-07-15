// config/plans.js
// ══════════════════════════════════════════════════════════════════════════
//  Single source of truth for plan pricing, AI query limits, token quotas,
//  per-request token caps, and feature gates.
//
//   Free  ₹0     — Gemini Flash only
//                  50,000 tokens/month | 1,500 tokens/request | 7 analyses/mo
//   Basic ₹149   — Gemini Flash + DeepSeek
//                  250,000 tokens/month | 2,000 tokens/request | 49 analyses/mo
//   Pro   ₹999   — Gemini + DeepSeek + Claude Sonnet (limited) + GPT (limited)
//                  1,000,000 tokens/month | 5,000 tokens/request | 499 analyses/mo
//   Elite ₹3199  — GPT premium + Claude premium + Gemini advanced + DeepSeek Pro
//                  2,015,000 tokens/month | 10,000 tokens/request | 1499 analyses/mo
//
//  UPDATED: Basic lowered 300k → 250k. Pro raised 800k → 1,000,000 (×1.25
//  per-model rescale). Elite raised 1,200,000 → 3,000,000 (×2.5 per-model
//  rescale). See per-plan comments below for the new worst-case cost math.
//  Monthly analysis caps set to Free 7 / Basic 49 / Pro 499 / Elite 1499.
// ══════════════════════════════════════════════════════════════════════════

const PLANS = {
  free: {
    name: 'Free',
    amountInPaise: 0,

    // Token limits
    monthlyTokenQuota:   50_000,      // 50,000 tokens/month
    maxTokensPerRequest: 1_500,       // 1,500 tokens max per single request
    monthlyAiQueries:    7,           // 7 analyses/month (hard cap as backup)

    // ── Per-model configuration ──────────────────────────────────────────
    // Models on this plan: Gemini Flash (only).
    // maxOutputTokens — passed as max_tokens to this model's API call.
    // monthlyTokenQuota — this model's own slice of the plan's total quota.
    //   (Sum of all models' monthlyTokenQuota below should not exceed the
    //   plan-level monthlyTokenQuota above; Free has one model so it's 1:1.)
    aiModels: {
      gemini_flash: {
        modelId:           'gemini-2.5-flash',
        maxOutputTokens:   2_500,
        monthlyTokenQuota: 50_000,        // ~₹1 worst-case AI cost/mo
      },
    },
    features: [
      'watchlist_5',
      // 'screener' removed — AI Stock Screener is now Basic/Pro/Elite only.
      // AI Brief (AI Morning Market Brief) is available on every plan,
      // including Free — insightCascadeForPlan()'s default/free case
      // already routes this to Gemini Flash only, so this just unlocks
      // the feature gate without changing the free-tier model cascade.
      'ai_insight',
    ],
  },

  basic: {
    name: 'Basic',
    amountInPaise: 14900,             // ₹149

    // Token limits
    monthlyTokenQuota:   250_000,     // 250,000 tokens/month
    maxTokensPerRequest: 2_000,       // 2,000 tokens max per single request
    monthlyAiQueries:    49,          // 49 analyses/month

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
      'prediction_history',
      'watchlist_10',
      'screener',
      // FIX: Basic already has a real DeepSeek V3 + Gemini Flash cascade
      // built for it in aiService.js's insightCascadeForPlan() — this was
      // just never reachable because /api/ai/insight required 'ai_chat'
      // (Pro+Elite only). Adding this unlocks Deep Research's daily-vs-
      // weekly section and the other insight-powered features for Basic.
      'ai_insight',
    ],
  },

  pro: {
    name: 'Pro',
    amountInPaise: 99900,             // ₹999

    // Token limits
    // UPDATED: quota raised from 800,000 → 1,000,000 (×1.25). Per-model splits
    // below are scaled by the same 1.25 factor to preserve the original
    // cost-weighted ratios (expensive models — Sonnet, ChatGPT — still get
    // smaller individual ceilings than Gemini/DeepSeek). Combined worst-case
    // (every model maxing its own quota the same month) scales from ~₹289
    // to ~₹361 — still comfortably under the ₹999 price.
    monthlyTokenQuota:   1_000_000,   // 1,000,000 tokens/month
    maxTokensPerRequest: 5_000,       // 5,000 tokens max per single request
    monthlyAiQueries:    499,         // 499 analyses/month

    // Pro calls Gemini Flash + Claude Sonnet + ChatGPT IN PARALLEL on every
    // request (see aiService.js), with DeepSeek as a fallback if all three
    // fail. Per-model quotas are split unevenly — Claude Sonnet and ChatGPT
    // (the two expensive models) get smaller individual ceilings than
    // Gemini/DeepSeek.
    // Models on this plan: Gemini Flash, Claude Sonnet, ChatGPT (DeepSeek V3
    // fallback only). Combined worst-case ~₹361/mo (Sonnet ~₹160 + ChatGPT
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
      // NOTE: 'telegram_alerts', 'whatsapp_alerts' are NOT implemented in
      // this backend yet (no route/service exists — see backend/README.md
      // and frontend "Coming Soon" badges). They're kept here as planned
      // features so requireFeature() checks won't break once they ARE
      // built, but nothing currently gates on them. Don't wire a route to
      // these without first building the actual integration.
      'prediction_history',
      'technical_score',
      'portfolio_tracker',
      'screener',
      'telegram_alerts',
      'whatsapp_alerts',
      'watchlist_50',
      'ai_chat',
      'ai_insight',
      'referral',
    ],
  },

  elite: {
    name: 'Elite',
    amountInPaise: 319900,            // ₹3,199 (raised from ₹2,999 — see quota note below)

    // Token limits
    // UPDATED (margin fix): price raised ₹2,999 → ₹3,199 and per-model quotas
    // cut ~32% from the previous 3,000,000-token total. At the old
    // 3,000,000-token quota, a heavy user maxing every model with a mostly-
    // output token mix could cost ~₹4,909/mo in real AI spend — a ₹1,910
    // LOSS against the ₹2,999 price. These new quotas total 2,015,000
    // tokens/month:
    //   - Typical usage (70% input / 30% output): ~₹1,481 AI cost/mo →
    //     ~₹1,718 margin (comfortably past the ₹1,500 target).
    //   - Worst case (every model maxed, 100% output tokens): ~₹3,282
    //     AI cost/mo → only a ~₹83 loss, down from ~₹1,910 — nearly
    //     eliminates the tail-risk loss instead of just improving the
    //     average case.
    monthlyTokenQuota:   2_015_000,   // 2,015,000 tokens/month
    maxTokensPerRequest: 10_000,      // 10,000 tokens max per single request
    monthlyAiQueries:    1499,        // 1499 analyses/month

    // Elite calls ALL FOUR flagship models IN PARALLEL on every request
    // (see aiService.js consensus + debate logic). Claude Opus is by far
    // the most expensive model in the lineup, so it gets the smallest
    // individual quota; Gemini Pro, ChatGPT (high), and DeepSeek R1 get
    // proportionally more room since they're cheaper per token.
    // Models on this plan: Gemini Pro, Claude Opus 4, ChatGPT (high),
    // DeepSeek R1 — all four called on every request.
    // Per-model worst-case (100% output) / realistic (70% input, 30% output)
    // AI cost, computed from the real COST_PER_1K rates in aiService.js:
    //   gemini_pro:   ~₹646 worst / ~₹250 realistic
    //   claude_opus4: ~₹1,794 worst / ~₹790 realistic
    //   gpt4o_high:   ~₹718 worst / ~₹383 realistic
    //   deepseek_r1:  ~₹124 worst / ~₹59 realistic
    // Combined: ~₹3,282 worst-case / ~₹1,481 realistic against the ₹3,199 price.
    aiModels: {
      gemini_pro: {
        modelId:           'gemini-2.5-pro',
        maxOutputTokens:   10_000,
        monthlyTokenQuota: 675_000,        // ~₹646 worst-case / ~₹250 realistic AI cost/mo
      },
      claude_opus4: {
        modelId:           'claude-opus-4-7',
        maxOutputTokens:   10_000,
        monthlyTokenQuota: 250_000,        // ~₹1,794 worst-case / ~₹790 realistic AI cost/mo
      },
      gpt4o_high: {
        modelId:           'gpt-4o',
        maxOutputTokens:   10_000,
        monthlyTokenQuota: 500_000,        // ~₹718 worst-case / ~₹383 realistic AI cost/mo
      },
      deepseek_r1: {
        modelId:           'deepseek-reasoner',
        maxOutputTokens:   10_000,
        monthlyTokenQuota: 590_000,        // ~₹124 worst-case / ~₹59 realistic AI cost/mo
      },
    },
    features: [
      'prediction_history',
      'technical_score',
      'portfolio_tracker',
      'screener',
      'telegram_alerts',
      'whatsapp_alerts',
      'watchlist_unlimited',
      'ai_chat',
      'ai_insight',
      'referral',
      'consensus_analysis',
      'backtesting',
      'options_analysis',
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

// config/plans.js
// ══════════════════════════════════════════════════════════════════════════
//  Single source of truth for plan pricing, AI query limits, token quotas,
//  per-request token caps, and feature gates.
//
//   Free  ₹0    — Gemini 2.5 Flash only
//                 50,000 tokens/month | 1,500 tokens/request | 7 analyses/mo
//   Pro   ₹499  — Gemini 2.5 Flash only
//                 250,000 tokens/month | 3,000 tokens/request | 166 analyses/mo
//   Elite ₹999  — Gemini 2.5 Pro only
//                 250,000 tokens/month | 4,000 tokens/request | 125 analyses/mo
//
//  REDESIGN (simplified 3-tier structure — replaces the old 4-tier
//  Free/Basic/Pro/Elite structure): the old multi-model parallel-cascade
//  system (Gemini + Claude + GPT + DeepSeek running together on Pro/Elite)
//  has been removed. It was complex, expensive, and its "AI Model Debate"
//  consensus output confused more than it helped. Basic (₹149) has been
//  removed entirely — Pro is now the paid entry tier at ₹499. Pro and Elite
//  now each run exactly ONE model per request:
//    Pro   → Gemini 2.5 Flash (fast, cheap, great for high-frequency use)
//    Elite → Gemini 2.5 Pro   (deeper reasoning, same 250k token ceiling)
//  Both paid tiers share the same 250,000 token/month ceiling; Elite's
//  higher price reflects Gemini Pro's higher per-token cost, plus Elite's
//  extra platform features (Options Chain, unlimited watchlist, API
//  access, etc. — see features[] below), not a bigger quota.
// ══════════════════════════════════════════════════════════════════════════

// FIX: Free plan's AI Stock Screener access is now a 7-day trial from
// signup (user.created_at), not permanent/unlimited access. After the
// trial window closes, Free users are blocked from GET /api/market/stocks
// and prompted to upgrade — see requireScreenerAccess() in
// middleware/planCheck.js, which is the actual enforcement point (it reads
// this constant). Paid plans (Basic/Pro/Elite) are unaffected — 'screener'
// in their features list still means permanent access.
const FREE_SCREENER_TRIAL_DAYS = 7;

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
      // FIX: 'screener' being in this list no longer means permanent
      // access for Free — it now just means "eligible", gated to a
      // FREE_SCREENER_TRIAL_DAYS-day trial from signup by
      // requireScreenerAccess() in middleware/planCheck.js (used on
      // GET /api/market/stocks instead of the plain requireFeature('screener')
      // check that every other feature/plan combo uses). Once the trial
      // ends, Free users get a 403 prompting them to upgrade; Basic/Pro/
      // Elite keep permanent access via the same list entry.
      'screener',
      // AI Brief (AI Morning Market Brief) is available on every plan,
      // including Free — insightCascadeForPlan()'s default/free case
      // already routes this to Gemini Flash only, so this just unlocks
      // the feature gate without changing the free-tier model cascade.
      'ai_insight',
    ],
  },

  pro: {
    name: 'Pro',
    amountInPaise: 49900,             // ₹499

    // Token limits — single-model plan, so the full quota is one model's
    // own ceiling (no per-model splitting needed anymore).
    monthlyTokenQuota:   250_000,     // 250,000 tokens/month
    maxTokensPerRequest: 3_000,       // 3,000 tokens max per single request
    monthlyAiQueries:    166,         // ~250,000 / 1,500-avg-tokens-per-analysis

    // Pro calls Gemini 2.5 Flash only — no parallel multi-model cascade,
    // no consensus/debate logic. Simple, fast, predictable cost.
    aiModels: {
      gemini_flash: {
        modelId:           'gemini-2.5-flash',
        maxOutputTokens:   3_000,
        monthlyTokenQuota: 250_000,        // ~₹4 worst-case AI cost/mo
      },
    },
    features: [
      'prediction_history',
      'technical_score',
      'portfolio_tracker',
      'screener',
      'watchlist_50',
      'ai_chat',
      'ai_insight',
      'referral',
      // NOTE: 'telegram_alerts', 'whatsapp_alerts' are NOT implemented in
      // this backend yet (no route/service exists — see backend/README.md
      // and frontend "Coming Soon" badges). Kept here as planned features
      // so requireFeature() checks won't break once they ARE built.
      'telegram_alerts',
      'whatsapp_alerts',
    ],
  },

  elite: {
    name: 'Elite',
    amountInPaise: 99900,             // ₹999

    // Token limits — same 250,000-token ceiling as Pro. Elite's higher
    // price reflects Gemini 2.5 Pro's higher per-token cost plus the extra
    // platform features below (Options Chain, unlimited watchlist, API
    // access, 2FA, etc.), not a bigger quota.
    monthlyTokenQuota:   250_000,     // 250,000 tokens/month
    maxTokensPerRequest: 4_000,       // 4,000 tokens max per single request
    monthlyAiQueries:    125,         // ~250,000 / 2,000-avg-tokens-per-analysis

    // Elite calls Gemini 2.5 Pro only — deeper reasoning per call than
    // Flash, same simple single-model request shape as Pro.
    aiModels: {
      gemini_pro: {
        modelId:           'gemini-2.5-pro',
        maxOutputTokens:   4_000,
        monthlyTokenQuota: 250_000,        // ~₹239 worst-case AI cost/mo
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

module.exports = { PLANS, getPlan, planHasFeature, getModelConfig, getModelKeys, FREE_SCREENER_TRIAL_DAYS };

// config/plans.js
// ══════════════════════════════════════════════════════════════════════════
//  Single source of truth for plan pricing, limits and feature gates.
//  Plans: Free ₹0 | Pro ₹499/mo (was ₹4,999) | Elite ₹999/mo (was ₹9,999).
//  EVERY AI feature runs on DeepSeek only (lowest cost) — no other model is
//  used anywhere. The legacy "basic" plan no longer exists; stored 'basic'
//  users are treated as Pro (see getPlan).
//  Cost check (DeepSeek V3 ≈ ₹0.09 per 1K output tokens worst case):
//    Pro   50,000 tokens/mo (basic AI only)       vs ₹499
//    Elite unlimited analyses, 5,000,000-token fair-use cap ≈ ₹460 worst case vs ₹999
// ══════════════════════════════════════════════════════════════════════════

const FREE_SCREENER_TRIAL_DAYS = 7;

// ══════════════════════════════════════════════════════════════════════════
//  LAUNCH TRIAL — sitewide, time-boxed promotion (separate from the
//  Free-plan's 7-day screener trial above).
//
//  For LAUNCH_TRIAL_DAYS days after LAUNCH_TRIAL_START, every SIGNED-IN
//  user gets full Elite-tier access at no charge — no card required, no
//  charge, and no plan pricing is shown anywhere in the UI while the
//  banner is up. Signing in (a free account) is still required to use the
//  product during the trial; anonymous/logged-out visitors still have to
//  sign up first. See middleware/planCheck.js (isLaunchTrialActive() /
//  effectivePlanName()) for the enforcement point, and
//  controllers/paymentController.js for the checkout-side guard that
//  blocks creating a paid order while the trial is active.
//
//  Once the window closes, pricing reverts to the amountInPaise values
//  configured per plan below (Pro ₹499, Elite ₹999).
// ══════════════════════════════════════════════════════════════════════════
const LAUNCH_TRIAL_START = new Date('2026-08-16T00:00:00Z');
const LAUNCH_TRIAL_DAYS = 30;
const LAUNCH_TRIAL_END = new Date(LAUNCH_TRIAL_START.getTime() + LAUNCH_TRIAL_DAYS * 24 * 60 * 60 * 1000);

function isLaunchTrialActive() {
  const now = Date.now();
  return now >= LAUNCH_TRIAL_START.getTime() && now < LAUNCH_TRIAL_END.getTime();
}

function launchTrialDaysRemaining() {
  if (!isLaunchTrialActive()) return 0;
  return Math.ceil((LAUNCH_TRIAL_END.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

// Original (list) monthly prices shown struck-through with the discount %.
const LIST_PRICE_RUPEES = { pro: 4999, elite: 9999 };
const discountPercent = (plan, rupees) => (LIST_PRICE_RUPEES[plan] ? Math.round((1 - rupees / LIST_PRICE_RUPEES[plan]) * 100) : 0);

const PLANS = {
  free: {
    name: 'Free',
    amountInPaise: 0,
    monthlyTokenQuota:   50_000,
    maxTokensPerRequest: 1_500,
    monthlyAiQueries:    7,
    aiModels: {
      deepseek_v3: { modelId: 'deepseek-chat', maxOutputTokens: 2_500, monthlyTokenQuota: 50_000 },
    },
    features: ['watchlist_5', 'screener', 'ai_insight'],
  },

  pro: {
    name: 'Pro',
    amountInPaise: 49900,             // ₹499/month (list price ₹4,999 → 90% off)
    listPriceRupees: 4999,
    // ₹499 = Scanner + trading tools. Full AI features are on Elite (₹999);
    // Pro keeps the same basic AI allowance as Free (7 analyses + Morning Brief).
    monthlyTokenQuota:   50_000,
    maxTokensPerRequest: 1_500,
    monthlyAiQueries:    7,
    aiModels: {
      deepseek_v3: { modelId: 'deepseek-chat', maxOutputTokens: 2_500, monthlyTokenQuota: 50_000 },
    },
    features: [
      'prediction_history', 'technical_score', 'portfolio_tracker', 'screener',
      'telegram_alerts', 'whatsapp_alerts', 'watchlist_50', 'ai_insight', 'referral',
    ],
  },

  elite: {
    name: 'Elite',
    amountInPaise: 99900,             // ₹999/month (list price ₹9,999 → 90% off)
    listPriceRupees: 9999,
    // UNLIMITED AI analyses (-1 = no request cap). A hidden 5M-token monthly
    // fair-use ceiling (~₹460 worst case on DeepSeek) protects against abuse.
    monthlyTokenQuota:   5_000_000,
    maxTokensPerRequest: 10_000,
    monthlyAiQueries:    -1,
    aiModels: {
      deepseek_v3: { modelId: 'deepseek-chat', maxOutputTokens: 10_000, monthlyTokenQuota: 5_000_000 },
    },
    features: [
      'prediction_history', 'technical_score', 'portfolio_tracker', 'screener',
      'telegram_alerts', 'whatsapp_alerts', 'watchlist_unlimited', 'ai_chat', 'ai_insight', 'referral',
      'consensus_analysis', 'backtesting', 'options_analysis', 'pdf_reports', 'portfolio_advisor', 'api_access', '2fa',
    ],
  },
};

function getPlan(planName) {
  const key = (planName || 'free').toLowerCase();
  return PLANS[key === 'basic' ? 'pro' : key] || PLANS.free; // legacy 'basic' → Pro
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

module.exports = {
  PLANS, LIST_PRICE_RUPEES, discountPercent, getPlan, planHasFeature, getModelConfig, getModelKeys, FREE_SCREENER_TRIAL_DAYS,
  LAUNCH_TRIAL_START, LAUNCH_TRIAL_END, LAUNCH_TRIAL_DAYS, isLaunchTrialActive, launchTrialDaysRemaining,
};

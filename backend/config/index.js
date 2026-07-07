// config/index.js
require('dotenv').config();

const required = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'GOOGLE_CLIENT_ID',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
];

// At least one AI key must be present
const AI_KEYS = ['GEMINI_API_KEY', 'CLAUDE_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY'];

function assertRequiredEnv() {
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    console.error('   Copy .env.example to .env and fill these in before starting the server.');
    process.exit(1);
  }

  const hasAnyAiKey = AI_KEYS.some((k) => !!process.env[k]);
  if (!hasAnyAiKey) {
    console.error('❌ At least one AI API key is required:', AI_KEYS.join(' | '));
    console.error('   Set GEMINI_API_KEY (free tier), or add CLAUDE_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY for higher plans.');
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production') {
    if ((process.env.JWT_SECRET || '').length < 32) {
      console.error('❌ JWT_SECRET must be at least 32 characters in production.');
      process.exit(1);
    }
    if ((process.env.JWT_REFRESH_SECRET || '').length < 32) {
      console.error('❌ JWT_REFRESH_SECRET must be at least 32 characters in production.');
      process.exit(1);
    }
  }

  // Warn (not fatal) about missing higher-plan keys
  const missing_ai = AI_KEYS.filter((k) => !process.env[k]);
  if (missing_ai.length > 0 && missing_ai.length < AI_KEYS.length) {
    console.warn('⚠️  Some AI keys not set (higher-plan features may degrade):', missing_ai.join(', '));
  }

  // Warn (not fatal) about market data — charts/quotes fall back to a 501
  // at the route level if this is skipped, the server still boots fine.
  if (!process.env.UPSTOX_API_KEY || !process.env.UPSTOX_SECRET) {
    console.warn('⚠️  UPSTOX_API_KEY/UPSTOX_SECRET not set — /api/market routes will return 501 until configured.');
  }
}

const config = {
  port:        parseInt(process.env.PORT, 10) || 5000,
  nodeEnv:     process.env.NODE_ENV || 'development',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',

  jwt: {
    secret:          process.env.JWT_SECRET,
    expiresIn:       process.env.JWT_EXPIRES_IN       || '15m',
    refreshSecret:   process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn:process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  google: {
    clientId:    process.env.GOOGLE_CLIENT_ID,
    clientSecret:process.env.GOOGLE_CLIENT_SECRET,
    callbackUrl: process.env.GOOGLE_CALLBACK_URL,
  },

  razorpay: {
    keyId:         process.env.RAZORPAY_KEY_ID,
    keySecret:     process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
  },

  // Individual AI provider keys — used by services/aiService.js
  ai: {
    geminiKey:   process.env.GEMINI_API_KEY   || null,
    claudeKey:   process.env.CLAUDE_API_KEY   || null,
    openaiKey:   process.env.OPENAI_API_KEY   || null,
    deepseekKey: process.env.DEEPSEEK_API_KEY || null,
  },

  // Upstox — used by services/marketDataService.js for real NSE/BSE quotes
  // and historical candles. Optional: if absent, market routes return a
  // clear 501 instead of silently falling back to fake data.
  upstox: {
    apiKey:      process.env.UPSTOX_API_KEY      || null,
    apiSecret:   process.env.UPSTOX_SECRET       || null,
    redirectUri: process.env.UPSTOX_REDIRECT_URI || null,
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
    max:      parseInt(process.env.RATE_LIMIT_MAX,        10) || 100,
  },

  // Backup notification channel for the Upstox daily token refresh — used
  // by services/tokenScheduler.js if the phone push/WhatsApp approval
  // wasn't tapped in time, so the admin isn't relying on a single channel.
  adminAlertEmail: process.env.ADMIN_ALERT_EMAIL || null,
};

module.exports = { config, assertRequiredEnv };

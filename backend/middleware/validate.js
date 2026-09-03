// middleware/validate.js
// FIX: new file — input validation middleware using express-validator
// Prevents SQL injection attempts, XSS payloads, and malformed input
// from ever reaching controllers or the database.

const { body, param, query, validationResult } = require('express-validator');
const AppError = require('../utils/AppError');

/** Call this at the END of a validator chain to collect and return errors. */
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const messages = errors.array().map((e) => e.msg).join(', ');
    return next(new AppError(messages, 400));
  }
  next();
}

// ── Auth validators ──
const validateSignup = [
  body('name').trim().notEmpty().withMessage('Name is required.').isLength({ max: 120 }).withMessage('Name too long.'),
  body('email').trim().isEmail().withMessage('Valid email is required.').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter.')
    .matches(/[0-9]/).withMessage('Password must contain at least one number.'),
  body('referralCode').optional().trim().isAlphanumeric('en-US', { ignore: '-' }).isLength({ max: 20 }),
  handleValidationErrors,
];

const validateLogin = [
  body('email').trim().isEmail().withMessage('Valid email is required.').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required.').isLength({ max: 200 }),
  handleValidationErrors,
];

const validateGoogleLogin = [
  body('idToken').notEmpty().withMessage('Google ID token is required.').isLength({ max: 4096 }),
  handleValidationErrors,
];

const validateForgotPassword = [
  body('email').trim().isEmail().withMessage('Valid email is required.').normalizeEmail(),
  handleValidationErrors,
];

const validateResetPassword = [
  body('token').notEmpty().withMessage('Reset token is required.').isLength({ max: 512 }),
  body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters.')
    .matches(/[A-Z]/).withMessage('Password must contain at least one uppercase letter.')
    .matches(/[0-9]/).withMessage('Password must contain at least one number.'),
  handleValidationErrors,
];

// ── Payment validators ──
const validateCreateOrder = [
  body('planName').isIn(['basic', 'pro', 'elite']).withMessage('Invalid plan. Must be basic, pro, or elite.'),
  handleValidationErrors,
];

const validateVerifyPayment = [
  body('razorpay_order_id').notEmpty().trim().isLength({ max: 100 }),
  body('razorpay_payment_id').notEmpty().trim().isLength({ max: 100 }),
  body('razorpay_signature').notEmpty().trim().isLength({ max: 300 }),
  body('planName').isIn(['basic', 'pro', 'elite']).withMessage('Invalid plan. Must be basic, pro, or elite.'),
  handleValidationErrors,
];

// ── Portfolio validators ──
const validateAddHolding = [
  body('stockSymbol').trim().notEmpty().isLength({ max: 30 }).withMessage('Stock symbol is required.'),
  body('stockName').optional().trim().isLength({ max: 120 }),
  body('quantity').isFloat({ gt: 0 }).withMessage('Quantity must be a positive number.'),
  body('buyPrice').isFloat({ gt: 0 }).withMessage('Buy price must be a positive number.'),
  body('sector').optional().trim().isLength({ max: 60 }),
  handleValidationErrors,
];

const validateUpdateHolding = [
  param('id').isUUID().withMessage('Invalid holding ID.'),
  body('quantity').optional().isFloat({ gt: 0 }).withMessage('Quantity must be positive.'),
  body('buyPrice').optional().isFloat({ gt: 0 }).withMessage('Buy price must be positive.'),
  body('currentPrice').optional().isFloat({ gt: 0 }).withMessage('Current price must be positive.'),
  handleValidationErrors,
];

// ── Watchlist validators ──
const validateAddWatchlist = [
  body('stockSymbol').trim().notEmpty().isLength({ max: 30 }).withMessage('Stock symbol is required.'),
  body('stockName').optional().trim().isLength({ max: 120 }),
  body('alertPrice').optional().isFloat({ gt: 0 }).withMessage('Alert price must be positive.'),
  body('alertDirection').optional().isIn(['above', 'below']).withMessage('Alert direction must be above or below.'),
  handleValidationErrors,
];

// ── Feedback validators ──
const validateSubmitFeedback = [
  body('subject').trim().notEmpty().withMessage('Subject is required.').isLength({ max: 150 }).withMessage('Subject must be 150 characters or less.'),
  body('category').trim().isIn(['Bug Report', 'Feature Request', 'AI Analysis Quality', 'Pricing & Billing', 'General Feedback', 'Other']).withMessage('Invalid category.'),
  body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5.').toInt(),
  body('message').trim().notEmpty().withMessage('Message is required.').isLength({ max: 2000 }).withMessage('Message must be 2000 characters or less.'),
  handleValidationErrors,
];

// ── AI validators ──
const validateAiAnalyze = [
  body('stockSymbol')
    .trim().notEmpty().withMessage('stockSymbol is required.')
    .isLength({ max: 30 }).withMessage('stockSymbol too long.')
    .matches(/^[A-Za-z0-9&_ -]+$/).withMessage('stockSymbol contains invalid characters.'),
  body('horizon')
    .optional()
    .isIn(['1 week', '1 month', '3 months', 'short', 'medium', 'long'])
    .withMessage('horizon must be one of: 1 week, 1 month, 3 months.'),
  body('riskTolerance')
    .optional()
    .isIn(['low', 'moderate', 'high'])
    .withMessage('riskTolerance must be low, moderate, or high.'),
  // FIX: the "Analysis timeframe" dropdown sends this but it was neither
  // validated nor read by the controller — see routes/aiRoutes.js.
  body('timeframe')
    .optional()
    .isIn(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1mo', '3mo', '6mo', '1y', '3y', '5y'])
    .withMessage('timeframe must be one of: 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w, 1mo, 3mo, 6mo, 1y, 3y, 5y.'),
  body('exchange')
    .optional()
    .isIn(['NSE_EQ', 'BSE_EQ'])
    .withMessage('exchange must be NSE_EQ or BSE_EQ.'),
  handleValidationErrors,
];

// ── Admin validators ──
const validateUpdateUserPlan = [
  param('id').isUUID().withMessage('Invalid user ID.'),
  body('plan').isIn(['free', 'basic', 'pro', 'elite']).withMessage('Invalid plan.'),
  handleValidationErrors,
];

// ── Market data validators ──
const validateMarketSymbol = [
  param('symbol')
    .trim().notEmpty().withMessage('symbol is required.')
    .isLength({ max: 30 }).withMessage('symbol too long.')
    .matches(/^[A-Za-z0-9&_-]+$/).withMessage('symbol contains invalid characters.'),
  handleValidationErrors,
];

const validateMarketCandles = [
  param('symbol')
    .trim().notEmpty().withMessage('symbol is required.')
    .isLength({ max: 30 }).withMessage('symbol too long.')
    .matches(/^[A-Za-z0-9&_-]+$/).withMessage('symbol contains invalid characters.'),
  query('unit').optional().isIn(['minutes', 'hours', 'days', 'weeks', 'months']).withMessage('unit must be one of: minutes, hours, days, weeks, months.'),
  query('interval').optional().isInt({ min: 1, max: 300 }).withMessage('interval must be a positive integer.'),
  query('from').optional().isISO8601().withMessage('from must be a date in YYYY-MM-DD format.'),
  query('to').optional().isISO8601().withMessage('to must be a date in YYYY-MM-DD format.'),
  handleValidationErrors,
];

// Screener "Time Interval" chip values — must match the keys in
// backend/services/marketDataService.js PERIOD_CANDLE_PARAMS and the
// frontend's setScreenerTimeframe() button ids (scr-tf-*).
const SCREENER_PERIODS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1mo', '3mo', '6mo', '1y', '3y', '5y'];

const validateMarketQuotes = [
  query('symbols')
    .trim().notEmpty().withMessage('symbols is required (comma-separated).')
    .isLength({ max: 2000 }).withMessage('symbols list too long.')
    .matches(/^[A-Za-z0-9&_,-]+$/).withMessage('symbols contains invalid characters.'),
  query('exchange').optional().isIn(['NSE_EQ', 'BSE_EQ']).withMessage('exchange must be NSE_EQ or BSE_EQ.'),
  // FIX: /signals accepts ?period= (the Screener's Time Interval chip) but
  // it was never validated or even read by the controller — see
  // marketController.js getSignals.
  query('period').optional().isIn(SCREENER_PERIODS).withMessage(`period must be one of: ${SCREENER_PERIODS.join(', ')}.`),
  handleValidationErrors,
];

const validateMarketReport = [
  param('symbol')
    .trim().notEmpty().withMessage('symbol is required.')
    .isLength({ max: 30 }).withMessage('symbol too long.')
    .matches(/^[A-Za-z0-9&_-]+$/).withMessage('symbol contains invalid characters.'),
  query('exchange').optional().isIn(['NSE_EQ', 'BSE_EQ']).withMessage('exchange must be NSE_EQ or BSE_EQ.'),
  query('period').optional().isIn(SCREENER_PERIODS).withMessage(`period must be one of: ${SCREENER_PERIODS.join(', ')}.`),
  handleValidationErrors,
];

const validateMarketSearch = [
  query('q')
    .trim().notEmpty().withMessage('q is required.')
    .isLength({ min: 1, max: 30 }).withMessage('q must be 1-30 characters.')
    .matches(/^[A-Za-z0-9&_-]+$/).withMessage('q contains invalid characters.'),
  handleValidationErrors,
];

module.exports = {
  validateSignup,
  validateLogin,
  validateGoogleLogin,
  validateForgotPassword,
  validateResetPassword,
  validateCreateOrder,
  validateVerifyPayment,
  validateAddHolding,
  validateUpdateHolding,
  validateAddWatchlist,
  validateSubmitFeedback,
  validateAiAnalyze,
  validateUpdateUserPlan,
  validateMarketSymbol,
  validateMarketCandles,
  validateMarketQuotes,
  validateMarketReport,
  validateMarketSearch,
};

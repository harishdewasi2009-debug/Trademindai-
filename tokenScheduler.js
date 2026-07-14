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

const validateMarketQuotes = [
  query('symbols')
    .trim().notEmpty().withMessage('symbols is required (comma-separated).')
    .isLength({ max: 2000 }).withMessage('symbols list too long.')
    .matches(/^[A-Za-z0-9&_,-]+$/).withMessage('symbols contains invalid characters.'),
  query('exchange').optional().isIn(['NSE_EQ', 'BSE_EQ']).withMessage('exchange must be NSE_EQ or BSE_EQ.'),
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
  validateAiAnalyze,
  validateUpdateUserPlan,
  validateMarketSymbol,
  validateMarketCandles,
  validateMarketQuotes,
  validateMarketSearch,
};

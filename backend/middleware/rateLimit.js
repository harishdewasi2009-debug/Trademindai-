// middleware/rateLimit.js
const rateLimit = require('express-rate-limit');
const { config } = require('../config');

// General API limiter — stops scraping/abuse
const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});

// Strict limiter for login/signup — defends against brute force & credential stuffing
// FIX: reduced from 10 to 5 attempts per 15 min, added skipSuccessfulRequests
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only count failed attempts
  message: { error: 'Too many auth attempts. Please wait 15 minutes and try again.' },
});

// Payment routes — tighter to deter card-testing
const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10, // FIX: was 15
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment attempts. Please wait a few minutes and try again.' },
});

// FIX: new limiter — AI routes are expensive, tighter cap per IP
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests. Please wait a moment and try again.' },
});

// Market data routes (quotes/candles) — looser than AI since charts poll
// frequently, but still capped to protect the shared Upstox connection
// from being hammered by one client.
const marketLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many market data requests. Please slow down polling.' },
});

// FIX: new limiter — admin routes should be tightly restricted
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many admin requests.' },
});

module.exports = { apiLimiter, authLimiter, paymentLimiter, aiLimiter, marketLimiter, adminLimiter };

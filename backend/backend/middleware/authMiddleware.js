// middleware/authMiddleware.js
const { verifyAccessToken, verifyRefreshToken, signAccessToken } = require('../utils/jwt');
const { query } = require('../db/pool');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Requires a valid access token. Reads from:
 *   1. Authorization: Bearer <token>  (preferred for API/mobile clients)
 *   2. accessToken cookie             (httpOnly cookie set on web login)
 * Attaches the DB user row to req.user (without password_hash).
 */
const requireAuth = asyncHandler(async (req, res, next) => {
  let token;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.split(' ')[1];
  } else if (req.cookies?.accessToken) {
    token = req.cookies.accessToken;
  }

  let payload;
  if (token) {
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      payload = null; // expired/invalid accessToken — fall through to refresh-cookie retry below
    }
  }

  // FIX ("logged in on the site but a direct link like /api/market/upstox/login
  // says Not authenticated"): the accessToken cookie only lives 15 minutes.
  // The frontend SPA silently calls /api/auth/refresh in the background to
  // keep itself logged in, but that refresh never fires for a plain browser
  // navigation to a different URL/new tab (e.g. an admin pasting the Upstox
  // login link directly). If we have a still-valid 30-day refreshToken
  // cookie, mint a fresh accessToken here instead of rejecting the request.
  if (!payload && req.cookies?.refreshToken) {
    try {
      const refreshPayload = verifyRefreshToken(req.cookies.refreshToken);
      const { rows: refreshRows } = await query(
        `SELECT id, name, email, plan, subscription_status, is_admin, two_fa_enabled, created_at
         FROM users WHERE id = $1`,
        [refreshPayload.sub]
      );
      if (refreshRows.length) {
        const newAccessToken = signAccessToken(refreshRows[0]);
        const { accessCookieOpts } = require('../controllers/authController');
        res.cookie('accessToken', newAccessToken, accessCookieOpts(req));
        req.user = refreshRows[0];
        return next();
      }
    } catch (err) {
      // refreshToken also invalid/expired — fall through to the 401 below
    }
  }

  if (!payload) throw new AppError('Not authenticated. Please log in.', 401);

  const { rows } = await query(
    `SELECT id, name, email, plan, subscription_status, is_admin, two_fa_enabled, created_at
     FROM users WHERE id = $1`,
    [payload.sub]
  );
  if (!rows.length) throw new AppError('User no longer exists.', 401);

  req.user = rows[0];
  next();
});

/** Like requireAuth, but doesn't fail if no token — just leaves req.user undefined. */
const optionalAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.split(' ')[1] : req.cookies?.accessToken;
  if (!token) return next();
  try {
    const payload = verifyAccessToken(token);
    const { rows } = await query('SELECT id, name, email, plan, is_admin FROM users WHERE id = $1', [payload.sub]);
    if (rows.length) req.user = rows[0];
  } catch (_) {
    // invalid/expired token on an optional route — just proceed unauthenticated
  }
  next();
});

module.exports = { requireAuth, optionalAuth };

// middleware/authMiddleware.js
const { verifyAccessToken } = require('../utils/jwt');
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

  if (!token) throw new AppError('Not authenticated. Please log in.', 401);

  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    throw new AppError('Session expired or invalid. Please log in again.', 401);
  }

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

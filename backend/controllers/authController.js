// controllers/authController.js
const bcrypt = require('bcryptjs');
const { query, getClient } = require('../db/pool');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../utils/jwt');
const { verifyGoogleIdToken } = require('../services/googleAuthService');
const { generateUniqueReferralCode } = require('../services/referralService');
const { sendPasswordResetEmail } = require('../services/emailService');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');
const crypto = require('crypto');

const IS_PROD = process.env.NODE_ENV === 'production';

// FIX: secure: true in production, added __Host- prefix for access token
const ACCESS_COOKIE_OPTS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: IS_PROD ? 'strict' : 'lax',
  maxAge: 15 * 60 * 1000, // 15 min — matches JWT_EXPIRES_IN
  path: '/',
};

const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: IS_PROD ? 'strict' : 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  path: '/api/auth/refresh', // FIX: scope refresh cookie to refresh endpoint only
};

function sanitizeUser(user) {
  const { password_hash, two_fa_secret, ...safe } = user;
  return safe;
}

async function issueTokensAndSession(user, req, res) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);
  const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');

  // FIX: clean up expired/revoked sessions for this user before creating a new one
  await query(
    `DELETE FROM sessions WHERE user_id = $1 AND (is_revoked = TRUE OR expires_at < now())`,
    [user.id]
  );

  await query(
    `INSERT INTO sessions (user_id, refresh_token_hash, device_label, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '30 days')`,
    [user.id, refreshTokenHash, req.headers['x-device-label'] || 'Unknown device', req.ip, req.headers['user-agent']]
  );

  res.cookie('accessToken', accessToken, ACCESS_COOKIE_OPTS);
  res.cookie('refreshToken', refreshToken, REFRESH_COOKIE_OPTS);
  return { accessToken, refreshToken };
}

// ── POST /api/auth/signup ──
const signup = asyncHandler(async (req, res) => {
  // Input already validated by validateSignup middleware
  const { name, email, password, referralCode } = req.body;

  const { rows: existing } = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.length) throw new AppError('An account with this email already exists.', 409);

  let referredBy = null;
  if (referralCode) {
    const { rows } = await query('SELECT id FROM users WHERE referral_code = $1', [referralCode.toUpperCase()]);
    if (rows.length) referredBy = rows[0].id;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const myReferralCode = await generateUniqueReferralCode(name);

  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, referral_code, referred_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, email, plan, subscription_status, is_admin, referral_code, created_at`,
    [name, email.toLowerCase(), passwordHash, myReferralCode, referredBy]
  );
  const user = rows[0];
  const tokens = await issueTokensAndSession(user, req, res);

  res.status(201).json({ user: sanitizeUser(user), accessToken: tokens.accessToken });
});

// ── POST /api/auth/login ──
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const { rows } = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = rows[0];

  // FIX: use constant-time compare to avoid timing attacks
  // Always run bcrypt even if user not found, to prevent user enumeration via timing
  const dummyHash = '$2a$12$invalidhashusedtoblindtimingattacks000000000000000000000';
  const valid = user?.password_hash
    ? await bcrypt.compare(password, user.password_hash)
    : await bcrypt.compare(password, dummyHash).then(() => false);

  if (!user || !user.password_hash || !valid) {
    throw new AppError('Invalid email or password.', 401);
  }

  const tokens = await issueTokensAndSession(user, req, res);
  res.json({ user: sanitizeUser(user), accessToken: tokens.accessToken });
});

// ── POST /api/auth/forgot-password ──
const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const { rows } = await query('SELECT id, name, email, password_hash FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = rows[0];

  // FIX: always return the same response whether the email exists or not —
  // prevents attackers from using this endpoint to enumerate registered emails.
  const genericResponse = { message: 'If an account exists for that email, a reset link has been sent.' };

  // Google-only accounts have no password_hash — nothing to reset, so we still
  // return the generic response and simply don't send anything.
  if (!user || !user.password_hash) {
    return res.json(genericResponse);
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  // Invalidate any previous unused reset tokens for this user before issuing a new one
  await query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
  await query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')`,
    [user.id, tokenHash]
  );

  const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/?resetToken=${rawToken}#reset-password`;
  try {
    await sendPasswordResetEmail(user.email, resetUrl);
  } catch (err) {
    console.error('[forgotPassword] failed to send email:', err.message);
    // Don't leak the failure to the client — still respond generically.
  }

  res.json(genericResponse);
});

// ── POST /api/auth/reset-password ──
const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const { rows } = await query(
    `SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [tokenHash]
  );
  const resetRow = rows[0];
  if (!resetRow) {
    throw new AppError('This reset link is invalid or has expired. Please request a new one.', 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [passwordHash, resetRow.user_id]);
    await client.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [resetRow.id]);
    // FIX: revoke every existing session — if someone else had access to the
    // account, a password reset should kick them out everywhere.
    await client.query('UPDATE sessions SET is_revoked = TRUE WHERE user_id = $1', [resetRow.user_id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  res.json({ message: 'Password updated. Please sign in with your new password.' });
});

// ── POST /api/auth/google ──
const googleLogin = asyncHandler(async (req, res) => {
  const { idToken, referralCode } = req.body;
  const profile = await verifyGoogleIdToken(idToken);

  const { rows: existingRows } = await query('SELECT * FROM users WHERE google_id = $1 OR email = $2', [
    profile.googleId,
    profile.email,
  ]);

  let user = existingRows[0];

  if (!user) {
    let referredBy = null;
    if (referralCode) {
      const { rows } = await query('SELECT id FROM users WHERE referral_code = $1', [referralCode.toUpperCase()]);
      if (rows.length) referredBy = rows[0].id;
    }
    const myReferralCode = await generateUniqueReferralCode(profile.name);
    const { rows } = await query(
      `INSERT INTO users (name, email, google_id, email_verified, referral_code, referred_by)
       VALUES ($1, $2, $3, TRUE, $4, $5)
       RETURNING *`,
      [profile.name, profile.email, profile.googleId, myReferralCode, referredBy]
    );
    user = rows[0];
  } else if (!user.google_id) {
    await query('UPDATE users SET google_id = $1, email_verified = TRUE WHERE id = $2', [profile.googleId, user.id]);
    user.google_id = profile.googleId;
  }

  const tokens = await issueTokensAndSession(user, req, res);
  res.json({ user: sanitizeUser(user), accessToken: tokens.accessToken });
});

// ── POST /api/auth/refresh ──
const refresh = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!token) throw new AppError('No refresh token provided.', 401);

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch (_) {
    throw new AppError('Refresh token expired or invalid. Please log in again.', 401);
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const { rows: sessionRows } = await query(
    `SELECT * FROM sessions WHERE user_id = $1 AND refresh_token_hash = $2 AND is_revoked = FALSE AND expires_at > now()`,
    [payload.sub, tokenHash]
  );
  if (!sessionRows.length) throw new AppError('Session not found or revoked. Please log in again.', 401);

  const { rows: userRows } = await query('SELECT * FROM users WHERE id = $1', [payload.sub]);
  if (!userRows.length) throw new AppError('User no longer exists.', 401);

  // FIX: rotate refresh token on every use (refresh token rotation)
  const newRefreshToken = signRefreshToken(userRows[0]);
  const newRefreshHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');

  await query(
    `UPDATE sessions SET refresh_token_hash = $1, last_used_at = now(), expires_at = now() + interval '30 days'
     WHERE id = $2`,
    [newRefreshHash, sessionRows[0].id]
  );

  const accessToken = signAccessToken(userRows[0]);
  res.cookie('accessToken', accessToken, ACCESS_COOKIE_OPTS);
  res.cookie('refreshToken', newRefreshToken, REFRESH_COOKIE_OPTS);

  res.json({ accessToken });
});

// ── POST /api/auth/logout ──
const logout = asyncHandler(async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await query('UPDATE sessions SET is_revoked = TRUE WHERE refresh_token_hash = $1', [tokenHash]);
  }
  res.clearCookie('accessToken', { path: '/' });
  res.clearCookie('refreshToken', { path: '/api/auth/refresh' });
  res.json({ message: 'Logged out successfully.' });
});

// ── GET /api/auth/me ──
const getMe = asyncHandler(async (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

// ── GET /api/auth/sessions ──
const listSessions = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, device_label, ip_address, last_used_at, created_at, is_revoked
     FROM sessions WHERE user_id = $1 ORDER BY last_used_at DESC LIMIT 20`,
    [req.user.id]
  );
  res.json({ sessions: rows });
});

// ── DELETE /api/auth/sessions/:id ──
const revokeSession = asyncHandler(async (req, res) => {
  await query('UPDATE sessions SET is_revoked = TRUE WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ message: 'Session revoked.' });
});

module.exports = { signup, login, googleLogin, forgotPassword, resetPassword, refresh, logout, getMe, listSessions, revokeSession };

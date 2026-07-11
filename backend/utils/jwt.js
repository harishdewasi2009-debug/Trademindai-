// ⚠️ Only add this file if utils/jwt.js does not already exist in your repo.
// If you already have one (your login/portfolio features work, so you
// probably do), keep your existing version instead of this one — this is a
// generic fallback, and your real auth controller may sign tokens with a
// different payload shape than this file assumes.

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (!JWT_SECRET) {
  // eslint-disable-next-line no-console
  console.warn('[utils/jwt] JWT_SECRET is not set — check your .env file.');
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { signToken, verifyToken };

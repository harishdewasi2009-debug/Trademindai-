// services/googleAuthService.js
// Flow this supports (the standard, simplest Google Sign-In integration):
//   1. Frontend uses Google's "Sign in with Google" button/library, gets an ID token
//   2. Frontend POSTs that ID token to our /api/auth/google route
//   3. We verify it server-side with Google's library (NEVER trust a client-sent email/name directly)
//   4. We find-or-create the user and issue OUR OWN JWTs
//
// This is simpler to wire up than full OAuth redirect-flow and is what most
// SaaS frontends use today (Google Identity Services "One Tap" / button).

const { OAuth2Client } = require('google-auth-library');
const { config } = require('../config');
const AppError = require('../utils/AppError');

const client = new OAuth2Client(config.google.clientId);

/**
 * Verifies a Google ID token and returns the verified profile.
 * Throws AppError(401) if the token is invalid, expired, or for the wrong app.
 */
async function verifyGoogleIdToken(idToken) {
  if (!idToken) throw new AppError('Missing Google ID token.', 400);

  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      audience: config.google.clientId,
    });
  } catch (err) {
    throw new AppError('Invalid or expired Google token.', 401);
  }

  const payload = ticket.getPayload();
  if (!payload || !payload.email) {
    throw new AppError('Google account has no email associated.', 401);
  }
  if (!payload.email_verified) {
    throw new AppError('Google email is not verified.', 401);
  }

  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name || payload.email.split('@')[0],
    picture: payload.picture,
  };
}

module.exports = { verifyGoogleIdToken };

// db/seedUpstoxToken.js
// One-off helper to insert an already-issued Upstox access token directly
// into broker_tokens, skipping the /api/market/upstox/login OAuth flow.
//
// Usage:
//   UPSTOX_ACCESS_TOKEN=eyJ... node db/seedUpstoxToken.js
//
// Reads the token's own `exp` claim (it's a JWT) so expires_at is accurate
// even for Upstox "extended" tokens that don't follow the usual daily
// 3:30am IST expiry.

require('dotenv').config();
const { Pool } = require('pg');

function decodeJwtExpiry(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Not a JWT — expected header.payload.signature');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  if (!payload.exp) throw new Error('Token payload has no exp claim');
  return new Date(payload.exp * 1000);
}

async function main() {
  const token = process.env.UPSTOX_ACCESS_TOKEN || process.argv[2];
  if (!token) {
    console.error('Provide the token via UPSTOX_ACCESS_TOKEN env var or as the first CLI arg.');
    process.exit(1);
  }

  const expiresAt = decodeJwtExpiry(token);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  await pool.query(
    `INSERT INTO broker_tokens (provider, access_token, expires_at)
     VALUES ('upstox', $1, $2)
     ON CONFLICT (provider) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       expires_at   = EXCLUDED.expires_at,
       created_at   = now()`,
    [token, expiresAt]
  );

  console.log('✅ Upstox token saved.');
  console.log(`   Expires: ${expiresAt.toISOString()}`);

  await pool.end();
}

main().catch((err) => {
  console.error('Seeding Upstox token failed:', err.message);
  process.exit(1);
});

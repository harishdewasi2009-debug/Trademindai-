// db/promoteAdmin.js
// Run with: node db/promoteAdmin.js [email]
// (defaults to harishdewasi2009@gmail.com if no email is passed)
//
// Directly flips is_admin = TRUE for an existing user row, matched by
// email. Use this if the account already exists and you don't want to
// wait for them to sign in again (authController.js's googleLogin also
// auto-promotes ADMIN_EMAILS on next Google sign-in — this script is the
// immediate/manual equivalent of that, for right now).
//
// If the user hasn't signed up yet, this creates a placeholder row so the
// email is admin-flagged from their very first Google sign-in — the
// row's other columns (name, plan, etc.) get filled in for real by
// authController.js the moment they actually log in with Google.

require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const email = (process.argv[2] || 'harishdewasi2009@gmail.com').trim().toLowerCase();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const { rows: existing } = await pool.query('SELECT id, is_admin FROM users WHERE lower(email) = $1', [email]);

  if (existing.length) {
    if (existing[0].is_admin) {
      console.log(`✅ ${email} is already an admin (no change).`);
    } else {
      await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [existing[0].id]);
      console.log(`✅ ${email} promoted to admin.`);
    }
  } else {
    await pool.query(
      `INSERT INTO users (name, email, plan, subscription_status, is_admin, referral_code, email_verified)
       VALUES ('Admin', $1, 'elite', 'active', TRUE, $2, FALSE)`,
      [email, 'ADMIN-' + Math.random().toString(36).slice(2, 8).toUpperCase()]
    );
    console.log(`✅ Placeholder admin row created for ${email}.`);
    console.log('   Sign in with Google using this exact email to finish activating the account.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('promoteAdmin failed:', err);
  process.exit(1);
});

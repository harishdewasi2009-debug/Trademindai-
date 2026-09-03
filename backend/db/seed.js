// db/seed.js
// Run with: node db/seed.js
// Creates one admin user row so you have something to test the admin panel
// with immediately after setup.
//
// UPDATED: email/password login is disabled — sign in as this admin via
// Google instead. Set SEED_ADMIN_EMAIL below to a real Gmail/Google
// Workspace address you can actually sign in with; the first time you sign
// in with Google using that exact email, it attaches to this existing row
// (matched by email in authController.googleLogin) and you get is_admin
// access immediately. The password below is set but unused.

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const email = process.env.SEED_ADMIN_EMAIL || 'admin@trademind.local';
  const password = process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!';
  const passwordHash = await bcrypt.hash(password, 12);

  const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.length) {
    console.log(`Admin user already exists: ${email}`);
  } else {
    await pool.query(
      `INSERT INTO users (name, email, password_hash, plan, subscription_status, is_admin, referral_code, email_verified)
       VALUES ('Admin', $1, $2, 'elite', 'active', TRUE, 'ADMIN-0001', TRUE)`,
      [email, passwordHash]
    );
    console.log('✅ Admin user created.');
    console.log(`   Email:    ${email}`);
    console.log(`   Password: ${password}`);
    console.log('   ⚠️  Change this password immediately in a real deployment.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});

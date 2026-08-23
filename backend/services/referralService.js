// services/referralService.js
const { query } = require('../db/pool');

/** Generates a short, human-shareable referral code like "RAHUL-7F3K" and ensures it's unique. */
async function generateUniqueReferralCode(name) {
  const base = (name || 'TM').split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'TRADER';
  for (let attempt = 0; attempt < 5; attempt++) {
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const code = `${base}-${suffix}`;
    const { rows } = await query('SELECT 1 FROM users WHERE referral_code = $1', [code]);
    if (!rows.length) return code;
  }
  // extremely unlikely fallback
  return `${base}-${Date.now().toString(36).toUpperCase()}`;
}

/** Credits the referrer once the referred user's first PRO or ELITE payment succeeds.
 *  Basic-plan purchases don't trigger a referral credit — only Pro and Elite do.
 *  Call this from the payment webhook/verify handler, passing the plan just purchased. */
async function creditReferralIfEligible(referredUserId, planName) {
  if (!['pro', 'elite'].includes((planName || '').toLowerCase())) return;

  const { rows: userRows } = await query('SELECT referred_by FROM users WHERE id = $1', [referredUserId]);
  const referredBy = userRows[0]?.referred_by;
  if (!referredBy) return;

  const { rows: existing } = await query(
    'SELECT id, status FROM referrals WHERE referrer_id = $1 AND referred_id = $2',
    [referredBy, referredUserId]
  );

  if (existing.length && existing[0].status === 'credited') return; // already credited, don't double-pay

  if (existing.length) {
    await query('UPDATE referrals SET status = $1 WHERE id = $2', ['credited', existing[0].id]);
  } else {
    await query(
      `INSERT INTO referrals (referrer_id, referred_id, credit_amount, status)
       VALUES ($1, $2, 500, 'credited')`,
      [referredBy, referredUserId]
    );
  }
}

module.exports = { generateUniqueReferralCode, creditReferralIfEligible };

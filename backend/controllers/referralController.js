// controllers/referralController.js
const { query } = require('../db/pool');
const { generateUniqueReferralCode } = require('../services/referralService');
const asyncHandler = require('../utils/asyncHandler');

// ── GET /api/referral ──
// Returns the user's referral code (creating one if they don't have one yet),
// summary stats, and full referral history — all from real DB rows.
const getReferralOverview = asyncHandler(async (req, res) => {
  let { rows: userRows } = await query('SELECT referral_code, name FROM users WHERE id = $1', [req.user.id]);
  let referralCode = userRows[0]?.referral_code;

  // Backfill a code for users created before the referral system existed.
  if (!referralCode) {
    referralCode = await generateUniqueReferralCode(userRows[0]?.name);
    await query('UPDATE users SET referral_code = $1 WHERE id = $2', [referralCode, req.user.id]);
  }

  const { rows: history } = await query(
    `SELECT u.name, u.plan, r.status, r.credit_amount, r.created_at
     FROM referrals r
     JOIN users u ON u.id = r.referred_id
     WHERE r.referrer_id = $1
     ORDER BY r.created_at DESC`,
    [req.user.id]
  );

  const friendsReferred = history.length;
  const activeSubscribers = history.filter(r => r.status === 'credited').length;
  const creditsEarned = history
    .filter(r => r.status === 'credited')
    .reduce((sum, r) => sum + Number(r.credit_amount), 0);

  res.json({
    referralCode,
    stats: { friendsReferred, creditsEarned, activeSubscribers },
    history: history.map(r => ({
      name: r.name,
      joined: r.created_at,
      plan: r.plan,
      status: r.status === 'credited' ? 'Active' : 'Pending',
      credit: Number(r.credit_amount),
    })),
  });
});

module.exports = { getReferralOverview };

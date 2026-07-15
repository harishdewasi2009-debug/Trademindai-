// controllers/advertiserController.js
const { query } = require('../db/pool');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_PLACEMENTS = ['Homepage banner', 'Dashboard sidebar', 'Email newsletter', 'All placements (bundle)'];

// ── POST /api/advertisers  (public — no auth, the "Advertise" enquiry form) ──
// Writes a real row into the `advertisers` table (status defaults to
// 'pending') so it shows up in the admin panel's Advertiser Enquiries list.
const submitEnquiry = asyncHandler(async (req, res) => {
  const { companyName, contactEmail, monthlyBudget, placement } = req.body || {};

  if (!companyName || typeof companyName !== 'string' || !companyName.trim()) {
    throw new AppError('companyName is required.', 400);
  }
  if (companyName.trim().length > 150) {
    throw new AppError('companyName must be 150 characters or fewer.', 400);
  }
  if (!contactEmail || typeof contactEmail !== 'string' || !EMAIL_RE.test(contactEmail.trim())) {
    throw new AppError('A valid contactEmail is required.', 400);
  }

  let budget = null;
  if (monthlyBudget !== undefined && monthlyBudget !== null && monthlyBudget !== '') {
    budget = Number(String(monthlyBudget).replace(/[₹,\s]/g, ''));
    if (!Number.isFinite(budget) || budget < 0) throw new AppError('monthlyBudget must be a valid number.', 400);
  }

  const placementClean = VALID_PLACEMENTS.includes(placement) ? placement : null;

  const { rows } = await query(
    `INSERT INTO advertisers (company_name, contact_email, monthly_budget, placement, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id, company_name, contact_email, monthly_budget, placement, status, created_at`,
    [companyName.trim(), contactEmail.trim().toLowerCase(), budget, placementClean]
  );

  res.status(201).json({
    message: 'Thanks — your enquiry has been received. Our team will follow up within 24 hours.',
    enquiry: rows[0],
  });
});

module.exports = { submitEnquiry };

// controllers/feedbackController.js
// Dashboard "Feedback" section — users submit subject/category/rating/message,
// stored in the `feedback` table (see db/schema.sql). Deliberately simple and
// self-contained: no interaction with any existing table, plan, or quota, so
// it can't affect any other feature.
const { query } = require('../db/pool');
const asyncHandler = require('../utils/asyncHandler');

const FEEDBACK_CATEGORIES = ['Bug Report', 'Feature Request', 'AI Analysis Quality', 'Pricing & Billing', 'General Feedback', 'Other'];

// ── POST /api/feedback ──
const submitFeedback = asyncHandler(async (req, res) => {
  const { subject, category, rating, message } = req.body;

  const { rows } = await query(
    `INSERT INTO feedback (user_id, subject, category, rating, message)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, subject, category, rating, message, created_at`,
    [req.user.id, subject.trim(), category, rating, message.trim()]
  );

  res.status(201).json({ message: 'Thanks — your feedback has been submitted.', feedback: rows[0] });
});

// ── GET /api/feedback — the signed-in user's own submissions, most recent first ──
const getMyFeedback = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, subject, category, rating, message, created_at
     FROM feedback WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ feedback: rows });
});

module.exports = { submitFeedback, getMyFeedback, FEEDBACK_CATEGORIES };

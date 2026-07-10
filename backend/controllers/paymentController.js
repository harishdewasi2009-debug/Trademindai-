// controllers/paymentController.js
const { query, getClient } = require('../db/pool');
const { createOrder, verifyPaymentSignature, verifyWebhookSignature } = require('../services/razorpayService');
const { creditReferralIfEligible } = require('../services/referralService');
const { getPlan } = require('../config/plans');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

// ── POST /api/payment/create-order ──
const createPaymentOrder = asyncHandler(async (req, res) => {
  const { planName } = req.body;
  if (!['basic', 'pro', 'elite'].includes(planName)) {
    throw new AppError('Invalid plan selected.', 400);
  }
  const plan = getPlan(planName);

  const order = await createOrder({ amountInPaise: plan.amountInPaise, userId: req.user.id, planName });

  await query(
    `INSERT INTO payments (user_id, razorpay_order_id, amount, plan_name, status)
     VALUES ($1, $2, $3, $4, 'created')`,
    [req.user.id, order.id, plan.amountInPaise / 100, planName]
  );

  res.json({
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: process.env.RAZORPAY_KEY_ID,
    planName,
  });
});

/** Shared logic: mark payment paid + activate/extend subscription + update user's plan. Used by both the frontend-verify route AND the webhook (idempotent). */
async function activateSubscriptionForPayment({ userId, orderId, paymentId, planName }) {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    const { rows: paymentRows } = await client.query(
      `UPDATE payments SET status = 'paid', razorpay_payment_id = $1
       WHERE razorpay_order_id = $2 AND status != 'paid'
       RETURNING id`,
      [paymentId, orderId]
    );

    // If already marked paid (e.g. webhook arrived after verify route already processed it), skip duplicate subscription creation
    if (!paymentRows.length) {
      await client.query('COMMIT');
      return { alreadyProcessed: true };
    }

    const plan = getPlan(planName);
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + 1);

    const { rows: subRows } = await client.query(
      `INSERT INTO subscriptions (user_id, plan_name, amount, start_date, expiry_date, status)
       VALUES ($1, $2, $3, now(), $4, 'active') RETURNING id`,
      [userId, planName, plan.amountInPaise / 100, expiryDate]
    );

    await client.query('UPDATE payments SET subscription_id = $1 WHERE id = $2', [subRows[0].id, paymentRows[0].id]);
    await client.query(`UPDATE users SET plan = $1, subscription_status = 'active' WHERE id = $2`, [planName, userId]);

    await client.query('COMMIT');
    return { alreadyProcessed: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── POST /api/payment/verify ── (called by frontend immediately after Razorpay checkout success)
const verifyPayment = asyncHandler(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planName } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    throw new AppError('Missing payment verification fields.', 400);
  }

  const valid = verifyPaymentSignature({
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    signature: razorpay_signature,
  });
  if (!valid) {
    await query(`UPDATE payments SET status = 'failed', failure_reason = 'signature_mismatch' WHERE razorpay_order_id = $1`, [razorpay_order_id]);
    throw new AppError('Payment verification failed. If money was deducted, contact support.', 400);
  }

  const result = await activateSubscriptionForPayment({
    userId: req.user.id,
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    planName,
  });

  await creditReferralIfEligible(req.user.id);

  res.json({ message: 'Payment verified and plan activated.', alreadyProcessed: result.alreadyProcessed });
});

// ── POST /api/payment/webhook ── (configured in Razorpay Dashboard → Webhooks)
// IMPORTANT: this route must receive the RAW request body for signature verification.
// In server.js it's mounted with express.raw({ type: 'application/json' }) BEFORE express.json().
const handleWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body; // Buffer, because of express.raw() on this route

  const valid = verifyWebhookSignature(rawBody, signature);
  if (!valid) {
    console.warn('[webhook] Invalid Razorpay signature received');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(rawBody.toString('utf8'));

  // Idempotency: Razorpay may retry the same webhook. Record event id, ignore duplicates.
  const eventId = event.event + '_' + (event.payload?.payment?.entity?.id || event.created_at);
  const { rows: existing } = await query('SELECT 1 FROM webhook_events WHERE provider = $1 AND event_id = $2', ['razorpay', eventId]);
  if (existing.length) return res.json({ status: 'already_processed' });

  await query(
    `INSERT INTO webhook_events (provider, event_id, event_type, payload) VALUES ('razorpay', $1, $2, $3)`,
    [eventId, event.event, event]
  );

  if (event.event === 'payment.captured') {
    const payment = event.payload.payment.entity;
    const orderId = payment.order_id;
    const { rows: paymentRows } = await query('SELECT user_id, plan_name FROM payments WHERE razorpay_order_id = $1', [orderId]);
    if (paymentRows.length) {
      await activateSubscriptionForPayment({
        userId: paymentRows[0].user_id,
        orderId,
        paymentId: payment.id,
        planName: paymentRows[0].plan_name,
      });
      await creditReferralIfEligible(paymentRows[0].user_id);
    }
  } else if (event.event === 'payment.failed') {
    const payment = event.payload.payment.entity;
    await query(`UPDATE payments SET status = 'failed', failure_reason = $1 WHERE razorpay_order_id = $2`, [
      payment.error_description || 'unknown',
      payment.order_id,
    ]);
  }

  res.json({ status: 'ok' });
});

// ── GET /api/payment/history ──
const getPaymentHistory = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, amount, plan_name, status, created_at FROM payments
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json({ payments: rows });
});

// ── POST /api/subscription/cancel ──
const cancelSubscription = asyncHandler(async (req, res) => {
  await query(
    `UPDATE subscriptions SET auto_renew = FALSE WHERE user_id = $1 AND status = 'active'`,
    [req.user.id]
  );
  res.json({ message: 'Auto-renew turned off. Your plan stays active until the current period ends.' });
});

module.exports = {
  createPaymentOrder,
  verifyPayment,
  handleWebhook,
  getPaymentHistory,
  cancelSubscription,
};

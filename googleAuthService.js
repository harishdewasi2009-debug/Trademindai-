// services/razorpayService.js
const Razorpay = require('razorpay');
const crypto = require('crypto');
const { config } = require('../config');
const AppError = require('../utils/AppError');

const razorpay = new Razorpay({
  key_id: config.razorpay.keyId,
  key_secret: config.razorpay.keySecret,
});

/**
 * Creates a Razorpay order for a one-time subscription charge.
 * amountInPaise: integer, e.g. ₹2,999 => 299900
 */
async function createOrder({ amountInPaise, userId, planName }) {
  if (!amountInPaise || amountInPaise <= 0) {
    throw new AppError('Invalid plan amount.', 400);
  }
  const order = await razorpay.orders.create({
    amount: amountInPaise,
    currency: 'INR',
    receipt: `tm_${Date.now()}`,
    notes: { userId, planName },
  });
  return order;
}

/**
 * Verifies the signature Razorpay sends back to the FRONTEND after checkout
 * completes (razorpay_order_id + razorpay_payment_id + razorpay_signature).
 * This must pass before we trust that payment succeeded — never activate
 * a plan based on the frontend simply saying "payment succeeded".
 */
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', config.razorpay.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const signatureBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

/**
 * Verifies the signature on incoming Razorpay WEBHOOK requests
 * (the X-Razorpay-Signature header). This is the more reliable source of
 * truth than the frontend callback, since webhooks fire even if the user
 * closes their browser mid-payment. Always verify BOTH.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', config.razorpay.webhookSecret)
    .update(rawBody)
    .digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const signatureBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

module.exports = { razorpay, createOrder, verifyPaymentSignature, verifyWebhookSignature };

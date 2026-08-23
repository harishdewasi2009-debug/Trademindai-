// routes/paymentRoutes.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { paymentLimiter } = require('../middleware/rateLimit');
const { validateCreateOrder, validateVerifyPayment } = require('../middleware/validate');
const ctrl = require('../controllers/paymentController');

// NOTE: webhook is mounted in server.js with express.raw() BEFORE express.json()

// FIX: added input validation middleware
router.post('/create-order', requireAuth, paymentLimiter, validateCreateOrder, ctrl.createPaymentOrder);
router.post('/verify', requireAuth, paymentLimiter, validateVerifyPayment, ctrl.verifyPayment);
router.get('/history', requireAuth, ctrl.getPaymentHistory);
router.post('/subscription/cancel', requireAuth, ctrl.cancelSubscription);

module.exports = router;

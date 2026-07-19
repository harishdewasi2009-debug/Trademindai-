// routes/referralRoutes.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/referralController');

router.get('/', requireAuth, ctrl.getReferralOverview);

module.exports = router;

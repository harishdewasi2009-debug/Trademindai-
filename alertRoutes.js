// routes/advertiserRoutes.js
const express = require('express');
const router = express.Router();
const { advertiserLimiter } = require('../middleware/rateLimit');
const ctrl = require('../controllers/advertiserController');

// POST /api/advertisers — public "Advertise with us" enquiry form.
// No auth: this is submitted by prospective advertisers, not logged-in
// TradeMind users. Rate-limited to deter spam (see advertiserLimiter).
router.post('/', advertiserLimiter, ctrl.submitEnquiry);

module.exports = router;

// routes/feedbackRoutes.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { validateSubmitFeedback } = require('../middleware/validate');
const ctrl = require('../controllers/feedbackController');

router.get('/', requireAuth, ctrl.getMyFeedback);
router.post('/', requireAuth, validateSubmitFeedback, ctrl.submitFeedback);

module.exports = router;

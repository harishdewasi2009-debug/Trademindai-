// routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminCheck');
const { adminLimiter } = require('../middleware/rateLimit');
const { validateUpdateUserPlan } = require('../middleware/validate');
const ctrl = require('../controllers/adminController');

// FIX: added adminLimiter + validation on plan update
router.use(requireAuth, requireAdmin, adminLimiter);

router.get('/stats', ctrl.getStats);
router.get('/users', ctrl.listUsers);
router.patch('/users/:id/plan', validateUpdateUserPlan, ctrl.updateUserPlan);
router.get('/api-usage', ctrl.getApiUsage);

module.exports = router;

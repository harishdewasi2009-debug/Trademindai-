// routes/portfolioRoutes.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { requireFeature } = require('../middleware/planCheck');
const { validateAddHolding, validateUpdateHolding } = require('../middleware/validate');
const ctrl = require('../controllers/portfolioController');

// FIX: added input validation + plan feature gate
router.get('/', requireAuth, requireFeature('portfolio_tracker'), ctrl.getPortfolio);
router.post('/', requireAuth, requireFeature('portfolio_tracker'), validateAddHolding, ctrl.addHolding);
router.put('/:id', requireAuth, requireFeature('portfolio_tracker'), validateUpdateHolding, ctrl.updateHolding);
router.delete('/:id', requireAuth, requireFeature('portfolio_tracker'), ctrl.deleteHolding);

module.exports = router;

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

// ── Real Upstox broker sync (per-user — separate from the manual tracker above) ──
router.get('/broker/connect', requireAuth, ctrl.connectBroker);
router.get('/broker/status', requireAuth, ctrl.brokerStatus);
router.delete('/broker', requireAuth, ctrl.disconnectBroker);
router.get('/broker/holdings', requireAuth, requireFeature('portfolio_tracker'), ctrl.realHoldings);
router.get('/broker/positions', requireAuth, requireFeature('portfolio_tracker'), ctrl.realPositions);
router.get('/broker/orders', requireAuth, requireFeature('portfolio_tracker'), ctrl.realOrders);

module.exports = router;

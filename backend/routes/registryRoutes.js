// routes/registryRoutes.js — mounted at /api/market/registry (BEFORE /api/market in server.js).
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminCheck');
const { requireFeature } = require('../middleware/planCheck');
const { marketLimiter, adminLimiter } = require('../middleware/rateLimit');
const ctrl = require('../controllers/registryController');

// Everything requires a signed-in user (same gate as Analysis/Screener).
router.use(requireAuth);

router.get('/segments', marketLimiter, ctrl.getSegments);
router.get('/instruments', marketLimiter, ctrl.searchInstruments);
router.get('/underlyings', marketLimiter, ctrl.getUnderlyings);
router.get('/contracts', marketLimiter, ctrl.getContracts);
router.get('/instrument', marketLimiter, ctrl.getInstrument);
router.get('/quote', marketLimiter, ctrl.getQuote);
router.get('/quotes', marketLimiter, ctrl.getQuotes);
router.get('/candles', marketLimiter, ctrl.getCandles);
router.get('/analysis-context', marketLimiter, ctrl.getAnalysisContext);
router.get('/futures-basis', marketLimiter, ctrl.getBasis);
router.get('/accuracy', marketLimiter, ctrl.getAccuracy);

// Options data: Elite-only, same as the existing Options page.
router.get('/option-chain', requireFeature('options_analysis'), marketLimiter, ctrl.getOptionChain);
router.get('/option-greeks', requireFeature('options_analysis'), marketLimiter, ctrl.getOptionGreeks);

router.get('/watchlist', marketLimiter, ctrl.getWatchlist);
router.post('/watchlist', marketLimiter, ctrl.addWatch);
router.delete('/watchlist/:id', marketLimiter, ctrl.removeWatch);

// Admin
router.post('/admin/refresh', requireAdmin, adminLimiter, ctrl.adminRefresh);
router.post('/admin/evaluate', requireAdmin, adminLimiter, ctrl.adminEvaluate);
router.post('/admin/probe', requireAdmin, adminLimiter, ctrl.adminProbe);
router.get('/admin/status', requireAdmin, adminLimiter, ctrl.adminStatus);
router.get('/admin/audit', requireAdmin, adminLimiter, ctrl.adminAudit);

module.exports = router;

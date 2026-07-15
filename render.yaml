// routes/watchlistRoutes.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { validateAddWatchlist } = require('../middleware/validate');
const ctrl = require('../controllers/watchlistController');

// FIX: added input validation
router.get('/', requireAuth, ctrl.getWatchlist);
router.post('/', requireAuth, validateAddWatchlist, ctrl.addToWatchlist);
router.delete('/:id', requireAuth, ctrl.removeFromWatchlist);

module.exports = router;

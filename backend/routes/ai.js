const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');

// ⚠️ Replace this with however your app currently authenticates other
// protected routes (e.g. '../middleware/authMiddleware', or wherever your
// /api/portfolio and /api/watchlist routes get req.user from). The name
// `protect` is a placeholder — swap it for your real middleware.
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

router.post('/analyze', aiController.analyzeStock);
router.post('/insight', aiController.getInsight);
router.post('/chat', aiController.chat);

module.exports = router;

// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const { authLimiter } = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/authMiddleware');
const { validateSignup, validateLogin, validateGoogleLogin, validateForgotPassword, validateResetPassword } = require('../middleware/validate');
const ctrl = require('../controllers/authController');

// UPDATED: email/password auth disabled — Google Sign-In only, so the app
// no longer needs SMTP configured at all. Routes + controller functions are
// left in place (commented out here) in case you want to re-enable email
// auth later; nothing else in the codebase depends on these being active.
// router.post('/signup', authLimiter, validateSignup, ctrl.signup);
// router.post('/login', authLimiter, validateLogin, ctrl.login);
router.post('/google', authLimiter, validateGoogleLogin, ctrl.googleLogin);
// router.post('/forgot-password', authLimiter, validateForgotPassword, ctrl.forgotPassword);
// router.post('/reset-password', authLimiter, validateResetPassword, ctrl.resetPassword);
router.post('/refresh', ctrl.refresh);
router.post('/logout', ctrl.logout);

router.get('/me', requireAuth, ctrl.getMe);
router.get('/sessions', requireAuth, ctrl.listSessions);
router.delete('/sessions/:id', requireAuth, ctrl.revokeSession);

module.exports = router;

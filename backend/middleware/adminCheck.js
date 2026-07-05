// middleware/adminCheck.js
const AppError = require('../utils/AppError');

/** Must be used AFTER requireAuth — relies on req.user being set. */
function requireAdmin(req, res, next) {
  if (!req.user) return next(new AppError('Not authenticated.', 401));
  if (!req.user.is_admin) return next(new AppError('Admin access required.', 403));
  next();
}

module.exports = { requireAdmin };

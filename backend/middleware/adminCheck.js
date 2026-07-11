// ⚠️ Only add this file if middleware/adminCheck.js does not already exist.
// Assumes your existing auth middleware has already set req.user with a
// `role` field. Adjust the field name if your User schema differs.

const AppError = require('../utils/AppError');

module.exports = function adminCheck(req, res, next) {
  if (!req.user) {
    return next(new AppError('Not authenticated', 401));
  }
  if (req.user.role !== 'admin') {
    return next(new AppError('Admin access required', 403));
  }
  next();
};

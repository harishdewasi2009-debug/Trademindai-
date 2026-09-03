// middleware/errorHandler.js
const { config } = require('../config');

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const isOperational = err.isOperational === true;

  if (!isOperational) {
    console.error('[UNHANDLED ERROR]', err);
  }

  // FIX: never leak stack traces or internal error details in production
  res.status(statusCode).json({
    error: isOperational ? err.message : 'Something went wrong. Please try again.',
    ...(config.nodeEnv !== 'production' && !isOperational ? { stack: err.stack } : {}),
  });
}

function notFoundHandler(req, res) {
  // FIX: don't echo back the full URL (avoids reflected XSS via URL)
  res.status(404).json({ error: 'Route not found.' });
}

module.exports = { errorHandler, notFoundHandler };

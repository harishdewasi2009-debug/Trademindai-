// utils/AppError.js
// Use this for any expected/operational error (bad input, not found, unauthorized).
// The global error handler in server.js checks `err.isOperational` to decide
// whether to leak the message to the client or hide it behind a generic 500.
class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;

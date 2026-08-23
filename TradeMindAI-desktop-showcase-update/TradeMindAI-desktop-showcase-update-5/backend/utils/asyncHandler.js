// Wraps an async route handler so rejected promises are passed to next(err)
// instead of crashing the process / hanging the request.
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;

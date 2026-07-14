# Files referenced but not included in this upload batch

The code as uploaded `require()`s a few files that were never provided in
any of your uploads, so the server **will not boot** until you add them:

- `utils/jwt.js` — exports `signAccessToken`, `signRefreshToken`,
  `verifyAccessToken`, `verifyRefreshToken` (used by `authMiddleware.js`,
  `authController.js`, `server.js`)
- `utils/AppError.js` — the custom error class thrown everywhere
  (`new AppError(message, statusCode)`)
- `utils/asyncHandler.js` — the `asyncHandler(fn)` wrapper used in every
  controller/middleware to forward rejected promises to Express's error
  handler
- `middleware/adminCheck.js` — exports `requireAdmin`, used by
  `routes/adminRoutes.js` and `routes/marketRoutes.js`
- `controllers/aiController.js` — `routes/aiRoutes.js` was included but its
  controller file wasn't in the upload, so `/api/ai/*` routes will fail to
  resolve
- `.env` / `.env.example` — not uploaded; `server.js` calls
  `assertRequiredEnv()` at startup and will `process.exit(1)` without the
  required variables listed in `config/index.js` and `README.md`

Everything else referenced by `require()` across the uploaded files is
present in this folder. Send these five and the zip will be a complete,
runnable backend.

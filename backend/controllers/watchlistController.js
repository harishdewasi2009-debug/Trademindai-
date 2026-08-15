// controllers/watchlistController.js
const { query } = require('../db/pool');
const { getPlan } = require('../config/plans');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

const WATCHLIST_LIMITS = { free: 5, basic: 10, pro: 50, elite: Infinity };

// ── GET /api/watchlist ──
const getWatchlist = asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM watchlist WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json({ watchlist: rows, limit: WATCHLIST_LIMITS[req.user.plan] ?? 5 });
});

// ── POST /api/watchlist ──
const addToWatchlist = asyncHandler(async (req, res) => {
  const { stockSymbol, stockName, alertPrice, alertDirection } = req.body;
  if (!stockSymbol) throw new AppError('stockSymbol is required.', 400);

  const limit = WATCHLIST_LIMITS[req.user.plan] ?? 5;
  const { rows: countRows } = await query('SELECT COUNT(*)::int AS count FROM watchlist WHERE user_id = $1', [req.user.id]);
  if (countRows[0].count >= limit) {
    throw new AppError(`Your ${getPlan(req.user.plan).name} plan allows up to ${limit} watchlist stocks. Upgrade for more.`, 403);
  }

  const { rows } = await query(
    `INSERT INTO watchlist (user_id, stock_symbol, stock_name, alert_price, alert_direction)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, stock_symbol) DO UPDATE SET alert_price = $4, alert_direction = $5
     RETURNING *`,
    [req.user.id, stockSymbol.toUpperCase(), stockName, alertPrice || null, alertDirection || null]
  );
  res.status(201).json({ item: rows[0] });
});

// ── DELETE /api/watchlist/:id ──
const removeFromWatchlist = asyncHandler(async (req, res) => {
  const { rowCount } = await query('DELETE FROM watchlist WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rowCount) throw new AppError('Watchlist item not found.', 404);
  res.json({ message: 'Removed from watchlist.' });
});

module.exports = { getWatchlist, addToWatchlist, removeFromWatchlist };

// controllers/portfolioController.js
const { query } = require('../db/pool');
const AppError = require('../utils/AppError');
const asyncHandler = require('../utils/asyncHandler');

// ── GET /api/portfolio ──
const getPortfolio = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, stock_symbol, stock_name, quantity, buy_price, current_price, sector, created_at
     FROM portfolios WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );

  let totalInvested = 0, totalValue = 0;
  const holdings = rows.map((h) => {
    const invested = Number(h.quantity) * Number(h.buy_price);
    const value = Number(h.quantity) * Number(h.current_price || h.buy_price);
    totalInvested += invested;
    totalValue += value;
    return {
      ...h,
      invested,
      value,
      pnl: value - invested,
      pnlPct: invested ? ((value - invested) / invested) * 100 : 0,
    };
  });

  const sectorMap = {};
  holdings.forEach((h) => {
    const sector = h.sector || 'Other';
    sectorMap[sector] = (sectorMap[sector] || 0) + h.value;
  });
  const sectorAllocation = Object.entries(sectorMap).map(([sector, value]) => ({
    sector,
    value,
    pct: totalValue ? (value / totalValue) * 100 : 0,
  }));

  res.json({
    holdings,
    summary: {
      totalInvested,
      totalValue,
      totalPnl: totalValue - totalInvested,
      totalPnlPct: totalInvested ? ((totalValue - totalInvested) / totalInvested) * 100 : 0,
      holdingsCount: holdings.length,
    },
    sectorAllocation,
  });
});

// ── POST /api/portfolio ── (add holding)
const addHolding = asyncHandler(async (req, res) => {
  const { stockSymbol, stockName, quantity, buyPrice, sector } = req.body;
  if (!stockSymbol || !quantity || !buyPrice) {
    throw new AppError('stockSymbol, quantity, and buyPrice are required.', 400);
  }
  if (quantity <= 0 || buyPrice <= 0) throw new AppError('Quantity and buy price must be positive.', 400);

  const { rows } = await query(
    `INSERT INTO portfolios (user_id, stock_symbol, stock_name, quantity, buy_price, current_price, sector)
     VALUES ($1, $2, $3, $4, $5, $5, $6) RETURNING *`,
    [req.user.id, stockSymbol.toUpperCase(), stockName, quantity, buyPrice, sector]
  );
  res.status(201).json({ holding: rows[0] });
});

// ── PUT /api/portfolio/:id ──
const updateHolding = asyncHandler(async (req, res) => {
  const { quantity, buyPrice, currentPrice } = req.body;
  const { rows } = await query(
    `UPDATE portfolios SET
       quantity = COALESCE($1, quantity),
       buy_price = COALESCE($2, buy_price),
       current_price = COALESCE($3, current_price)
     WHERE id = $4 AND user_id = $5 RETURNING *`,
    [quantity, buyPrice, currentPrice, req.params.id, req.user.id]
  );
  if (!rows.length) throw new AppError('Holding not found.', 404);
  res.json({ holding: rows[0] });
});

// ── DELETE /api/portfolio/:id ──
const deleteHolding = asyncHandler(async (req, res) => {
  const { rowCount } = await query('DELETE FROM portfolios WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rowCount) throw new AppError('Holding not found.', 404);
  res.json({ message: 'Holding removed.' });
});

// ─────────────────────────────────────────────────────────────────────────
//  REAL UPSTOX BROKER SYNC — per-user, separate from the manual tracker
//  above. Requires the individual user to connect their own Upstox account.
// ─────────────────────────────────────────────────────────────────────────
const userBrokerService = require('../services/userBrokerService');

// ── GET /api/portfolio/broker/connect  (requireAuth) ─────────────────────
// Returns the Upstox login URL as JSON rather than redirecting directly —
// the frontend fetches this with its normal Bearer-authenticated apiFetch,
// then navigates the browser to the returned URL itself. A direct redirect
// here would rely on the httpOnly cookie instead, which is SameSite=Strict
// in production and won't be sent on a cross-site browser navigation
// (frontend and backend are on different domains — Netlify vs Render).
const connectBroker = asyncHandler(async (req, res) => {
  const url = userBrokerService.buildUserConnectUrl(req.user.id);
  res.json({ url });
});

// ── GET /api/portfolio/broker/status  (requireAuth) ───────────────────────
const brokerStatus = asyncHandler(async (req, res) => {
  const status = await userBrokerService.getUserStatus(req.user.id);
  res.json(status);
});

// ── DELETE /api/portfolio/broker  (requireAuth) — disconnect ─────────────
const disconnectBroker = asyncHandler(async (req, res) => {
  await query(`DELETE FROM user_broker_tokens WHERE user_id = $1 AND provider = 'upstox'`, [req.user.id]);
  res.json({ message: 'Upstox account disconnected.' });
});

// ── GET /api/portfolio/broker/holdings  (requireAuth) ─────────────────────
const realHoldings = asyncHandler(async (req, res) => {
  const holdings = await userBrokerService.getRealHoldings(req.user.id);
  res.json({ holdings });
});

// ── GET /api/portfolio/broker/positions  (requireAuth) ────────────────────
const realPositions = asyncHandler(async (req, res) => {
  const positions = await userBrokerService.getRealPositions(req.user.id);
  res.json({ positions });
});

// ── GET /api/portfolio/broker/orders  (requireAuth) ───────────────────────
const realOrders = asyncHandler(async (req, res) => {
  const orders = await userBrokerService.getRealOrders(req.user.id);
  res.json({ orders });
});

module.exports = {
  getPortfolio, addHolding, updateHolding, deleteHolding,
  connectBroker, brokerStatus, disconnectBroker,
  realHoldings, realPositions, realOrders,
};

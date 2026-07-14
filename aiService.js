// services/userBrokerService.js
// ══════════════════════════════════════════════════════════════════════════
//  PER-USER Upstox broker connection — real Holdings, Positions, and Orders
//  synced straight from each trader's own Upstox account.
//
//  This is intentionally a SEPARATE flow from marketDataService.js's OAuth:
//   - marketDataService.js  → ONE admin token → powers market data (quotes,
//                              candles, option chain) for every visitor.
//   - userBrokerService.js  → EACH user's own token → powers only THEIR
//                              real holdings/positions/orders, visible only
//                              to them.
//
//  Both flows share the same Upstox APP (same UPSTOX_API_KEY/SECRET) and the
//  same registered redirect_uri — Upstox only allows one redirect_uri per
//  app, so we distinguish "this is a user connecting their own portfolio"
//  from "this is the admin connecting market data" using a signed `state`
//  param round-tripped through the OAuth flow, not a second redirect_uri.
//
//  Like the admin token, each user's Upstox token expires ~3:30am IST daily
//  — there is no special automation for this per-user (Upstox has no bulk/
//  automated way to refresh thousands of individual users' tokens). Each
//  trader simply reconnects with one click when their session shows
//  "disconnected", the same way they'd log into Upstox's own app each day.
// ══════════════════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');
const { config } = require('../config');
const { query } = require('../db/pool');
const AppError = require('../utils/AppError');

const BASE_V2 = 'https://api.upstox.com/v2';
const STATE_PURPOSE = 'upstox_user_broker_connect';

function assertConfigured() {
  if (!config.upstox.apiKey || !config.upstox.apiSecret) {
    throw new AppError('Upstox is not configured on this server.', 501);
  }
  if (!config.upstox.redirectUri) {
    throw new AppError('UPSTOX_REDIRECT_URI is not set.', 501);
  }
}

/** ~3:25am IST tomorrow, expressed as a UTC Date — same expiry rule as the admin token. */
function nextUpstoxExpiry() {
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const istExpiry = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + 1, 3, 25, 0));
  return new Date(istExpiry.getTime() - 5.5 * 60 * 60 * 1000);
}

/**
 * Builds the URL a USER visits to connect their own Upstox account. The
 * `state` param carries a short-lived signed token identifying which user
 * initiated this — verified in handleUserCallback() so the callback route
 * (shared with the admin's market-data OAuth) knows to treat this as a
 * per-user portfolio connection, not the admin market-data one.
 */
function buildUserConnectUrl(userId) {
  assertConfigured();
  const state = jwt.sign({ purpose: STATE_PURPOSE, userId }, config.jwt.secret, { expiresIn: '15m' });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.upstox.apiKey,
    redirect_uri: config.upstox.redirectUri,
    state,
  });
  return `${BASE_V2}/login/authorization/dialog?${params.toString()}`;
}

/** Returns the userId if `state` is a valid, unexpired per-user connect token — otherwise null. */
function decodeUserConnectState(state) {
  if (!state) return null;
  try {
    const payload = jwt.verify(state, config.jwt.secret);
    return payload.purpose === STATE_PURPOSE ? payload.userId : null;
  } catch {
    return null; // expired/invalid/tampered — treat as "not a user-connect callback"
  }
}

/** Exchanges the OAuth code for a token and stores it against this specific user. */
async function handleUserCallback(code, userId) {
  assertConfigured();
  if (!code) throw new AppError('Missing authorization code from Upstox redirect.', 400);

  const res = await fetch(`${BASE_V2}/login/authorization/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.upstox.apiKey,
      client_secret: config.upstox.apiSecret,
      redirect_uri: config.upstox.redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new AppError(`Upstox token exchange failed: ${errText.slice(0, 200)}`, 502);
  }
  const data = await res.json();
  if (!data.access_token) throw new AppError('Upstox did not return an access token.', 502);

  const expiresAt = nextUpstoxExpiry();
  await query(
    `INSERT INTO user_broker_tokens (user_id, provider, access_token, expires_at)
     VALUES ($1, 'upstox', $2, $3)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       expires_at   = EXCLUDED.expires_at,
       created_at   = now()`,
    [userId, data.access_token, expiresAt]
  );

  return { connected: true, expiresAt };
}

async function getUserStatus(userId) {
  const { rows } = await query(
    `SELECT expires_at FROM user_broker_tokens WHERE user_id = $1 AND provider = 'upstox'`,
    [userId]
  );
  if (!rows.length) return { connected: false };
  const expiresAt = new Date(rows[0].expires_at);
  return { connected: expiresAt > new Date(), expiresAt };
}

async function getUserAccessToken(userId) {
  const { rows } = await query(
    `SELECT access_token, expires_at FROM user_broker_tokens WHERE user_id = $1 AND provider = 'upstox'`,
    [userId]
  );
  if (!rows.length) {
    throw new AppError('Your Upstox account is not connected. Connect it to see real holdings/positions/orders.', 403);
  }
  if (new Date(rows[0].expires_at) <= new Date()) {
    throw new AppError('Your Upstox connection has expired for today (they expire daily ~3:30am IST). Please reconnect.', 401);
  }
  return rows[0].access_token;
}

async function upstoxGet(path, accessToken) {
  const res = await fetch(`${BASE_V2}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new AppError(`Upstox request failed (${path}): ${errText.slice(0, 200)}`, 502);
  }
  const json = await res.json();
  return json.data || [];
}

/** Real long-term holdings from the user's own Upstox DEMAT account. */
async function getRealHoldings(userId) {
  const token = await getUserAccessToken(userId);
  const data = await upstoxGet('/portfolio/long-term-holdings', token);
  return data.map((h) => ({
    symbol: h.tradingsymbol,
    isin: h.isin,
    exchange: h.exchange,
    quantity: h.quantity,
    avgPrice: h.average_price,
    lastPrice: h.last_price,
    closePrice: h.close_price,
    pnl: h.pnl,
    dayChange: h.day_change,
    dayChangePct: h.day_change_percentage,
  }));
}

/** Real intraday/short-term positions (open today, or carried F&O). */
async function getRealPositions(userId) {
  const token = await getUserAccessToken(userId);
  const data = await upstoxGet('/portfolio/short-term-positions', token);
  return data.map((p) => ({
    symbol: p.tradingsymbol,
    exchange: p.exchange,
    product: p.product,
    quantity: p.quantity,
    avgPrice: p.average_price,
    lastPrice: p.last_price,
    pnl: p.pnl,
    unrealised: p.unrealised,
    realised: p.realised,
    buyQty: p.buy_quantity,
    sellQty: p.sell_quantity,
  }));
}

/** Real order book — every order placed today via the user's own Upstox account. */
async function getRealOrders(userId) {
  const token = await getUserAccessToken(userId);
  const data = await upstoxGet('/order/retrieve-all', token);
  return data.map((o) => ({
    orderId: o.order_id,
    symbol: o.tradingsymbol,
    exchange: o.exchange,
    transactionType: o.transaction_type,
    orderType: o.order_type,
    product: o.product,
    quantity: o.quantity,
    price: o.price,
    status: o.status,
    orderTimestamp: o.order_timestamp,
  }));
}

module.exports = {
  buildUserConnectUrl,
  decodeUserConnectState,
  handleUserCallback,
  getUserStatus,
  getRealHoldings,
  getRealPositions,
  getRealOrders,
};

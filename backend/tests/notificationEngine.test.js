// Engine orchestration test: DB + market data + delivery are stubbed (no Postgres / Upstox needed).
// Verifies WHAT gets notified, to WHOM, with which dedupe keys — the SQL itself is exercised on deploy.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };

const calls = { notifyUser: [], broadcast: [] };
let dbRows = {};
let quoteMap = {};

stub('../db/pool', { query: async (sql) => {
  if (/FROM watchlist w LEFT JOIN/.test(sql)) return { rows: dbRows.watchlist || [] };
  if (/FROM portfolios h LEFT JOIN/.test(sql)) return { rows: dbRows.portfolio || [] };
  if (/FROM scanner_signal_history/.test(sql)) return { rows: dbRows.signals || [] };
  if (/SELECT DISTINCT x.user_id/.test(sql)) return { rows: dbRows.owners || [] };
  return { rows: [] };
} });
stub('../services/notificationService', {
  notifyUser: async (userId, n, opts) => { calls.notifyUser.push({ userId, n, opts }); return { id: 'x' }; },
  broadcast: async (n, filter, params) => { calls.broadcast.push({ n, filter, params }); return ['u1']; },
});
// Mirrors real resolution: no exchange given → NSE first, then BSE.
const lookup = (e) => (e.exchange ? quoteMap[`${e.exchange}:${e.symbol}`] : quoteMap[`NSE_EQ:${e.symbol}`] || quoteMap[`BSE_EQ:${e.symbol}`]);
stub('../services/marketDataService', {
  isIndianMarketOpen: () => true,
  getLtpBatch: async (entries) => ({
    quotes: entries.map(lookup).filter(Boolean),
    errors: entries.filter((e) => !lookup(e)).map((e) => ({ symbol: e.symbol })),
  }),
  listAllSymbols: async () => ({ items: [] }),
});
stub('../utils/tradingCalendar', { isTradingDay: () => true });

const engine = require('../services/notificationEngine');
const q = (symbol, changePct, lastPrice = 100, exchange = 'NSE_EQ') => ({ symbol, exchange, lastPrice, changePct });
const reset = () => { calls.notifyUser = []; calls.broadcast = []; dbRows = {}; quoteMap = {}; };

test('personal scan: price alert, watchlist move, portfolio move + P&L milestone', async () => {
  reset();
  dbRows.watchlist = [{ id: 'w1', user_id: 'U1', symbol: 'TCS', exchange: null, alert_price: 3500, alert_direction: 'above', want_watchlist: true, want_price: true, thr: 3, in_app: true }];
  dbRows.portfolio = [{ id: 'p1', user_id: 'U1', symbol: 'INFY', exchange: null, buy_price: 1000, want_portfolio: true, thr: 3, in_app: true }];
  quoteMap['NSE_EQ:TCS'] = q('TCS', 6.2, 3550);
  quoteMap['NSE_EQ:INFY'] = q('INFY', -3.4, 1250); // down today but +25% on buy price

  await engine.runPersonalScan();
  const byType = Object.fromEntries(calls.notifyUser.map((c) => [c.n.type, c]));
  assert.ok(byType.price_alert, 'price alert fired');
  assert.match(byType.price_alert.n.dedupeKey, /^price:w1:above:3500$/);
  assert.equal(byType.price_alert.opts.email, true);
  assert.equal(byType.watchlist_move.n.data.level, 5);
  assert.equal(byType.watchlist_move.n.severity, 'green');
  assert.equal(byType.portfolio_move.n.data.level, 3);
  assert.equal(byType.portfolio_move.n.severity, 'red');
  assert.equal(byType.portfolio_pnl.n.data.level, 20);
  assert.match(byType.portfolio_pnl.n.dedupeKey, /^pnl:p1:up:20$/);
});

test('personal scan: respects user threshold + switched-off categories', async () => {
  reset();
  dbRows.watchlist = [{ id: 'w1', user_id: 'U1', symbol: 'TCS', exchange: null, alert_price: null, alert_direction: null, want_watchlist: true, want_price: true, thr: 7, in_app: true }];
  dbRows.portfolio = [{ id: 'p1', user_id: 'U2', symbol: 'TCS', exchange: null, buy_price: 100, want_portfolio: false, thr: 3, in_app: true }];
  quoteMap['NSE_EQ:TCS'] = q('TCS', 6.2, 100);
  await engine.runPersonalScan();
  assert.equal(calls.notifyUser.length, 0); // 6.2% < user's 7% threshold; portfolio muted

  // control: same data, threshold 5 → the watchlist alert DOES fire (proves the quote was reachable)
  dbRows.watchlist[0].thr = 5;
  await engine.runPersonalScan();
  assert.equal(calls.notifyUser.length, 1);
  assert.equal(calls.notifyUser[0].n.type, 'watchlist_move');
});

test('market scan: top mover + sector heat broadcasts with correct filters', async () => {
  reset();
  for (const s of ['TCS', 'INFY', 'WIPRO', 'HCLTECH']) quoteMap[`NSE_EQ:${s}`] = q(s, 3.4 + (s === 'WIPRO' ? 3 : 0));
  quoteMap['NSE_EQ:SBIN'] = q('SBIN', 0.4);
  await engine.runMarketScan();
  const movers = calls.broadcast.filter((c) => c.n.type === 'top_mover');
  const sectors = calls.broadcast.filter((c) => c.n.type === 'sector_heat');
  assert.ok(movers.length >= 4);
  const wipro = movers.find((m) => m.n.symbol === 'WIPRO');
  assert.equal(wipro.n.data.level, 5);                       // 6.4% → 5% milestone
  assert.deepEqual(wipro.params, [5]);
  assert.match(wipro.filter, /move_threshold/);
  assert.equal(sectors.length, 1);
  assert.equal(sectors[0].n.data.sector, 'IT');
  assert.match(sectors[0].n.title, /IT sector heating up/);
  assert.ok(!movers.some((m) => m.n.symbol === 'SBIN'));      // 0.4% — below first milestone
});

test('screener scan: owners get personal alert; universe stocks broadcast once, owners excluded', async () => {
  reset();
  dbRows.signals = [
    { id: 's1', stock_symbol: 'TCS', exchange: 'NSE_EQ', signal: 'strong_bullish', strength_score: 88 },
    { id: 's2', stock_symbol: 'ZZSMALLCAP', exchange: 'BSE_EQ', signal: 'strong_bullish', strength_score: 95 }, // not in curated universe
  ];
  dbRows.owners = [{ user_id: 'U1' }];
  const r = await engine.runScreenerScan();
  assert.equal(calls.notifyUser.length, 2 * 1); // 2 signals × 1 owner each (stubbed owners query returns same rows)
  const mkt = calls.broadcast;
  assert.equal(mkt.length, 1);                  // only TCS is market-wide; illiquid smallcap is not
  assert.equal(mkt[0].n.symbol, 'TCS');
  assert.match(mkt[0].n.dedupeKey, /:mkt$/);
  assert.match(mkt[0].filter, /NOT EXISTS/);
  assert.match(mkt[0].n.title, /strong bullish/);
  assert.equal(r.market, 1);
  // second run: already handled in-memory → nothing new
  calls.notifyUser = []; calls.broadcast = [];
  await engine.runScreenerScan();
  assert.equal(calls.notifyUser.length + calls.broadcast.length, 0);
});

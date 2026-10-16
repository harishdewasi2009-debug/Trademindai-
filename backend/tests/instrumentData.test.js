// Integration-style test of services/instrumentData.js with the DB, registry and
// Upstox HTTP layer replaced by in-memory stubs (no network, no Postgres).
// The stub payloads are shaped like Upstox responses purely to exercise the logic.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
const stubs = {};
const abs = (rel) => require.resolve(path.join(root, rel));

// Pre-seed require cache with stubs for the three I/O modules.
function stub(rel, exportsObj) {
  const id = abs(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
  stubs[rel] = exportsObj;
}

const INST = { instrumentKey: 'NSE_EQ|INE1', symbol: 'ABC', displayName: 'ABC LTD', segment: 'NSE_EQ', assetClass: 'equity', accessStatus: 'VERIFIED', expiry: null };
const store = new Map(); // market_last_quote

stub('db/pool.js', {
  query: async (sql, params) => {
    if (/INSERT INTO market_last_quote/.test(sql)) { store.set(params[0], { payload: JSON.parse(params[4]), trade_time: params[3], saved_at: new Date() }); return { rows: [], rowCount: 1 }; }
    if (/FROM market_last_quote/.test(sql)) { const r = store.get(params[0]); return { rows: r ? [r] : [] }; }
    if (/FROM market_registry/.test(sql)) return { rows: [{ instrument_key: INST.instrumentKey }] };
    return { rows: [] };
  },
});
stub('services/upstoxRegistry.js', { ensureSchema: async () => {}, getInstrument: async (k) => (k === INST.instrumentKey ? { ...INST } : null) });

let upstream = () => ({ ok: false, status: 503, error: 'down', kind: 'error' });
stub('services/upstoxHttp.js', { upstoxGet: async (p, params) => upstream(p, params), logError: () => {}, recentErrors: () => [] });

const svc = require(abs('services/instrumentData.js'));
test.beforeEach(() => svc._resetCachesForTests());

const nowMs = Date.now();
const liveQuote = (price, ageMs = 1000) => ({
  ok: true, status: 200,
  data: { data: { 'NSE_EQ:ABC': { instrument_token: 'NSE_EQ|INE1', last_price: price, net_change: 2, ohlc: { open: 100, high: 110, low: 99, close: 105 }, volume: 5000, last_trade_time: String(nowMs - ageMs) } } },
});
const statusOpen = { ok: true, status: 200, data: { data: { status: 'NORMAL_OPEN' } } };
const statusClosed = { ok: true, status: 200, data: { data: { status: 'NORMAL_CLOSE' } } };

test('live quote: market open + fresh trade → real-time, persisted for later', async () => {
  upstream = (p) => (p.includes('/market/status') ? statusOpen : liveQuote(104));
  const r = await svc.getQuote('NSE_EQ|INE1');
  assert.equal(r.source, 'Upstox');
  assert.equal(r.quote.lastPrice, 104);
  assert.equal(r.quote.previousClose, 102);
  assert.equal(r.freshness.mode, 'real-time');
  assert.equal(r.market.source, 'upstox-market-status-api');
  assert.equal(r.fromStore, false);
  assert.ok(store.has('NSE_EQ|INE1'));
});

test('upstream failure → serves LAST VALID stored quote with its own timestamp, never zero/fabricated', async () => {
  // first populate the store via a live quote, then fail upstream
  upstream = (p) => (p.includes('/market/status') ? statusOpen : liveQuote(104));
  await svc.getQuote('NSE_EQ|INE1');
  svc._resetCachesForTests();
  upstream = (p) => (p.includes('/market/status') ? statusClosed : { ok: false, status: 503, error: 'Upstox down', kind: 'error' });
  const r = await svc.getQuote('NSE_EQ|INE1');
  assert.equal(r.fromStore, true);
  assert.equal(r.quote.lastPrice, 104);            // retained, not reset
  assert.equal(r.freshness.mode, 'last-close');    // closed market
  assert.equal(r.liveError, 'Upstox down');
  assert.ok(r.tradeTime);
});

test('unknown instrument is rejected (only verified registry instruments are served)', async () => {
  await assert.rejects(() => svc.getQuote('NSE_EQ|NOPE'), /not in the verified Upstox registry/);
});

test('no live quote and nothing stored → honest error, not a fake price', async () => {
  store.clear();
  upstream = (p) => (p.includes('/market/status') ? statusClosed : { ok: true, status: 200, data: { data: {} } });
  await assert.rejects(() => svc.getQuote('NSE_EQ|INE1'), /no quote/i);
});

function candleRows(n, startPrice = 100) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(2026, 0, 1) + i * 86400e3);
    const c = startPrice + i * 0.5;
    rows.push([d.toISOString().replace('Z', '+00:00'), c - 0.2, c + 1, c - 1, c, 1000 + i, 0]);
  }
  return rows.reverse(); // Upstox sends newest-first
}

test('candles: normalized oldest-first, indicators aligned, stamped with source and mode', async () => {
  upstream = (p) => {
    if (p.includes('/market/status')) return statusClosed;
    if (p.includes('/intraday/')) return { ok: true, status: 200, data: { data: { candles: [] } } };
    return { ok: true, status: 200, data: { data: { candles: candleRows(80) } } };
  };
  const r = await svc.getCandles('NSE_EQ|INE1', { unit: 'days', interval: 1 });
  assert.equal(r.meta.source, 'Upstox');
  assert.equal(r.candles.length, 80);
  assert.ok(r.candles[0].time < r.candles[79].time);
  assert.equal(r.indicators.ema20.length, 80);
  assert.equal(r.indicators.ema20[18], null);
  assert.notEqual(r.indicators.ema20[19], null);
  assert.equal(r.meta.dataMode, 'historical'); // market closed → historical, labelled
  assert.equal(r.meta.droppedMalformed, 0);
});

test('candles: invalid timeframe rejected before any upstream call', async () => {
  let called = false;
  upstream = () => { called = true; return { ok: false }; };
  await assert.rejects(() => svc.getCandles('NSE_EQ|INE1', { unit: 'minutes', interval: 999 }), /interval for minutes/);
  assert.equal(called, false);
});

test('candles: transient upstream failure serves the last good series and labels it', async () => {
  upstream = (p) => (p.includes('/market/status') ? statusClosed : { ok: true, status: 200, data: { data: { candles: candleRows(40, 200) } } });
  const good = await svc.getCandles('NSE_EQ|INE1', { unit: 'days', interval: 1, from: '2026-01-01', to: '2026-03-01' });
  assert.equal(good.meta.servedFromLastGood, false);

  svc._expireCandleCacheForTests(); // force a refetch, keep the last-good snapshot
  upstream = (p) => (p.includes('/market/status') ? statusClosed : { ok: false, status: 502, error: 'boom', kind: 'error' });
  const r = await svc.getCandles('NSE_EQ|INE1', { unit: 'days', interval: 1, from: '2026-01-01', to: '2026-03-01' });
  assert.equal(r.candles.length, 40);              // chart keeps its data, not reset to empty
  assert.equal(r.meta.servedFromLastGood, true);
  assert.equal(r.meta.dataMode, 'delayed');        // and it is honestly flagged
  assert.equal(r.meta.upstreamError, 'boom');
});

test('candles: upstream failure with no prior data is an honest error, not an empty/fake chart', async () => {
  upstream = (p) => (p.includes('/market/status') ? statusClosed : { ok: false, status: 502, error: 'boom', kind: 'error' });
  await assert.rejects(() => svc.getCandles('NSE_EQ|INE1', { unit: 'days', interval: 1 }), /Upstox candle request failed: boom/);
});

test('analysis context refuses to analyse with too few real candles', async () => {
  upstream = (p) => {
    if (p.includes('/market/status')) return statusClosed;
    if (p.includes('/quotes')) return { ok: true, status: 200, data: { data: {} } };
    return { ok: true, status: 200, data: { data: { candles: candleRows(10, 50) } } };
  };
  await assert.rejects(() => svc.getAnalysisContext('NSE_EQ|INE1', { unit: 'days', interval: 1 }), /not enough to compute indicators/);
});

test('analysis context carries source, as-of time, data mode and computed indicators', async () => {
  upstream = (p) => {
    if (p.includes('/market/status')) return statusClosed;
    if (p.includes('/quotes')) return liveQuote(130);
    if (p.includes('/intraday/')) return { ok: true, status: 200, data: { data: { candles: [] } } };
    return { ok: true, status: 200, data: { data: { candles: candleRows(120, 90) } } };
  };
  const ctx = await svc.getAnalysisContext('NSE_EQ|INE1', { unit: 'days', interval: 1 });
  assert.equal(ctx.dataSource, 'Upstox');
  assert.equal(ctx.dataMode, 'historical');
  assert.equal(ctx.candlesUsed, 120);
  assert.ok(typeof ctx.indicators.rsi14 === 'number');
  assert.ok(ctx.indicators.ema20 > 0 && ctx.indicators.atr14 > 0);
  assert.ok(ctx.asOf);
});

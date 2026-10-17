// Verified-outcome pipeline + instrument-key handling. DB, Upstox HTTP and the symbol resolver are
// replaced with in-memory stubs (no network, no Postgres); payloads are shaped like Upstox responses
// purely to exercise the logic.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const root = path.join(__dirname, '..');
const abs = (rel) => require.resolve(path.join(root, rel));
function stub(rel, exportsObj) {
  const id = abs(rel);
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}

const dbCalls = [];
let dueRows = [];
stub('db/pool.js', {
  query: async (sql, params) => {
    dbCalls.push({ sql, params });
    if (/FROM scanner_signal_history/.test(sql) && /SELECT id/.test(sql)) return { rows: dueRows };
    return { rows: [], rowCount: 1 };
  },
});
stub('db/autoMigrate.js', { ensure: async () => {} });

let upstream = () => ({ ok: false, status: 503, error: 'down', kind: 'error' });
const upstreamCalls = [];
stub('services/upstoxHttp.js', { upstoxGet: async (p, params) => { upstreamCalls.push({ p, params }); return upstream(p, params); }, logError: () => {}, recentErrors: () => [] });
stub('services/marketDataService.js', {
  resolveInstrumentKey: async (sym) => { if (sym === 'NOPE') throw new Error('Unknown or unsupported symbol: NOPE'); return `NSE_EQ|KEY_${sym}`; },
  isIndianMarketOpen: () => true,
});

const op = require(abs('services/outcomePrice.js'));
const scanner = require(abs('services/scannerAccuracyService.js'));

test.beforeEach(() => { dbCalls.length = 0; upstreamCalls.length = 0; dueRows = []; });

test('pickClose: last candle on/before the target; exact mode requires the exact day', () => {
  const c = [{ t: '2026-10-14T00:00:00+05:30', c: 10 }, { t: '2026-10-15T00:00:00+05:30', c: 11 }, { t: '2026-10-19T00:00:00+05:30', c: 99 }];
  assert.deepEqual(op.pickClose(c, '2026-10-16'), { date: '2026-10-15', price: 11 });
  assert.equal(op.pickClose(c, '2026-10-16', { exact: true }), null);
  assert.deepEqual(op.pickClose(c, '2026-10-15', { exact: true }), { date: '2026-10-15', price: 11 });
  assert.equal(op.pickClose(c, '2026-09-01'), null); // nothing within the lookback
});

test('splitKeyList keeps keys that contain commas intact', () => {
  assert.deepEqual(op.splitKeyList('NSE_EQ|INE1,NSE_INDEX|Nifty 50,GLOBAL_INDICATOR|A,B (x),MCX_FO|9'),
    ['NSE_EQ|INE1', 'NSE_INDEX|Nifty 50', 'GLOBAL_INDICATOR|A,B (x)', 'MCX_FO|9']);
});

test('instrument master rows: keys are trimmed, over-long values clipped, over-long keys skipped', () => {
  const { normalizeInstrument } = require('../utils/instrumentClassifier');
  const r = normalizeInstrument({ instrument_key: '  NSE_INDEX|Nifty 50 ', segment: 'NSE_INDEX', trading_symbol: 'X'.repeat(300), name: 'n', instrument_type: 'INDEX_WITH_A_VERY_LONG_TYPE' });
  assert.equal(r.instrument_key, 'NSE_INDEX|Nifty 50');
  assert.equal(r.symbol.length, 120);
  assert.equal(r.instrument_type.length, 20);
  assert.equal(normalizeInstrument({ instrument_key: 'NSE_EQ|' + 'K'.repeat(130), segment: 'NSE_EQ' }), null);
});

test('target day not over yet → ONE batched quote call for many instruments', async () => {
  upstream = (p, params) => {
    const keys = params.instrument_key.split(',');
    return { ok: true, status: 200, data: { data: Object.fromEntries(keys.map((k, i) => [k.replace('|', ':'), { instrument_token: k, last_price: 100 + i }])) } };
  };
  const items = ['A', 'B', 'C'].map((s) => ({ id: s, symbol: s, exchange: 'NSE_EQ', targetDate: '2026-10-19' }));
  const res = await op.fetchOutcomePrices(items, { today: '2026-10-19' });
  assert.equal(upstreamCalls.length, 1);
  assert.deepEqual([...res.values()].map((v) => v.price), [100, 101, 102]);
  assert.equal(res.get('A').source, 'quote');
});

test('target day already past → the real daily close of that day, on the stored instrument', async () => {
  upstream = () => ({ ok: true, status: 200, data: { data: { candles: [
    ['2026-10-19T00:00:00+05:30', 50, 56, 49, 55, 1000, 0],
    ['2026-10-16T00:00:00+05:30', 48, 51, 47, 50, 900, 0],
  ] } } });
  const res = await op.fetchOutcomePrices([{ id: 1, symbol: 'GOLD', exchange: 'MCX_FO', instrumentKey: 'MCX_FO|OLD_CONTRACT', targetDate: '2026-10-19', exact: true }], { today: '2026-10-25' });
  assert.equal(res.get(1).price, 55);
  assert.equal(res.get(1).source, 'daily-close');
  assert.match(upstreamCalls[0].p, /MCX_FO%7COLD_CONTRACT\/days\/1\/2026-10-19\//); // not re-resolved to the current contract
});

test('failures carry a reason instead of failing silently', async () => {
  upstream = () => ({ ok: false, status: 429, error: 'Upstox rate limit hit.', kind: 'rate_limited' });
  const res = await op.fetchOutcomePrices([
    { id: 'u', symbol: 'NOPE', exchange: 'NSE_EQ', targetDate: '2026-10-19' },
    { id: 'q', symbol: 'ABC', exchange: 'NSE_EQ', targetDate: '2026-10-19' },
  ], { today: '2026-10-19' });
  assert.match(res.get('u').error, /could not resolve instrument/);
  assert.match(res.get('q').error, /rate limit/);
});

test('scanner evaluation judges against the target-day close, batches the update, notes/gives up on unpriceable rows', async () => {
  const now = new Date('2026-11-09T11:00:00Z'); // Mon 16:30 IST
  dueRows = [
    { id: 'r1', stock_symbol: 'AAA', exchange: 'NSE_EQ', instrument_key: 'NSE_EQ|KEY_AAA', signal: 'strong_bullish', entry_price: '100', horizon_days: 1, signal_date: '2026-10-23' },
    { id: 'r2', stock_symbol: 'BBB', exchange: 'NSE_EQ', instrument_key: 'NSE_EQ|KEY_BBB', signal: 'strong_bearish', entry_price: '100', horizon_days: 1, signal_date: '2026-10-23' },
    { id: 'r3', stock_symbol: 'CCC', exchange: 'NSE_EQ', instrument_key: 'NSE_EQ|KEY_CCC', signal: 'strong_bullish', entry_price: '100', horizon_days: 1, signal_date: '2026-10-23' }, // no candle
    { id: 'r4', stock_symbol: 'DDD', exchange: 'NSE_EQ', instrument_key: 'NSE_EQ|KEY_DDD', signal: 'neutral', entry_price: '100', horizon_days: 1, signal_date: '2026-11-06' }, // no candle, recent
  ];
  upstream = (p) => {
    if (p.includes('KEY_AAA')) return { ok: true, status: 200, data: { data: { candles: [['2026-10-26T00:00:00+05:30', 100, 112, 99, 110, 1, 0]] } } };
    if (p.includes('KEY_BBB')) return { ok: true, status: 200, data: { data: { candles: [['2026-10-26T00:00:00+05:30', 100, 112, 99, 110, 1, 0]] } } };
    return { ok: true, status: 200, data: { data: { candles: [] } } };
  };
  const out = await scanner.evaluateDueScannerSignals({ now });
  assert.deepEqual(out, { evaluated: 2, failed: 2, unresolvable: 1 });
  const upd = dbCalls.find((c) => /SET actual_price_at_horizon/.test(c.sql));
  assert.deepEqual(upd.params[0], ['r1', 'r2']);
  assert.deepEqual(upd.params[2], ['correct', 'incorrect']); // bullish +10% ✔, bearish +10% ✘
  const gaveUp = dbCalls.find((c) => /'unresolvable'/.test(c.sql));
  assert.equal(gaveUp.params[0], 'r3');             // 14+ days past due, still no price
  assert.ok(dbCalls.some((c) => /SET eval_note/.test(c.sql) && c.params[0].includes('r4'))); // recent: stays pending with a reason
});

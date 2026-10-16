// tests/market.test.js — run with: npm test  (node --test, no extra deps)
// Fixtures here are ONLY inputs for parser/classifier tests (shaped like
// instrument-master rows). No test data is ever served by the app itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const { JsonArrayObjectScanner, streamGzipJsonArray } = require('../utils/jsonArrayStream');
const { normalizeInstrument, classifyAssetClass, parseExpiry, EXPECTED_SEGMENTS } = require('../utils/instrumentClassifier');
const ind = require('../utils/seriesIndicators');
const sess = require('../utils/marketSession');
const cu = require('../utils/candleUtils');

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/instrument-rows.test-fixture.json'), 'utf8'));

test('scanner emits every object even when chunks split mid-token', () => {
  const text = JSON.stringify(rows);
  const got = [];
  const s = new JsonArrayObjectScanner((o) => got.push(o));
  for (let i = 0; i < text.length; i += 7) s.push(text.slice(i, i + 7));
  assert.equal(got.length, rows.length);
  assert.equal(got[1].name, 'NIPPON NIFTY BEES {ETF}');
});

test('scanner handles escaped quotes and nested values', () => {
  const got = [];
  const s = new JsonArrayObjectScanner((o) => got.push(o));
  s.push('[{"a":"he said \\"hi\\" }","b":{"c":[1,2,{"d":3}]}},{"a":"x"}]');
  assert.equal(got.length, 2);
  assert.equal(got[0].b.c[2].d, 3);
});

test('streamGzipJsonArray batches gzipped input with bounded batch size', async () => {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(rows)));
  const batches = [];
  const total = await streamGzipJsonArray(Readable.from([gz]), async (b) => { batches.push(b.length); }, { batchSize: 4 });
  assert.equal(total, rows.length);
  assert.ok(batches.every((n) => n <= 4));
});

test('classifier derives asset classes from segment/type only', () => {
  const byKey = Object.fromEntries(rows.map(normalizeInstrument).filter(Boolean).map((r) => [r.instrument_key, r]));
  assert.equal(byKey['NSE_EQ|INE002A01018'].asset_class, 'equity');
  assert.equal(byKey['NSE_EQ|INF204KB14I2'].asset_class, 'etf');
  assert.equal(byKey['NSE_INDEX|Nifty 50'].asset_class, 'index');
  assert.equal(byKey['NSE_FO|12345'].asset_class, 'option');
  assert.equal(byKey['NSE_FO|12346'].asset_class, 'future');
  assert.equal(byKey['NCD_FO|555'].asset_class, 'currency_future');
  assert.equal(byKey['MCX_FO|777'].asset_class, 'commodity_future');
  assert.equal(byKey['GLOBAL_INDEX|DOW'].asset_class, 'global_index');
});

test('currency is only stated where the segment implies it (never guessed for global)', () => {
  const r = rows.map(normalizeInstrument).filter(Boolean);
  assert.equal(r.find((x) => x.segment === 'NSE_EQ').currency, 'INR');
  assert.equal(r.find((x) => x.segment === 'GLOBAL_INDEX').currency, null);
});

test('rows without an instrument_key are rejected, expiry parses from ms (number or string)', () => {
  assert.equal(normalizeInstrument({ name: 'x' }), null);
  assert.equal(parseExpiry(1790000000000), parseExpiry('1790000000000'));
  assert.equal(parseExpiry(''), null);
  assert.equal(parseExpiry('abc'), null);
});

test('expected-segment list covers the brief; unknown segments classify as other', () => {
  for (const s of ['NSE_EQ', 'BSE_EQ', 'NSE_FO', 'MCX_FO', 'GLOBAL_INDEX', 'GLOBAL_INDICATOR']) assert.ok(EXPECTED_SEGMENTS.includes(s));
  assert.equal(classifyAssetClass('SOMETHING_NEW', null, 'x'), 'other');
});

const mk = (closes) => closes.map((c, i) => ({ t: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T09:15:00+05:30`, o: c, h: c + 1, l: c - 1, c, v: 100 }));

test('SMA/EMA are null during warm-up and correct afterwards', () => {
  const v = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(ind.sma(v, 3), [null, null, 2, 3, 4, 5]);
  const e = ind.ema(v, 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  assert.equal(e[2], 2);
  assert.equal(e[3], 4 * 0.5 + 2 * 0.5);
});

test('RSI is 100 on a monotonic rise, 0 on a monotonic fall, null in warm-up', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const dn = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(ind.rsi(up)[13], null);
  assert.equal(ind.rsi(up)[29], 100);
  assert.equal(ind.rsi(dn)[29], 0);
});

test('Bollinger bands collapse on flat prices and are null in warm-up', () => {
  const b = ind.bollinger(Array(25).fill(50));
  assert.equal(b.upper[24], 50); assert.equal(b.lower[24], 50);
  assert.equal(b.upper[18], null);
});

test('ATR of constant-range candles equals that range; MACD histogram = macd - signal', () => {
  const candles = Array.from({ length: 40 }, () => ({ t: 'x', o: 10, h: 12, l: 8, c: 10, v: 1 }));
  assert.equal(ind.atr(candles)[39], 4);
  const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 10);
  const m = ind.macd(closes);
  assert.ok(Math.abs(m.hist[79] - (m.macd[79] - m.signal[79])) < 1e-9);
  assert.equal(m.macd[24], null);
  assert.notEqual(m.macd[25], null);
});

test('VWAP only on intraday candles, resets each day, null without volume', () => {
  const c = [
    { t: '2026-01-01T09:15:00+05:30', h: 11, l: 9, c: 10, v: 10 },
    { t: '2026-01-02T09:15:00+05:30', h: 21, l: 19, c: 20, v: 10 },
    { t: '2026-01-02T09:20:00+05:30', h: 21, l: 19, c: 20, v: null },
  ];
  assert.deepEqual(ind.vwap(c, true), [10, 20, 20]);
  assert.deepEqual(ind.vwap(c, false), [null, null, null]);
});

test('computeSeries returns arrays aligned 1:1 with candles', () => {
  const candles = mk(Array.from({ length: 60 }, (_, i) => 100 + i));
  const s = ind.computeSeries(candles);
  for (const k of ['ema20', 'ema50', 'rsi', 'atr']) assert.equal(s[k].length, 60);
  assert.equal(s.macd.hist.length, 60);
  assert.equal(ind.lastValue(s.ema50), s.ema50[59]);
});

test('estimated session windows per segment', () => {
  const ist = (iso) => new Date(iso + '+05:30');
  assert.equal(sess.estimateMarketStatus('NSE_EQ', ist('2026-10-13T10:00:00')).status, 'open');
  assert.equal(sess.estimateMarketStatus('NSE_EQ', ist('2026-10-13T16:00:00')).status, 'closed');
  assert.equal(sess.estimateMarketStatus('NSE_EQ', ist('2026-10-17T11:00:00')).status, 'closed');
  assert.equal(sess.estimateMarketStatus('MCX_FO', ist('2026-10-13T20:00:00')).status, 'open');
  assert.equal(sess.estimateMarketStatus('NCD_FO', ist('2026-10-13T16:30:00')).status, 'open');
  assert.equal(sess.estimateMarketStatus('GLOBAL_INDEX', ist('2026-10-13T10:00:00')).status, 'unknown');
  assert.equal(sess.estimateMarketStatus('NSE_EQ', ist('2026-10-13T10:00:00')).source, 'estimated-schedule');
});

test('official status strings map correctly; unknown strings map to null', () => {
  assert.equal(sess.interpretStatusString('NORMAL_OPEN'), 'open');
  assert.equal(sess.interpretStatusString('NORMAL_CLOSE'), 'closed');
  assert.equal(sess.interpretStatusString('PRE_OPEN_START'), 'closed');
  assert.equal(sess.interpretStatusString('WHATEVER'), null);
});

test('freshness classification', () => {
  const now = 1_000_000_000_000;
  const base = { segment: 'NSE_EQ', assetClass: 'equity', nowMs: now };
  assert.equal(sess.classifyFreshness({ ...base, marketStatus: 'open', tradeTimeMs: now - 5_000 }).mode, 'real-time');
  const old = sess.classifyFreshness({ ...base, marketStatus: 'open', tradeTimeMs: now - 3_600_000 });
  assert.equal(old.mode, 'delayed'); assert.equal(old.stale, true);
  assert.equal(sess.classifyFreshness({ ...base, marketStatus: 'closed', tradeTimeMs: now - 3_600_000 }).mode, 'last-close');
  assert.equal(sess.classifyFreshness({ ...base, marketStatus: 'open', tradeTimeMs: null }).mode, 'unknown');
});

test('timeframe validation follows V3 rules', () => {
  assert.equal(cu.validateTimeframe('minutes', 5), null);
  assert.notEqual(cu.validateTimeframe('minutes', 301), null);
  assert.notEqual(cu.validateTimeframe('hours', 6), null);
  assert.equal(cu.validateTimeframe('days', 1), null);
  assert.notEqual(cu.validateTimeframe('days', 2), null);
  assert.notEqual(cu.validateTimeframe('years', 1), null);
  assert.equal(cu.maxRangeDays('minutes', 1), 30);
});

test('candle normalization sorts oldest-first and drops corrupt rows instead of repairing them', () => {
  const raw = [
    ['2026-10-12T09:20:00+05:30', 10, 12, 9, 11, 100, 0],
    ['2026-10-12T09:15:00+05:30', 9, 10, 8, 10, 50, 0],
    ['2026-10-12T09:25:00+05:30', 10, 9, 11, 10, 5, 0],
    ['2026-10-12T09:30:00+05:30', 'x', 1, 1, 1, 1, 0],
    'garbage',
  ];
  const { candles, dropped } = cu.normalizeCandleRows(raw);
  assert.equal(dropped, 3);
  assert.deepEqual(candles.map((c) => c.c), [10, 11]);
  assert.ok(candles[0].ts < candles[1].ts);
});

test('merge de-duplicates by timestamp and prefers intraday', () => {
  const h = [{ ts: 1, c: 1 }, { ts: 2, c: 2 }];
  const i = [{ ts: 2, c: 22 }, { ts: 3, c: 3 }];
  assert.deepEqual(cu.mergeCandles(h, i).map((c) => c.c), [1, 22, 3]);
});

// ── quote parsing + probe logic ─────────────────────────────────────────
const qu = require('../utils/quoteUtils');
const pl = require('../utils/probeLogic');

test('quote parsing prefers last_price - net_change over ohlc.close (post-close flattening bug)', () => {
  const q = qu.parseQuote({ last_price: 105, net_change: 5, ohlc: { open: 101, high: 106, low: 100, close: 105 }, volume: 10, last_trade_time: '1790000000000' });
  assert.equal(q.previousClose, 100);
  assert.equal(q.changePct, 5);
  assert.equal(q.tradeTimeMs, 1790000000000);
  assert.equal(q.depth, null);          // absent depth stays null, never synthesized
  assert.equal(q.openInterest, null);   // absent oi stays null
});

test('quote with no usable last_price is rejected, not zero-filled', () => {
  assert.equal(qu.parseQuote({ last_price: null }), null);
  assert.equal(qu.parseQuote({}), null);
  assert.equal(qu.parseQuote(undefined), null);
});

test('response index normalizes URL-encoded pipes in instrument_token', () => {
  const m = qu.indexQuotesByToken({ 'NSE_EQ:X': { instrument_token: 'NSE_EQ%7CINE1', last_price: 1 } });
  assert.ok(m.has('NSE_EQ|INE1'));
});

test('probe outcome classification', () => {
  assert.equal(pl.classifyOutcome({ ok: true }, true), 'verified');
  assert.equal(pl.classifyOutcome({ ok: true }, false), 'empty');
  assert.equal(pl.classifyOutcome({ ok: false, kind: 'denied', status: 403 }, false), 'denied');
  assert.equal(pl.classifyOutcome({ ok: false, kind: 'unsupported', status: 400 }, false, true), 'unsupported');
  assert.equal(pl.classifyOutcome({ ok: false, kind: 'unsupported', status: 400 }, false, false), 'empty');
  assert.equal(pl.classifyOutcome({ ok: false, kind: 'rate_limited', status: 429 }, false), 'rate_limited');
});

test('access status roll-up', () => {
  assert.equal(pl.deriveAccessStatus(['verified', 'empty', 'unsupported']), 'VERIFIED');
  assert.equal(pl.deriveAccessStatus(['denied', 'denied']), 'ACCESS DENIED');
  assert.equal(pl.deriveAccessStatus(['unsupported', 'unsupported']), 'UNSUPPORTED BY UPSTOX');
  assert.equal(pl.deriveAccessStatus(['empty', 'unsupported']), 'NO DATA RETURNED');
  assert.equal(pl.deriveAccessStatus(['error', 'empty']), 'PROBE INCONCLUSIVE');
  assert.equal(pl.deriveAccessStatus(['untested', 'n/a']), 'UNVERIFIED');
});

// ── audit report ────────────────────────────────────────────────────────
const { buildAuditMarkdown } = require('../utils/auditReport');
test('audit report renders probe results and lists unsupported segments explicitly', () => {
  const md = buildAuditMarkdown([
    { segment: 'NSE_EQ', instrumentCount: 2, sampleKeys: ['NSE_EQ|A'], accessStatus: 'VERIFIED', verifiedIntervals: ['days:1'], lastTickAt: null,
      capabilities: { quote: 'verified', ohlc: 'verified', historicalCandles: 'verified', intradayCandles: 'empty', optionChain: 'n/a', greeks: 'n/a', streaming: 'untested' } },
    { segment: 'GLOBAL_INDEX', instrumentCount: 0, sampleKeys: [], accessStatus: 'UNSUPPORTED BY UPSTOX', verifiedIntervals: [], lastTickAt: null, notes: 'none in master',
      capabilities: { quote: 'untested', ohlc: 'untested', historicalCandles: 'untested', intradayCandles: 'untested', optionChain: 'n/a', greeks: 'n/a', streaming: 'untested' } },
  ], { 'NSE_EQ|A': 'RELIANCE' }, { generatedAt: 'T' });
  assert.match(md, /\| NSE_EQ \| 2 \| RELIANCE \| ✅ verified/);
  assert.match(md, /not probed/);
  assert.match(md, /Marked UNSUPPORTED BY UPSTOX[\s\S]*GLOBAL_INDEX/);
});

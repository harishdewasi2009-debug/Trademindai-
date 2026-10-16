const test = require('node:test');
const assert = require('node:assert');
const { analyze, supportResistance, breakoutState } = require('../utils/technicalAnalysis');
const { judge, findHorizonCandle, summarize, CRITERIA } = require('../services/analysisTracker');
const { basisRow } = require('../services/futuresBasis');

const mk = (n, f) => Array.from({ length: n }, (_, i) => { const c = f(i); return { h: c + 1, l: c - 1, c, v: 1000 + i }; });

test('analyze refuses insufficient data (no fabricated indicators)', () => {
  const r = analyze(mk(10, (i) => 100 + i));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /at least 30/);
});
test('steady uptrend reads bullish with evidence and invalidation', () => {
  const r = analyze(mk(120, (i) => 100 + i * 0.8 + Math.sin(i) * 0.5));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.bias, 'bullish');
  assert.ok(r.votes.length >= 4);
  assert.ok(r.trend.strengthAdx > 20);
});
test('steady downtrend reads bearish', () => {
  const r = analyze(mk(120, (i) => 300 - i * 0.8 + Math.sin(i) * 0.5));
  assert.strictEqual(r.bias, 'bearish');
});
test('no volume → volume null and risk disclosed', () => {
  const c = mk(60, (i) => 100 + Math.sin(i)).map((x) => ({ ...x, v: null }));
  const r = analyze(c);
  assert.strictEqual(r.volume, null);
  assert.ok(r.risks.some((x) => /Volume is not available/.test(x)));
});
test('breakout detection uses prior range only', () => {
  const c = mk(30, () => 100); c.push({ h: 111, l: 100, c: 110, v: 1 });
  assert.strictEqual(breakoutState(c).state, 'breakout');
});
test('support/resistance levels sit on correct side of price', () => {
  const c = mk(80, (i) => 100 + 5 * Math.sin(i / 3));
  const sr = supportResistance(c); const last = c[c.length - 1].c;
  sr.support.forEach((s) => assert.ok(s.level < last));
  sr.resistance.forEach((s) => assert.ok(s.level > last));
});
test('judge applies frozen ATR criteria', () => {
  assert.strictEqual(judge('bullish', 100, 101, 2).status, 'correct');   // +0.5 ATR
  assert.strictEqual(judge('bullish', 100, 100.2, 2).status, 'incorrect'); // +0.1 ATR
  assert.strictEqual(judge('bearish', 100, 98, 2).status, 'correct');
  assert.strictEqual(judge('neutral', 100, 101.5, 2).status, 'correct');
  assert.strictEqual(judge('neutral', 100, 103, 2).status, 'incorrect');
  assert.strictEqual(judge('bullish', 100, NaN, 2), null);
  assert.strictEqual(judge('bullish', 100, 105, 0), null);
});
test('horizon candle must exist and be complete', () => {
  const day = 86400e3; const cs = Array.from({ length: 8 }, (_, i) => ({ ts: i * day, c: 100 + i }));
  assert.strictEqual(findHorizonCandle(cs, 0, 5, 'days', 1, 10 * day).found, true);
  assert.strictEqual(findHorizonCandle(cs, 4 * day, 5, 'days', 1, 10 * day).found, false); // not formed
  assert.strictEqual(findHorizonCandle(cs, 0, 5, 'days', 1, 5.5 * day).found, false);      // in progress
  assert.strictEqual(findHorizonCandle(cs, 99, 5, 'days', 1, 10 * day).found, false);      // entry missing
});
test('summary excludes pending/unresolvable from accuracy', () => {
  const s = summarize([{ status: 'correct' }, { status: 'incorrect' }, { status: 'pending' }, { status: 'unresolvable' }, { status: 'correct' }]);
  assert.strictEqual(s.eligible, 3); assert.strictEqual(s.accuracyPct, 66.67);
  assert.strictEqual(s.pending, 1); assert.strictEqual(s.unresolvable, 1);
  assert.strictEqual(summarize([{ status: 'pending' }]).accuracyPct, null);
  assert.ok(CRITERIA.horizonBars > 0);
});
test('basis computed only when both prices exist', () => {
  const fut = { instrumentKey: 'k', symbol: 'X', expiry: '2099-01-29', lotSize: 25 };
  const now = Date.parse('2098-12-30T00:00:00Z');
  const r = basisRow(fut, { lastPrice: 101, openInterest: 5, volume: 9 }, 100, now);
  assert.strictEqual(r.basis, 1); assert.strictEqual(r.basisPct, 1);
  assert.ok(r.annualizedPct > 0);
  assert.strictEqual(basisRow(fut, { lastPrice: 101 }, null, now).basis, null);
  assert.strictEqual(basisRow(fut, null, 100, now).basis, null);
});

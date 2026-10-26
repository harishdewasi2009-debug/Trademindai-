const test = require('node:test');
const assert = require('node:assert/strict');
const r = require('../utils/notificationRules');
const { SYMBOL_SECTOR } = require('../utils/sectorMap');

test('moveMilestone picks highest level reached, with direction', () => {
  assert.equal(r.moveMilestone(2.9), null);
  assert.deepEqual(r.moveMilestone(3.1), { level: 3, dir: 'up' });
  assert.deepEqual(r.moveMilestone(6.4), { level: 5, dir: 'up' });
  assert.deepEqual(r.moveMilestone(-10.2), { level: 10, dir: 'down' });
  assert.equal(r.moveMilestone(NaN), null);
  assert.equal(r.moveMilestone(null), null);
});

test('pnlMilestone', () => {
  assert.equal(r.pnlMilestone(100, 105), null);
  assert.deepEqual(r.pnlMilestone(100, 112).level, 10);
  assert.equal(r.pnlMilestone(100, 78).dir, 'down');
  assert.equal(r.pnlMilestone(0, 10), null);
});

test('priceAlertTriggered', () => {
  assert.equal(r.priceAlertTriggered(100, 'above', 100), true);
  assert.equal(r.priceAlertTriggered(100, 'above', 99), false);
  assert.equal(r.priceAlertTriggered(100, 'below', 99.5), true);
  assert.equal(r.priceAlertTriggered(100, 'below', 101), false);
  assert.equal(r.priceAlertTriggered(null, 'below', 101), false);
  assert.equal(r.priceAlertTriggered(100, 'sideways', 101), false);
});

test('computeSectorHeat flags a broad sector rally and ignores narrow/thin ones', () => {
  const quotes = [
    { symbol: 'TCS', changePct: 3.2 }, { symbol: 'INFY', changePct: 2.8 },
    { symbol: 'WIPRO', changePct: 3.5 }, { symbol: 'HCLTECH', changePct: 2.9 },
    { symbol: 'TECHM', changePct: -0.5 },
    // Banking: only 2 stocks → below MIN_SECTOR_STOCKS
    { symbol: 'SBIN', changePct: 5 }, { symbol: 'HDFCBANK', changePct: 5 },
    // Auto: mixed → breadth too low
    { symbol: 'MARUTI', changePct: 4 }, { symbol: 'TATAMOTORS', changePct: -4 }, { symbol: 'M&M', changePct: 0.5 },
    { symbol: 'UNKNOWNCO', changePct: 9 },
  ];
  const heat = r.computeSectorHeat(quotes, SYMBOL_SECTOR);
  assert.equal(heat.length, 1);
  assert.equal(heat[0].sector, 'IT');
  assert.equal(heat[0].dir, 'up');
  assert.equal(heat[0].level, 2);
  assert.equal(heat[0].leaders[0].symbol, 'WIPRO');
});

test('computeSectorHeat detects a sector sell-off', () => {
  const quotes = ['TCS', 'INFY', 'WIPRO', 'HCLTECH'].map((symbol) => ({ symbol, changePct: -4.2 }));
  const [h] = r.computeSectorHeat(quotes, SYMBOL_SECTOR);
  assert.equal(h.dir, 'down');
  assert.equal(h.level, 4);
});

test('screenerQualifies', () => {
  assert.equal(r.screenerQualifies('strong_bullish', 85, 80), true);
  assert.equal(r.screenerQualifies('strong_bullish', 70, 80), false);
  assert.equal(r.screenerQualifies('neutral', 99, 80), false);
  assert.equal(r.screenerQualifies('strong_bearish', 90, 80), true);
});

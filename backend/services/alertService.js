// services/alertService.js
// Generates "AI alerts" from REAL candle data — no fabricated symbols, no
// placeholder timestamps. This mirrors the exact same arithmetic the
// Market Scanner uses on the frontend (breakout / volume spike / RSI
// oversold / MACD reversal / gap), just run server-side against a user's
// own watchlist so it can be surfaced on the Dashboard.
//
// This computes alerts on demand (cached briefly per user) rather than via
// a standing background worker — the app has no job queue/scheduler yet,
// so "on-demand, but on real data" is the honest middle ground until a
// proper cron-based worker is built.

const { query } = require('../db/pool');
const marketDataService = require('./marketDataService');

// Used only when the user's watchlist is empty, so they still see
// something meaningful before adding stocks — same liquid-stock idea as
// the frontend's curated scanner list, kept small to bound Upstox calls.
const DEFAULT_ALERT_SYMBOLS = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
  'TATAMOTORS', 'SBIN', 'ADANIENT', 'BAJFINANCE', 'ITC',
];

// Broader curated list of liquid NSE large/mid-caps used for the "All
// Stock Alerts" market-wide scan (scope='all') — deliberately wider than
// DEFAULT_ALERT_SYMBOLS (which is just a watchlist-empty fallback) so the
// "all stocks" view actually feels like a market scan, not a repeat of the
// same 10 names. Still bounded by MAX_SYMBOLS_PER_RUN to cap Upstox calls.
const ALL_MARKET_ALERT_SYMBOLS = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
  'TATAMOTORS', 'SBIN', 'ADANIENT', 'BAJFINANCE', 'ITC',
  'HINDUNILVR', 'KOTAKBANK', 'LT', 'AXISBANK', 'MARUTI',
  'SUNPHARMA', 'WIPRO', 'ONGC', 'TATASTEEL', 'ASIANPAINT',
];

const MAX_SYMBOLS_PER_RUN = 15; // bounds Upstox calls per alert refresh
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
const alertCache = new Map(); // `${userId}:${scope}` -> { alerts, fetchedAt }

function sma(values, period, endIdx) {
  const slice = values.slice(endIdx - period, endIdx);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length <= period) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0, loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function calcMACD(closes) {
  const ema12 = ema(closes, 12), ema26 = ema(closes, 26);
  const macd = closes.map((_, i) => ema12[i] - ema26[i]);
  const signal = ema(macd, 9);
  return { macd, signal };
}

/** Runs the same real, arithmetic-only rules as the frontend scanner
 *  against one symbol's real daily candles and returns 0 or more alerts. */
function detectAlertsForCandles(symbol, exchange, candles) {
  if (!candles || candles.length < 26) return [];
  const closes = candles.map((c) => c.c);
  const vols = candles.map((c) => c.v || 0);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const last20High = Math.max(...closes.slice(-21, -1));
  const avgVol20 = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volRatio = avgVol20 ? last.v / avgVol20 : 0;
  const detectedAt = last.t || new Date().toISOString();
  const out = [];

  if (last.c > last20High && volRatio > 1.3) {
    out.push({ type: 'breakout', severity: 'green', title: `${symbol} — Strong bullish breakout detected`,
      description: `Broke the 20-day high of ₹${last20High.toFixed(0)} on ${volRatio.toFixed(1)}x average volume.` });
  }
  const rsi = calcRSI(closes);
  const r = rsi[rsi.length - 1];
  const basing = closes[closes.length - 1] > closes[closes.length - 2] && closes[closes.length - 2] > closes[closes.length - 3];
  if (r < 35 && basing) {
    out.push({ type: 'oversold', severity: 'green', title: `${symbol} — Oversold bounce setup`,
      description: `RSI at ${r.toFixed(0)}, with the last 3 closes trending up.` });
  }
  const { macd, signal } = calcMACD(closes);
  const nowBull = macd[macd.length - 1] > signal[signal.length - 1];
  const prevBull = macd[macd.length - 2] > signal[signal.length - 2];
  if (nowBull !== prevBull) {
    out.push({ type: 'reversal', severity: nowBull ? 'green' : 'red', title: `${symbol} — MACD crossed ${nowBull ? 'bullish' : 'bearish'}`,
      description: `Trend-following signal just flipped ${nowBull ? 'positive' : 'negative'} on the daily chart.` });
  }
  if (prev?.c) {
    const gapPct = ((last.o - prev.c) / prev.c) * 100;
    if (Math.abs(gapPct) > 2) {
      out.push({ type: 'gap', severity: gapPct > 0 ? 'green' : 'red', title: `${symbol} — Gapped ${gapPct > 0 ? 'up' : 'down'} ${Math.abs(gapPct).toFixed(1)}% at open`,
        description: `Real gap between yesterday's close (₹${prev.c.toFixed(0)}) and today's open (₹${last.o.toFixed(0)}).` });
    }
  }
  if (!nowBull && r > 70) {
    out.push({ type: 'risk', severity: 'amber', title: `${symbol} — Risk alert: overbought`,
      description: `RSI at ${r.toFixed(0)} with MACD turning negative — momentum may be fading.` });
  }

  return out.map((a) => ({ ...a, stockSymbol: symbol, exchange, detectedAt }));
}

/** Returns real, on-demand alerts for a user.
 *  scope='all'       — always scans the broad curated market list, ignoring
 *                       the user's own watchlist (the Dashboard's "All Stock
 *                       Alerts" panel).
 *  scope='watchlist' — always scans the user's own watchlist only; returns
 *                       an empty result (with empty:true) if they have no
 *                       watchlist stocks yet (the Dashboard's "Watchlist
 *                       Alerts" panel).
 *  scope=undefined    — original behaviour: watchlist if non-empty, else
 *                       the small default fallback list (used by the
 *                       Overview page's "Today's AI alerts" widget). */
async function generateAlertsForUser(userId, scope) {
  const cacheKey = `${userId}:${scope || 'auto'}`;
  const cached = alertCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.alerts;

  let symbols, usingWatchlist;

  if (scope === 'all') {
    symbols = ALL_MARKET_ALERT_SYMBOLS.slice(0, MAX_SYMBOLS_PER_RUN);
    usingWatchlist = false;
  } else if (scope === 'watchlist') {
    const { rows } = await query(
      'SELECT stock_symbol FROM watchlist WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, MAX_SYMBOLS_PER_RUN]
    );
    if (rows.length === 0) {
      const result = { alerts: [], usingWatchlist: true, symbolsScanned: 0, empty: true };
      alertCache.set(cacheKey, { alerts: result, fetchedAt: Date.now() });
      return result;
    }
    symbols = rows.map((r) => r.stock_symbol);
    usingWatchlist = true;
  } else {
    const { rows } = await query(
      'SELECT stock_symbol FROM watchlist WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, MAX_SYMBOLS_PER_RUN]
    );
    usingWatchlist = rows.length > 0;
    symbols = usingWatchlist ? rows.map((r) => r.stock_symbol) : DEFAULT_ALERT_SYMBOLS;
  }

  const perSymbol = await Promise.all(symbols.map(async (symbol) => {
    try {
      const { candles } = await marketDataService.getHistoricalCandles(symbol, { unit: 'days', interval: 1 });
      return detectAlertsForCandles(symbol, null, candles);
    } catch (e) {
      return []; // one bad symbol shouldn't break the whole alert run
    }
  }));

  const alerts = perSymbol.flat()
    .sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))
    .slice(0, 10);

  const result = { alerts, usingWatchlist, symbolsScanned: symbols.length };
  alertCache.set(cacheKey, { alerts: result, fetchedAt: Date.now() });
  return result;
}

module.exports = { generateAlertsForUser };

// services/screenerCoverageService.js
// ══════════════════════════════════════════════════════════════════════════
//  Guarantees every stock/contract on NSE, BSE, and MCX gets a Screener
//  signal logged (via scannerAccuracyService) on every trading day — not
//  just the symbols a user happened to click on that day.
//
//  Without this, scanner_signal_history only ever contains whatever a
//  logged-in user's browser requested through /api/market/signals, so the
//  admin "everyday accuracy" calendar would silently under-report days
//  where traffic was light, and would never cover the full NSE+BSE+MCX
//  universe. This file drives that coverage independently of user traffic.
//
//  Design: rather than one giant burst of ~7,000+ candle requests (NSE ≈
//  2,000 equities, BSE ≈ 5,000+, MCX ≈ 100+ commodity contracts) which
//  would blow through Upstox rate limits, a small cron tick
//  (runCoverageBatch) runs every few minutes during market hours and only
//  processes symbols NOT already logged today (scanner_signal_history's
//  UNIQUE constraint is the source of truth for "already done" — this file
//  also pre-filters before calling out to Upstox, so a symbol's candle data
//  is fetched at most once per day even across many cron ticks). By market
//  close the full universe has been scanned once each.
// ══════════════════════════════════════════════════════════════════════════

const { query } = require('../db/pool');
const { isTradingDay } = require('../utils/tradingCalendar');

const EXCHANGES = ['NSE_EQ', 'BSE_EQ', 'MCX_FO'];
const TIMEFRAME = '1d'; // the calendar/coverage view tracks the daily Screener signal
const BATCH_SIZE = Number(process.env.SCREENER_COVERAGE_BATCH_SIZE) || 60; // symbols per cron tick, across all exchanges combined
const CONCURRENCY = 6; // matches getSignalsBatch's Upstox-friendly concurrency

// In-memory, per-process-lifetime cache of each exchange's full symbol list
// for "today" (IST calendar date) — avoids re-downloading/parsing the
// multi-MB Upstox instrument-master file on every 5-minute cron tick.
const universeCache = {}; // { [exchange]: { date: 'YYYY-MM-DD', items: [{symbol, exchange}] } }

function todayIST() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

async function loadUniverse(exchange) {
  const marketDataService = require('./marketDataService'); // lazy: avoid require cycle
  const today = todayIST();
  const cached = universeCache[exchange];
  if (cached && cached.date === today) return cached.items;

  const items = [];
  let page = 1;
  const limit = 500;
  // Paginate through listAllSymbols until every symbol on this exchange is
  // collected — same data source the "Browse all stocks" screener list uses.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await marketDataService.listAllSymbols({ exchange, page, limit });
    items.push(...res.items);
    if (page >= res.totalPages || !res.items.length) break;
    page++;
  }
  universeCache[exchange] = { date: today, items };
  return items;
}

/** Symbols on this exchange that already have a logged '1d' scanner signal
 *  for today's trading day — these are skipped so re-running the batch
 *  never re-fetches candles for a symbol that's already covered today. */
async function alreadyCoveredToday(exchange) {
  const { rows } = await query(
    `SELECT DISTINCT stock_symbol FROM scanner_signal_history
     WHERE exchange = $1 AND timeframe = $2 AND signal_date = CURRENT_DATE`,
    [exchange, TIMEFRAME]
  );
  return new Set(rows.map((r) => r.stock_symbol.toUpperCase()));
}

/** Processes up to BATCH_SIZE not-yet-covered symbols (spread across
 *  NSE_EQ → BSE_EQ → MCX_FO in that order) for the current trading day.
 *  Safe to call repeatedly (e.g. every 5 minutes via cron) — a full day's
 *  universe gets covered incrementally across many ticks. No-ops outside
 *  market hours / on holidays so it never wastes calls when there's
 *  nothing to check signals against.
 */
async function runCoverageBatch() {
  const marketDataService = require('./marketDataService'); // lazy: avoid require cycle
  if (!marketDataService.isIndianMarketOpen()) return { skipped: 'market_closed' };

  let remainingBudget = BATCH_SIZE;
  const perExchange = {};

  for (const exchange of EXCHANGES) {
    if (remainingBudget <= 0) break;
    let universe, done;
    try {
      [universe, done] = await Promise.all([loadUniverse(exchange), alreadyCoveredToday(exchange)]);
    } catch (err) {
      perExchange[exchange] = { error: err.message };
      continue;
    }
    const pending = universe.filter((s) => !done.has(s.symbol.toUpperCase()));
    const slice = pending.slice(0, remainingBudget);
    if (!slice.length) {
      perExchange[exchange] = { totalSymbols: universe.length, scannedToday: done.size, processedThisTick: 0 };
      continue;
    }

    let i = 0;
    async function worker() {
      while (i < slice.length) {
        const idx = i++;
        const s = slice[idx];
        try {
          // getTechnicalSignal itself calls scannerAccuracyService.logSignal
          // (fire-and-forget, deduped by the DB unique constraint) whenever
          // it computes a fresh signal during market hours — same code path
          // a real user's Screener request goes through.
          await marketDataService.getTechnicalSignal(s.symbol, s.exchange, TIMEFRAME);
        } catch (err) {
          // getTechnicalSignal already swallows per-symbol errors internally
          // and returns an { error } payload rather than throwing, but stay
          // defensive here too — one bad symbol must never stop the batch.
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slice.length) }, worker));

    perExchange[exchange] = {
      totalSymbols: universe.length,
      scannedToday: done.size + slice.length,
      processedThisTick: slice.length,
    };
    remainingBudget -= slice.length;
  }

  return { processedThisTick: BATCH_SIZE - remainingBudget, perExchange };
}

/** Today's coverage snapshot for the admin panel: how many of each
 *  exchange's full symbol universe have a logged signal for today, so an
 *  admin can see "NSE 1,842 / 2,013 scanned" progress through the day
 *  rather than just the historical calendar. */
async function getCoverageStatus() {
  const marketOpen = require('./marketDataService').isIndianMarketOpen();
  const trading = isTradingDay(new Date());
  const perExchange = {};
  for (const exchange of EXCHANGES) {
    try {
      const [universe, done] = await Promise.all([loadUniverse(exchange), alreadyCoveredToday(exchange)]);
      perExchange[exchange] = { totalSymbols: universe.length, scannedToday: done.size };
    } catch (err) {
      perExchange[exchange] = { error: err.message };
    }
  }
  return { date: todayIST(), isTradingDay: trading, isMarketOpen: marketOpen, perExchange };
}

module.exports = { runCoverageBatch, getCoverageStatus, EXCHANGES, TIMEFRAME };

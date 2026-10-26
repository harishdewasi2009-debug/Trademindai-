// services/notificationEngine.js
// Background scanner that turns REAL market data into notifications.
// Driven by cron (see tokenScheduler.js). Everything is deduped per user, so
// running every 5 minutes only ever tells a user about a new event once.
//
//  • Personal  — watchlist price alerts, watchlist/portfolio day-move
//                milestones, portfolio P&L milestones (+/-10, 20, 30, 50, 100%)
//  • Market    — NSE top-150 (BSE fallback for names NSE cannot resolve) and
//                MCX commodity movers at +/-3, 5, 7, 10, 15, 20% milestones
//  • Sector    — sector "heat": broad-based sector rally / sell-off
//  • Screener  — strong bullish / bearish technical alignment from the
//                Screener's own daily signal log (scanner_signal_history)
//
// All wording is descriptive (what happened / what the indicators say), never
// a buy/sell instruction or a promise of a price move.

const { query } = require('../db/pool');
const notifications = require('./notificationService');
const rules = require('../utils/notificationRules');
const { SYMBOL_SECTOR, NSE_TOP_150 } = require('../utils/sectorMap');
const { isTradingDay } = require('../utils/tradingCalendar');

const CHUNK = 100;
const MARKET_UNIVERSE = [...new Set([...NSE_TOP_150, ...Object.keys(SYMBOL_SECTOR)])];
const MARKET_SET = new Set(MARKET_UNIVERSE);
const locks = new Set();

function mds() { return require('./marketDataService'); } // lazy: avoid require cycles
const nseOpen = () => mds().isIndianMarketOpen();
function mcxOpen(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6 || !isTradingDay(now)) return false;
  const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return m >= 9 * 60 && m < 23 * 60 + 30;
}
const sessionOpen = (exchange) => (exchange === 'MCX_FO' ? mcxOpen() : nseOpen());

async function guarded(name, fn) {
  if (locks.has(name)) return { skipped: 'already_running' };
  locks.add(name);
  try { return await fn(); }
  catch (err) { console.error(`[notifEngine] ${name} failed:`, err.message); return { error: err.message }; }
  finally { locks.delete(name); }
}

/** Quote [{symbol, exchange}] in chunks → Map<'EX:SYMBOL', quote>. Skips stale/closed quotes. */
async function fetchQuotes(entries) {
  const out = new Map();
  const failed = [];
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    try {
      const res = await mds().getLtpBatch(chunk);
      for (const q of res.quotes || []) {
        if (q.closed || typeof q.lastPrice !== 'number' || typeof q.changePct !== 'number') continue;
        out.set(`${q.exchange}:${q.symbol}`, q);
      }
      for (const e of res.errors || []) failed.push(e.symbol);
    } catch (err) {
      console.warn('[notifEngine] quote chunk failed:', err.message);
    }
  }
  return { quotes: out, failed };
}

const dirWord = (dir) => (dir === 'up' ? 'up' : 'down');
const sevFor = (dir) => (dir === 'up' ? 'green' : 'red');

// ══════════════ MARKET-WIDE: top movers + sector heat ══════════════
async function runMarketScan() {
  return guarded('market', async () => {
    const date = rules.istDate();
    const summary = { movers: 0, sectors: 0, mcx: 0 };

    // ── NSE (+BSE fallback) ──
    if (nseOpen()) {
      let { quotes, failed } = await fetchQuotes(MARKET_UNIVERSE.map((symbol) => ({ symbol, exchange: 'NSE_EQ' })));
      // Names NSE could not resolve are retried on BSE (dual-listed fallback).
      const retry = [...new Set(failed)].filter((s) => NSE_TOP_150.includes(s)).slice(0, 150);
      if (retry.length) {
        const bse = await fetchQuotes(retry.map((symbol) => ({ symbol, exchange: 'BSE_EQ' })));
        for (const [k, v] of bse.quotes) quotes.set(k, v);
      }
      const list = [...quotes.values()];

      // Top movers (only stocks in the curated top-150 universe, never penny noise)
      const candidates = list
        .filter((q) => NSE_TOP_150.includes(q.symbol))
        .map((q) => ({ q, m: rules.moveMilestone(q.changePct) }))
        .filter((x) => x.m)
        .sort((a, b) => Math.abs(b.q.changePct) - Math.abs(a.q.changePct))
        .slice(0, 20);
      for (const { q, m } of candidates) {
        const up = m.dir === 'up';
        const ids = await notifications.broadcast({
          type: 'top_mover', category: 'market', severity: sevFor(m.dir),
          symbol: q.symbol, exchange: q.exchange,
          title: `${up ? '🚀' : '🔻'} ${q.symbol} ${dirWord(m.dir)} ${rules.fmtPct(q.changePct)} today`,
          body: `${q.symbol} (${q.exchange === 'BSE_EQ' ? 'BSE' : 'NSE'}) is trading at ${rules.fmtPrice(q.lastPrice)}, ${rules.fmtPct(q.changePct)} vs previous close — crossed the ${m.level}% milestone.`,
          data: { price: q.lastPrice, changePct: q.changePct, level: m.level },
          dedupeKey: `mv:${q.symbol}:${m.dir}:${m.level}:${date}`,
        }, 'COALESCE(p.top_movers, TRUE) AND COALESCE(p.move_threshold, 5) <= $1', [m.level]);
        summary.movers += ids.length ? 1 : 0;
      }

      // Sector heat
      for (const h of rules.computeSectorHeat(list, SYMBOL_SECTOR)) {
        const up = h.dir === 'up';
        const leaders = h.leaders.map((l) => `${l.symbol} ${rules.fmtPct(l.changePct)}`).join(', ');
        const ids = await notifications.broadcast({
          type: 'sector_heat', category: 'sector', severity: sevFor(h.dir),
          title: `${up ? '🔥' : '🧊'} ${h.sector} sector ${up ? 'heating up' : 'under pressure'} ${rules.fmtPct(h.avg)}`,
          body: `${Math.round(h.breadth * 100)}% of ${h.count} tracked ${h.sector} stocks are ${up ? 'higher' : 'lower'} (average ${rules.fmtPct(h.avg)}). ${up ? 'Leaders' : 'Biggest decliners'}: ${leaders}.`,
          data: { sector: h.sector, avg: h.avg, breadth: h.breadth, level: h.level, leaders: h.leaders },
          dedupeKey: `sector:${h.sector}:${h.dir}:${h.level}:${date}`,
        }, 'COALESCE(p.sector_heat, TRUE) AND COALESCE(p.sector_threshold, 2) <= $1', [h.level]);
        summary.sectors += ids.length ? 1 : 0;
      }
    }

    // ── MCX commodities ──
    if (mcxOpen()) {
      const { items } = await mds().listAllSymbols({ exchange: 'MCX_FO', page: 1, limit: 150 });
      const { quotes } = await fetchQuotes(items.map((i) => ({ symbol: i.symbol, exchange: 'MCX_FO' })));
      const hits = [...quotes.values()]
        .map((q) => ({ q, m: rules.moveMilestone(q.changePct, rules.MCX_LEVELS) }))
        .filter((x) => x.m).sort((a, b) => Math.abs(b.q.changePct) - Math.abs(a.q.changePct)).slice(0, 10);
      for (const { q, m } of hits) {
        const up = m.dir === 'up';
        const ids = await notifications.broadcast({
          type: 'mcx_move', category: 'mcx', severity: sevFor(m.dir), symbol: q.symbol, exchange: 'MCX_FO',
          title: `${up ? '📈' : '📉'} MCX ${q.symbol} ${dirWord(m.dir)} ${rules.fmtPct(q.changePct)}`,
          body: `${q.symbol} (MCX front-month) is at ${rules.fmtPrice(q.lastPrice)}, ${rules.fmtPct(q.changePct)} vs previous close — crossed the ${m.level}% milestone.`,
          data: { price: q.lastPrice, changePct: q.changePct, level: m.level },
          dedupeKey: `mcx:${q.symbol}:${m.dir}:${m.level}:${date}`,
        }, 'COALESCE(p.mcx, TRUE)');
        summary.mcx += ids.length ? 1 : 0;
      }
    }
    return summary;
  });
}

// ══════════════ PERSONAL: watchlist price alerts, moves, portfolio ══════════════
async function runPersonalScan() {
  return guarded('personal', async () => {
    const date = rules.istDate();
    const { rows: wl } = await query(
      `SELECT w.id, w.user_id, w.stock_symbol AS symbol, w.exchange, w.alert_price, w.alert_direction,
              COALESCE(p.watchlist, TRUE) AS want_watchlist, COALESCE(p.price_alerts, TRUE) AS want_price,
              COALESCE(p.watchlist_threshold, 3) AS thr, COALESCE(p.in_app, TRUE) AS in_app
         FROM watchlist w LEFT JOIN notification_prefs p ON p.user_id = w.user_id`);
    const { rows: pf } = await query(
      `SELECT h.id, h.user_id, h.stock_symbol AS symbol, h.exchange, h.buy_price,
              COALESCE(p.portfolio, TRUE) AS want_portfolio, COALESCE(p.watchlist_threshold, 3) AS thr,
              COALESCE(p.in_app, TRUE) AS in_app
         FROM portfolios h LEFT JOIN notification_prefs p ON p.user_id = h.user_id`);

    const keyOf = (r) => `${r.exchange || ''}|${r.symbol.toUpperCase()}`;
    const wanted = new Map();
    for (const r of [...wl, ...pf]) {
      if (!r.in_app || !sessionOpen(r.exchange)) continue;
      wanted.set(keyOf(r), { symbol: r.symbol, exchange: r.exchange || undefined });
    }
    if (!wanted.size) return { users: 0 };

    const { quotes } = await fetchQuotes([...wanted.values()]);
    // Quote map is keyed by resolved exchange; rows with a null exchange resolve NSE-then-BSE.
    const quoteFor = (r) => (r.exchange ? quotes.get(`${r.exchange}:${r.symbol.toUpperCase()}`)
      : quotes.get(`NSE_EQ:${r.symbol.toUpperCase()}`) || quotes.get(`BSE_EQ:${r.symbol.toUpperCase()}`));
    const levelsFor = (thr) => rules.MOVE_LEVELS.filter((l) => l >= Number(thr));
    let created = 0;

    for (const r of wl) {
      if (!r.in_app || !sessionOpen(r.exchange)) continue;
      const q = quoteFor(r);
      if (!q) continue;
      const ex = q.exchange;

      if (r.want_price && rules.priceAlertTriggered(r.alert_price, r.alert_direction, q.lastPrice)) {
        const hit = await notifications.notifyUser(r.user_id, {
          type: 'price_alert', category: 'price', severity: r.alert_direction === 'above' ? 'green' : 'red',
          symbol: r.symbol, exchange: ex,
          title: `🎯 ${r.symbol} hit your price alert`,
          body: `${r.symbol} is at ${rules.fmtPrice(q.lastPrice)} — ${r.alert_direction} your alert level of ${rules.fmtPrice(r.alert_price)}.`,
          data: { price: q.lastPrice, alertPrice: Number(r.alert_price), direction: r.alert_direction },
          dedupeKey: `price:${r.id}:${r.alert_direction}:${Number(r.alert_price)}`,
        }, { email: true });
        if (hit) created++;
      }

      if (r.want_watchlist) {
        const m = rules.moveMilestone(q.changePct, levelsFor(r.thr));
        if (m) {
          const hit = await notifications.notifyUser(r.user_id, {
            type: 'watchlist_move', category: 'watchlist', severity: sevFor(m.dir), symbol: r.symbol, exchange: ex,
            title: `⭐ Watchlist: ${r.symbol} ${dirWord(m.dir)} ${rules.fmtPct(q.changePct)}`,
            body: `${r.symbol} is at ${rules.fmtPrice(q.lastPrice)} (${rules.fmtPct(q.changePct)} today) — crossed the ${m.level}% milestone.`,
            data: { price: q.lastPrice, changePct: q.changePct, level: m.level },
            dedupeKey: `wl:${r.symbol}:${m.dir}:${m.level}:${date}`,
          }, { email: true });
          if (hit) created++;
        }
      }
    }

    for (const r of pf) {
      if (!r.in_app || !r.want_portfolio || !sessionOpen(r.exchange)) continue;
      const q = quoteFor(r);
      if (!q) continue;
      const ex = q.exchange;

      const m = rules.moveMilestone(q.changePct, levelsFor(r.thr));
      if (m) {
        const hit = await notifications.notifyUser(r.user_id, {
          type: 'portfolio_move', category: 'portfolio', severity: sevFor(m.dir), symbol: r.symbol, exchange: ex,
          title: `💼 Your holding ${r.symbol} ${dirWord(m.dir)} ${rules.fmtPct(q.changePct)}`,
          body: `${r.symbol} is at ${rules.fmtPrice(q.lastPrice)} (${rules.fmtPct(q.changePct)} today).`,
          data: { price: q.lastPrice, changePct: q.changePct, level: m.level },
          dedupeKey: `pf:${r.symbol}:${m.dir}:${m.level}:${date}`,
        }, { email: true });
        if (hit) created++;
      }

      const pnl = rules.pnlMilestone(Number(r.buy_price), q.lastPrice);
      if (pnl) {
        const hit = await notifications.notifyUser(r.user_id, {
          type: 'portfolio_pnl', category: 'portfolio', severity: sevFor(pnl.dir), symbol: r.symbol, exchange: ex,
          title: `${pnl.dir === 'up' ? '🏆' : '⚠️'} ${r.symbol} is ${pnl.dir === 'up' ? 'up' : 'down'} ${Math.abs(pnl.pct).toFixed(1)}% on your buy price`,
          body: `You bought at ${rules.fmtPrice(r.buy_price)}; it is now ${rules.fmtPrice(q.lastPrice)} (${rules.fmtPct(pnl.pct)}). Crossed the ${pnl.level}% P&L milestone.`,
          data: { buyPrice: Number(r.buy_price), price: q.lastPrice, pnlPct: pnl.pct, level: pnl.level },
          dedupeKey: `pnl:${r.id}:${pnl.dir}:${pnl.level}`,
        }, { email: true });
        if (hit) created++;
      }
    }
    return { symbolsQuoted: wanted.size, created };
  });
}

// ══════════════ SCREENER: strong technical alignment ══════════════
const handledSignals = new Set(); // `${id}` already processed today (in-memory; DB dedupe is the real guard)
let handledDate = null;

async function runScreenerScan() {
  return guarded('screener', async () => {
    const date = rules.istDate();
    if (handledDate !== date) { handledSignals.clear(); handledDate = date; }

    const { rows } = await query(
      `SELECT id, stock_symbol, exchange, signal, strength_score
         FROM scanner_signal_history
        WHERE signal_date = CURRENT_DATE AND timeframe = '1d'
          AND signal IN ('strong_bullish','strong_bearish') AND strength_score >= 60
        ORDER BY strength_score DESC LIMIT 300`);
    const fresh = rows.filter((r) => !handledSignals.has(r.id));
    let broadcastBudget = 10, personal = 0, market = 0;

    for (const s of fresh) {
      const bull = s.signal === 'strong_bullish';
      const dir = bull ? 'up' : 'down';
      const base = {
        type: 'screener_signal', severity: sevFor(dir), symbol: s.stock_symbol, exchange: s.exchange,
        title: `${bull ? '🟢' : '🔴'} ${s.stock_symbol} — strong ${bull ? 'bullish' : 'bearish'} technical alignment`,
        body: `Screener (daily): technical strength ${s.strength_score}/100 — most trend, momentum and volume indicators point ${bull ? 'up' : 'down'}. A descriptive reading of indicators, not a prediction or advice.`,
        data: { score: s.strength_score, signal: s.signal, timeframe: '1d' },
        dedupeKey: `scr:${s.stock_symbol}:${s.exchange || ''}:${s.signal}:${date}`,
      };

      // 1) users who hold / watch this symbol
      const { rows: owners } = await query(
        `SELECT DISTINCT x.user_id FROM (
            SELECT user_id FROM watchlist WHERE stock_symbol = $1
            UNION SELECT user_id FROM portfolios WHERE stock_symbol = $1) x
          LEFT JOIN notification_prefs p ON p.user_id = x.user_id
          WHERE COALESCE(p.in_app, TRUE) AND (COALESCE(p.watchlist, TRUE) OR COALESCE(p.portfolio, TRUE))
            AND COALESCE(p.min_signal_score, 80) <= $2`,
        [s.stock_symbol, s.strength_score]);
      for (const o of owners) {
        const hit = await notifications.notifyUser(o.user_id, { ...base, category: 'watchlist', title: `⭐ ${base.title}` }, { email: true });
        if (hit) personal++;
      }

      // 2) market-wide, for the curated universe / MCX only (never illiquid noise), capped per tick
      const inUniverse = s.exchange === 'MCX_FO' ? true : MARKET_SET.has(s.stock_symbol);
      const wantsMarket = inUniverse && s.strength_score >= 80;
      if (wantsMarket && broadcastBudget <= 0) continue; // not handled yet — picked up next tick
      if (wantsMarket) {
        const ids = await notifications.broadcast(
          { ...base, category: 'screener', dedupeKey: `${base.dedupeKey}:mkt` },
          // owners already got the personal version above — don't tell them twice
          `COALESCE(p.screener, TRUE) AND COALESCE(p.min_signal_score, 80) <= $1
             AND NOT EXISTS (SELECT 1 FROM notifications n2 WHERE n2.user_id = u.id AND n2.dedupe_key = $2)`,
          [s.strength_score, base.dedupeKey]);
        if (ids.length) { market++; broadcastBudget--; }
      }
      handledSignals.add(s.id);
    }
    return { signalsSeen: rows.length, newlyHandled: fresh.length, personal, market };
  });
}

async function runAll() {
  const personal = await runPersonalScan();
  const market = await runMarketScan();
  return { personal, market };
}

module.exports = { runPersonalScan, runMarketScan, runScreenerScan, runAll, MARKET_UNIVERSE };

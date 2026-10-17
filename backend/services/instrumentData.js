// services/instrumentData.js
// ══════════════════════════════════════════════════════════════════════════
//  Quotes, candles, market status and analysis context for ANY instrument in
//  the verified registry, addressed by its Upstox instrument_key. Everything
//  returned is real Upstox data, stamped with:
//     source (always "Upstox"), the data's own timestamp, market status and
//     whether it is real-time / delayed / last-close / historical.
//  When Upstox returns nothing (market closed, transient failure) we serve
//  the LAST VALID stored quote with its original timestamp and a
//  `fromStore` flag — we never zero a chart or fabricate a price.
// ══════════════════════════════════════════════════════════════════════════
const { query } = require('../db/pool');
const AppError = require('../utils/AppError');
const { upstoxGet, logError } = require('./upstoxHttp');
const { getInstrument, ensureSchema } = require('./upstoxRegistry');
const { indexQuotesByToken, parseQuote } = require('../utils/quoteUtils');
const { normalizeCandleRows, mergeCandles, validateTimeframe, maxRangeDays, isIntradayUnit } = require('../utils/candleUtils');
const { computeSeries, lastValue } = require('../utils/seriesIndicators');
const { analyze } = require('../utils/technicalAnalysis');
const {
  estimateMarketStatus, STATUS_API_EXCHANGE, interpretStatusString, classifyFreshness,
} = require('../utils/marketSession');

const iso = (d) => d.toISOString().slice(0, 10);

// ── market status (official API first, labelled estimate as fallback) ────
const statusCache = new Map(); // exchange → { at, value }
async function getMarketStatus(segment) {
  const apiExchange = STATUS_API_EXCHANGE[segment];
  if (apiExchange) {
    const hit = statusCache.get(apiExchange);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const r = await upstoxGet(`/v2/market/status/${apiExchange}`, {}, { retries: 0, timeoutMs: 6000 });
    const raw = r.ok ? r.data?.data?.status : null;
    const status = interpretStatusString(raw);
    if (status) {
      const value = { status, source: 'upstox-market-status-api', rawStatus: raw, hours: estimateMarketStatus(segment).hours };
      statusCache.set(apiExchange, { at: Date.now(), value });
      return value;
    }
  }
  return estimateMarketStatus(segment);
}

// ── quotes ──────────────────────────────────────────────────────────────
const quoteCache = new Map(); // key → { at, value }
const QUOTE_TTL_MS = 2000;
const lastSaved = new Map();  // key → "price|time" (skip no-op DB writes)

async function persistQuote(key, parsed, raw) {
  const sig = `${parsed.lastPrice}|${parsed.tradeTimeMs}`;
  if (lastSaved.get(key) === sig) return;
  lastSaved.set(key, sig);
  if (lastSaved.size > 5000) lastSaved.delete(lastSaved.keys().next().value);
  try {
    await query(
      `INSERT INTO market_last_quote (instrument_key, last_price, prev_close, trade_time, payload, saved_at)
       VALUES ($1,$2,$3,$4,$5,now())
       ON CONFLICT (instrument_key) DO UPDATE SET last_price=EXCLUDED.last_price, prev_close=EXCLUDED.prev_close,
         trade_time=EXCLUDED.trade_time, payload=EXCLUDED.payload, saved_at=now()`,
      [key, parsed.lastPrice, parsed.previousClose, parsed.tradeTimeMs ? new Date(parsed.tradeTimeMs) : null, JSON.stringify(raw)]);
  } catch (e) { logError({ module: 'instrumentData', kind: 'persist_quote_failed', message: e.message }); }
}

async function loadStoredQuote(key) {
  const { rows } = await query(`SELECT payload, trade_time, saved_at FROM market_last_quote WHERE instrument_key = $1`, [key]);
  if (!rows.length) return null;
  const parsed = parseQuote(rows[0].payload);
  return parsed ? { parsed, savedAt: rows[0].saved_at } : null;
}

function shapeQuote(inst, parsed, market, { fromStore = false, liveError = null, savedAt = null } = {}) {
  const freshness = classifyFreshness({
    marketStatus: market.status, tradeTimeMs: parsed.tradeTimeMs, segment: inst.segment, assetClass: inst.assetClass,
  });
  // A stored quote served because live fetch failed can never be called real-time.
  if (fromStore && freshness.mode === 'real-time') { freshness.mode = 'last-close'; }
  return {
    instrument: inst,
    quote: parsed,
    tradeTime: parsed.tradeTimeMs ? new Date(parsed.tradeTimeMs).toISOString() : null,
    market,
    freshness,
    source: 'Upstox',
    fromStore,
    ...(fromStore ? { storedAt: savedAt, liveError } : {}),
    fetchedAt: new Date().toISOString(),
  };
}

async function assertUsable(key) {
  await ensureSchema();
  const inst = await getInstrument(key);
  if (!inst) throw new AppError('Instrument is not in the verified Upstox registry.', 404);
  // A probe result is only a hint: a single failed probe (expired token, rate limit,
  // closed market) must never lock every instrument in a segment. Let the real
  // Upstox call decide — its own error message is surfaced if it truly refuses.
  return inst;
}

async function getQuote(instrumentKey) {
  const inst = await assertUsable(instrumentKey);
  const hit = quoteCache.get(instrumentKey);
  if (hit && Date.now() - hit.at < QUOTE_TTL_MS) return hit.value;

  const market = await getMarketStatus(inst.segment);
  const r = await upstoxGet('/v2/market-quote/quotes', { instrument_key: instrumentKey });
  const entry = r.ok ? indexQuotesByToken(r.data?.data).get(instrumentKey) || Object.values(r.data?.data || {})[0] : null;
  const parsed = parseQuote(entry);

  let value;
  if (parsed) {
    persistQuote(instrumentKey, parsed, entry);
    value = shapeQuote(inst, parsed, market);
  } else {
    const stored = await loadStoredQuote(instrumentKey);
    if (!stored) {
      throw new AppError(r.ok
        ? 'Upstox returned no quote for this instrument yet (no trade recorded).'
        : `Upstox quote unavailable: ${r.error}`, r.ok ? 404 : 503);
    }
    value = shapeQuote(inst, stored.parsed, market, { fromStore: true, liveError: r.ok ? 'empty response' : r.error, savedAt: stored.savedAt });
  }
  quoteCache.set(instrumentKey, { at: Date.now(), value });
  if (quoteCache.size > 2000) quoteCache.delete(quoteCache.keys().next().value);
  return value;
}

/** Batch (≤50 keys) in ONE upstream call — used by watchlists. Missing quotes fall back to the stored last valid quote. */
async function getQuotesBatch(keys) {
  const unique = [...new Set(keys)].slice(0, 50);
  if (!unique.length) return [];
  await ensureSchema();
  const { rows } = await query(`SELECT instrument_key FROM market_registry WHERE instrument_key = ANY($1)`, [unique]);
  const valid = rows.map((r) => r.instrument_key);
  if (!valid.length) return [];
  const insts = new Map();
  for (const k of valid) insts.set(k, await getInstrument(k));

  // Upstox splits instrument_key on commas, so a key that itself contains one must be asked for on its own.
  const batchKeys = valid.filter((k) => !k.includes(','));
  const loneKeys = valid.filter((k) => k.includes(','));
  const r = batchKeys.length ? await upstoxGet('/v2/market-quote/quotes', { instrument_key: batchKeys.join(',') }) : { ok: true, data: { data: {} } };
  const byTok = r.ok ? indexQuotesByToken(r.data?.data) : new Map();
  for (const k of loneKeys) {
    const one = await upstoxGet('/v2/market-quote/quotes', { instrument_key: k });
    if (one.ok) { const e = indexQuotesByToken(one.data?.data).get(k) || Object.values(one.data?.data || {})[0]; if (e) byTok.set(k, e); }
  }
  const out = [];
  for (const k of valid) {
    const inst = insts.get(k);
    const market = await getMarketStatus(inst.segment);
    const entry = byTok.get(k);
    const parsed = parseQuote(entry);
    if (parsed) { persistQuote(k, parsed, entry); out.push(shapeQuote(inst, parsed, market)); continue; }
    const stored = await loadStoredQuote(k);
    if (stored) out.push(shapeQuote(inst, stored.parsed, market, { fromStore: true, liveError: r.ok ? 'empty response' : r.error, savedAt: stored.savedAt }));
    else out.push({ instrument: inst, quote: null, market, freshness: { mode: 'unknown', stale: false }, source: 'Upstox', fromStore: false, error: r.ok ? 'No quote returned yet.' : r.error });
  }
  return out;
}

// ── candles ─────────────────────────────────────────────────────────────
const candleCache = new Map(); // cacheKey → { at, ttl, value }
const lastGoodCandles = new Map();

function defaultFrom(unit, interval) {
  const d = new Date();
  d.setDate(d.getDate() - Math.min(maxRangeDays(unit, interval), unit === 'minutes' ? (interval <= 5 ? 7 : 30) : unit === 'hours' ? 60 : unit === 'days' ? 365 : 3650));
  return iso(d);
}
const barMs = (unit, interval) => interval * ({ minutes: 60e3, hours: 3600e3, days: 86400e3, weeks: 7 * 86400e3, months: 30 * 86400e3 }[unit]);

async function fetchCandleSet(key, unit, interval, from, to) {
  const toDate = to || iso(new Date());
  const histPath = `/v3/historical-candle/${encodeURIComponent(key)}/${unit}/${interval}/${toDate}/${from}`;
  const wantIntraday = unit !== 'weeks' && unit !== 'months' && toDate >= iso(new Date());

  const [hist, intra] = await Promise.all([
    upstoxGet(histPath),
    wantIntraday ? upstoxGet(`/v3/historical-candle/intraday/${encodeURIComponent(key)}/${unit}/${interval}`, {}, { retries: 1 }) : Promise.resolve(null),
  ]);
  if (!hist.ok) return { error: hist };
  const h = normalizeCandleRows(hist.data?.data?.candles);
  const i = intra && intra.ok ? normalizeCandleRows(intra.data?.data?.candles) : { candles: [], dropped: 0 };
  return {
    candles: mergeCandles(h.candles, i.candles),
    dropped: h.dropped + i.dropped,
    intradayNote: intra && !intra.ok ? `intraday unavailable: ${intra.error}` : null,
  };
}

async function getCandles(instrumentKey, { unit = 'days', interval = 1, from, to, indicators = true, requested } = {}) {
  const tfError = validateTimeframe(unit, interval);
  if (tfError) throw new AppError(tfError, 400);
  const inst = await assertUsable(instrumentKey);

  const toDate = to || iso(new Date());
  let fromDate = from || defaultFrom(unit, interval);
  const earliest = new Date(toDate); earliest.setDate(earliest.getDate() - maxRangeDays(unit, interval));
  if (fromDate < iso(earliest)) fromDate = iso(earliest); // clamp to the documented window

  const cacheKey = `${instrumentKey}|${unit}|${interval}|${fromDate}|${toDate}`;
  const hit = candleCache.get(cacheKey);
  const market = await getMarketStatus(inst.segment);
  let set, servedStale = false, upstreamError = null;
  if (hit && Date.now() - hit.at < hit.ttl) {
    set = hit.value;
  } else {
    const fresh = await fetchCandleSet(instrumentKey, unit, interval, fromDate, toDate);
    if (fresh.error) {
      const good = lastGoodCandles.get(cacheKey);
      if (!good) throw new AppError(`Upstox candle request failed: ${fresh.error.error}`, fresh.error.status === 401 || fresh.error.status === 403 ? 403 : 502);
      set = good; servedStale = true; upstreamError = fresh.error.error;
    } else {
      set = fresh;
      if (fresh.candles.length) lastGoodCandles.set(cacheKey, fresh);
      candleCache.set(cacheKey, { at: Date.now(), ttl: market.status === 'open' && isIntradayUnit(unit) ? 15_000 : 60_000, value: fresh });
      if (candleCache.size > 400) candleCache.delete(candleCache.keys().next().value);
      if (lastGoodCandles.size > 400) lastGoodCandles.delete(lastGoodCandles.keys().next().value);
    }
  }

  const candles = set.candles;
  const last = candles[candles.length - 1] || null;
  const freshness = last
    ? classifyFreshness({ marketStatus: market.status, tradeTimeMs: Math.min(Date.now(), last.ts + barMs(unit, interval)), segment: inst.segment, assetClass: inst.assetClass })
    : { mode: 'unknown', ageSeconds: null, stale: false };
  // For a candle series, "last-close" is simply historical data.
  const dataMode = servedStale ? 'delayed' : freshness.mode === 'last-close' ? 'historical' : freshness.mode;

  return {
    instrument: inst,
    unit, interval, from: fromDate, to: toDate,
    candles: candles.map((c) => ({ t: c.t, time: Math.floor(c.ts / 1000), o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, oi: c.oi })),
    indicators: indicators && candles.length ? computeSeries(candles, { requested, isIntraday: isIntradayUnit(unit) }) : null,
    meta: {
      source: 'Upstox',
      count: candles.length,
      droppedMalformed: set.dropped,
      firstCandleAt: candles[0]?.t || null,
      lastCandleAt: last?.t || null,
      dataMode, freshness, market,
      servedFromLastGood: servedStale,
      ...(upstreamError ? { upstreamError } : {}),
      ...(set.intradayNote ? { note: set.intradayNote } : {}),
      fetchedAt: new Date().toISOString(),
    },
  };
}

// ── analysis context (for AI) ───────────────────────────────────────────
const round = (v, dp = 2) => (v === null || v === undefined ? null : Number(v.toFixed(dp)));

async function getAnalysisContext(instrumentKey, { unit = 'days', interval = 1 } = {}) {
  const [candleRes, quoteRes] = await Promise.allSettled([
    getCandles(instrumentKey, { unit, interval, indicators: true }),
    getQuote(instrumentKey),
  ]);
  if (candleRes.status === 'rejected') throw candleRes.reason;
  const c = candleRes.value;
  if (c.candles.length < 30) {
    throw new AppError(`Only ${c.candles.length} real candles are available from Upstox for this instrument/timeframe — not enough to compute indicators (need 30+).`, 422);
  }
  const ind = c.indicators;
  const closes = c.candles.map((x) => x.c);
  const lastClose = closes[closes.length - 1];
  const hi = Math.max(...c.candles.map((x) => x.h));
  const lo = Math.min(...c.candles.map((x) => x.l));
  const ctx = {
    instrument: { key: c.instrument.instrumentKey, symbol: c.instrument.symbol, name: c.instrument.displayName, segment: c.instrument.segment, assetClass: c.instrument.assetClass, expiry: c.instrument.expiry },
    timeframe: `${interval} ${unit}`,
    dataSource: 'Upstox',
    dataMode: c.meta.dataMode,
    marketStatus: c.meta.market.status,
    asOf: c.meta.lastCandleAt,
    candlesUsed: c.candles.length,
    lastClose: round(lastClose),
    rangeHigh: round(hi), rangeLow: round(lo),
    indicators: {
      ema20: round(lastValue(ind.ema20)), ema50: round(lastValue(ind.ema50)),
      rsi14: round(lastValue(ind.rsi)),
      macd: round(lastValue(ind.macd.macd), 4), macdSignal: round(lastValue(ind.macd.signal), 4), macdHistogram: round(lastValue(ind.macd.hist), 4),
      bollingerUpper: round(lastValue(ind.bb.upper)), bollingerMid: round(lastValue(ind.bb.mid)), bollingerLower: round(lastValue(ind.bb.lower)),
      atr14: round(lastValue(ind.atr)),
      vwap: round(lastValue(ind.vwap)),
    },
    technical: analyze(c.candles.map((x) => ({ h: x.h, l: x.l, c: x.c, v: x.v }))),
    lastCandleTs: c.candles.length ? c.candles[c.candles.length - 1].time * 1000 : null,
    liveQuote: quoteRes.status === 'fulfilled' && quoteRes.value.quote ? {
      lastPrice: quoteRes.value.quote.lastPrice, changePct: round(quoteRes.value.quote.changePct),
      volume: quoteRes.value.quote.volume, openInterest: quoteRes.value.quote.openInterest,
      tradeTime: quoteRes.value.tradeTime, mode: quoteRes.value.freshness.mode,
    } : null,
  };
  return ctx;
}

/** Test hook: clears every in-memory cache so cases don't bleed into each other. */
function _resetCachesForTests() {
  statusCache.clear(); quoteCache.clear(); candleCache.clear(); lastGoodCandles.clear(); lastSaved.clear();
}

/** Test hook: expires the short-TTL candle cache but keeps the last-good snapshots. */
function _expireCandleCacheForTests() { candleCache.clear(); }

module.exports = { getMarketStatus, getQuote, getQuotesBatch, getCandles, getAnalysisContext, _resetCachesForTests, _expireCandleCacheForTests };

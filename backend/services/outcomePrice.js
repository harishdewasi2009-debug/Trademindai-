// services/outcomePrice.js
// ══════════════════════════════════════════════════════════════════════════
//  The REAL price an old signal/analysis should be judged against.
//
//  Why this exists: both evaluators used to call getLtp(symbol) once per row
//  and judge against whatever the price was *at the moment the cron ran*.
//  That broke "verified" in three ways:
//   1. ~thousands of single quote calls per run (full NSE+BSE+MCX coverage)
//      → Upstox rate limits → every failed lookup left the row pending forever.
//   2. A late catch-up run judged a signal against TODAY's price, not the
//      price on the day it was due.
//   3. MCX symbols re-resolved to the CURRENT front-month contract, so a
//      signal made on an expired contract was judged against a different one.
//
//  Now:
//   • the instrument_key stored at log time is used (falls back to symbol lookup)
//   • target day >= today (evaluated right after the close) → ONE batched quote
//     call per 50 instruments
//   • target day already past → the official daily candle CLOSE of that day
//   • every failure carries a reason so nothing fails silently
// ══════════════════════════════════════════════════════════════════════════
const { upstoxGet } = require('./upstoxHttp');
const { parseQuote, indexQuotesByToken } = require('../utils/quoteUtils');
const { normalizeCandleRows } = require('../utils/candleUtils');

const istDate = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);
const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const QUOTE_CHUNK = 50;
const LOOKBACK_DAYS = 8;

/** Pure: close of the last candle dated on/before targetDate (and within the lookback).
 *  exact=true → only a candle dated exactly targetDate counts (a trading day must have one). */
function pickClose(candles, targetDate, { exact = false } = {}) {
  const floor = addDays(targetDate, -LOOKBACK_DAYS);
  let best = null;
  for (const c of candles || []) {
    const d = String(c.t || '').slice(0, 10); // Upstox stamps daily candles with the IST date
    if (!d || d > targetDate || d < floor) continue;
    if (!best || d >= best.date) best = { date: d, price: c.c };
  }
  if (!best) return null;
  if (exact && best.date !== targetDate) return null;
  return best;
}

/** Pure: split "A|1,B|2" lists on commas that start a new SEGMENT|… key, so keys that contain commas survive. */
function splitKeyList(s) {
  return String(s || '').split(/,(?=[A-Za-z0-9_]+\|)/).map((x) => x.trim()).filter(Boolean);
}

async function resolveKey(item, cache) {
  if (item.instrumentKey) return item.instrumentKey;
  const ck = `${String(item.symbol).toUpperCase()}:${item.exchange || ''}`;
  if (!cache.has(ck)) {
    cache.set(ck, (async () => {
      const { resolveInstrumentKey } = require('./marketDataService'); // lazy: avoids a require cycle
      return resolveInstrumentKey(item.symbol, item.exchange || undefined);
    })().catch((e) => ({ error: `could not resolve instrument: ${e.message}` })));
  }
  return cache.get(ck);
}

async function quotePrices(keys) {
  const out = new Map(); // key → { price } | { error }
  const singles = keys.filter((k) => k.includes(','));
  const batched = keys.filter((k) => !k.includes(','));
  const chunks = [];
  for (let i = 0; i < batched.length; i += QUOTE_CHUNK) chunks.push(batched.slice(i, i + QUOTE_CHUNK));
  singles.forEach((k) => chunks.push([k]));
  for (const chunk of chunks) {
    const r = await upstoxGet('/v2/market-quote/quotes', { instrument_key: chunk.join(',') });
    if (!r.ok) { chunk.forEach((k) => out.set(k, { error: `quote request failed: ${r.error}` })); continue; }
    const byTok = indexQuotesByToken(r.data?.data);
    for (const k of chunk) {
      const parsed = parseQuote(byTok.get(k) || (chunk.length === 1 ? Object.values(r.data?.data || {})[0] : null));
      out.set(k, parsed ? { price: parsed.lastPrice } : { error: 'Upstox returned no price for this instrument' });
    }
  }
  return out;
}

async function candleClose(key, targetDate, exact) {
  const r = await upstoxGet(`/v3/historical-candle/${encodeURIComponent(key)}/days/1/${targetDate}/${addDays(targetDate, -LOOKBACK_DAYS)}`);
  if (!r.ok) return { error: `candle request failed: ${r.error}` };
  const { candles } = normalizeCandleRows(r.data?.data?.candles);
  const hit = pickClose(candles, targetDate, { exact });
  return hit ? { price: hit.price, date: hit.date } : { error: `no daily candle for ${targetDate}` };
}

/**
 * items: [{ id, symbol, exchange, instrumentKey?, targetDate: 'YYYY-MM-DD' (IST), exact?: boolean }]
 * returns Map(id → { price, source, date? } | { error })
 */
async function fetchOutcomePrices(items, { concurrency = 4, today = istDate() } = {}) {
  const result = new Map();
  const keyCache = new Map();
  const live = [], past = [];
  for (const it of items) {
    const key = await resolveKey(it, keyCache);
    if (key && typeof key === 'object') { result.set(it.id, { error: key.error }); continue; }
    (it.targetDate >= today ? live : past).push({ ...it, key });
  }

  if (live.length) {
    const prices = await quotePrices([...new Set(live.map((i) => i.key))]);
    for (const it of live) {
      const p = prices.get(it.key);
      result.set(it.id, p && p.price != null ? { price: p.price, source: 'quote' } : { error: (p && p.error) || 'no price' });
    }
  }

  if (past.length) {
    const uniq = new Map(); // key|date|exact → [items]
    for (const it of past) {
      const k = `${it.key}|${it.targetDate}|${it.exact ? 1 : 0}`;
      if (!uniq.has(k)) uniq.set(k, []);
      uniq.get(k).push(it);
    }
    const entries = [...uniq.entries()];
    let i = 0;
    const worker = async () => {
      while (i < entries.length) {
        const [, group] = entries[i++];
        let res;
        try { res = await candleClose(group[0].key, group[0].targetDate, !!group[0].exact); }
        catch (e) { res = { error: e.message }; }
        for (const it of group) {
          result.set(it.id, res.price != null ? { price: res.price, source: 'daily-close', date: res.date } : { error: res.error });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  }
  return result;
}

module.exports = { fetchOutcomePrices, pickClose, splitKeyList, istDate, addDays };

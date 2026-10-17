// services/upstoxProbe.js
// ══════════════════════════════════════════════════════════════════════════
//  Live capability probes. For every segment found in the instrument master
//  this makes REAL authorized Upstox API calls against a few real instruments
//  from that segment and records what actually came back. A capability is
//  only ever shown as available after a probe proved it with real data —
//  nothing is assumed from a segment's name or from documentation.
// ══════════════════════════════════════════════════════════════════════════
const { query } = require('../db/pool');
const { upstoxGet, logError } = require('./upstoxHttp');
const { indexQuotesByToken, parseQuote } = require('../utils/quoteUtils');
const { normalizeCandleRows } = require('../utils/candleUtils');
const { classifyOutcome, deriveAccessStatus } = require('../utils/probeLogic');
const { estimateMarketStatus } = require('../utils/marketSession');
const { ensureSchema, listSegments } = require('./upstoxRegistry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

// Interval ladder verified per segment (unit:interval). Each is one small real historical call.
const INTERVAL_LADDER = [
  ['minutes', 1], ['minutes', 5], ['minutes', 15], ['minutes', 30], ['hours', 1], ['days', 1], ['weeks', 1], ['months', 1],
];
// How far back each ladder step looks (must be a valid range for that step).
const LADDER_LOOKBACK = { minutes: 10, hours: 20, days: 15, weeks: 60, months: 200 };

/** Pick real sample instruments for a segment from the registry (a PREFERENCE ordering, never invented rows). */
async function pickSamples(segment) {
  const pref = ['NIFTY 50', 'NIFTY BANK', 'SENSEX', 'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'SBIN', 'GOLD', 'CRUDEOIL', 'USDINR'];
  const { rows: plain } = await query(
    `SELECT instrument_key, symbol, name FROM market_registry
      WHERE segment = $1 AND expiry IS NULL
      ORDER BY (upper(symbol) = ANY($2) OR upper(name) = ANY($2)) DESC, symbol LIMIT 3`, [segment, pref]);
  const { rows: futs } = await query(
    `SELECT instrument_key, symbol FROM market_registry
      WHERE segment = $1 AND expiry >= CURRENT_DATE AND instrument_type = 'FUT'
      ORDER BY (upper(underlying_symbol) = ANY($2)) DESC, expiry, symbol LIMIT 3`, [segment, pref]);
  const { rows: opts } = await query(
    `SELECT instrument_key, underlying_key, to_char(expiry,'YYYY-MM-DD') AS expiry FROM market_registry
      WHERE segment = $1 AND expiry >= CURRENT_DATE AND instrument_type IN ('CE','PE') AND underlying_key IS NOT NULL
      ORDER BY (upper(underlying_symbol) = ANY($2)) DESC, expiry, strike_price LIMIT 1`, [segment, pref]);
  const quoteKeys = [...plain, ...futs].map((r) => r.instrument_key).slice(0, 4);
  return { quoteKeys, primary: quoteKeys[0] || null, option: opts[0] || null };
}

const hasEntries = (res) => res.ok && res.data?.data && Object.keys(res.data.data).length > 0;

async function probeSegment(segment) {
  const marketOpen = estimateMarketStatus(segment).status !== 'closed';
  const samples = await pickSamples(segment);
  const out = {
    quote: 'untested', ohlc: 'untested', candles: 'untested', intraday: 'untested',
    optionChain: 'n/a', greeks: 'n/a', intervals: [], notes: [],
  };
  if (!samples.primary) {
    return { ...out, samples, notes: ['No instruments to probe in this segment.'] };
  }

  // 1) Full quotes
  const q = await upstoxGet('/v2/market-quote/quotes', { instrument_key: samples.quoteKeys.join(',') });
  const parsed = q.ok ? [...indexQuotesByToken(q.data?.data).values()].map(parseQuote).filter(Boolean) : [];
  out.quote = classifyOutcome(q, parsed.length > 0, marketOpen);
  if (!q.ok) out.notes.push(`quotes: ${q.status} ${q.error}`);
  await sleep(250);

  // 2) OHLC
  const o = await upstoxGet('/v2/market-quote/ohlc', { instrument_key: samples.quoteKeys.join(','), interval: '1d' });
  out.ohlc = classifyOutcome(o, hasEntries(o), marketOpen);
  if (!o.ok) out.notes.push(`ohlc: ${o.status} ${o.error}`);
  await sleep(250);

  // 3) Historical candles — every interval on the ladder, individually proven.
  // FIX: ONE sample instrument decided every interval for the whole segment, so a single illiquid/suspended
  // sample (or a 429) wrongly marked a timeframe unsupported for thousands of instruments. Now each interval
  // is tried on up to 3 real samples and counts as proven as soon as ANY of them returns candles.
  const candleKeys = [...new Set([samples.primary, ...samples.quoteKeys])].slice(0, 3);
  for (const [unit, interval] of INTERVAL_LADDER) {
    let proven = false, lastRes = null;
    for (const key of candleKeys) {
      const path = `/v3/historical-candle/${encodeURIComponent(key)}/${unit}/${interval}/${iso(new Date())}/${daysAgo(LADDER_LOOKBACK[unit])}`;
      const r = await upstoxGet(path, {}, { retries: 1 });
      lastRes = { r, n: normalizeCandleRows(r.data?.data?.candles).candles.length };
      await sleep(250);
      if (r.ok && lastRes.n) { proven = true; break; }
    }
    if (proven) out.intervals.push(`${unit}:${interval}`);
    if (unit === 'days' && interval === 1 && lastRes) {
      out.candles = proven ? 'verified' : classifyOutcome(lastRes.r, lastRes.n > 0, marketOpen);
      if (!proven && !lastRes.r.ok) out.notes.push(`historical(days): ${lastRes.r.status} ${lastRes.r.error}`);
    }
  }
  if (out.candles === 'untested') out.candles = out.intervals.length ? 'verified' : 'empty';

  // 4) Intraday (today's) candles
  const i = await upstoxGet(`/v3/historical-candle/intraday/${encodeURIComponent(samples.primary)}/minutes/5`, {}, { retries: 1 });
  out.intraday = classifyOutcome(i, normalizeCandleRows(i.data?.data?.candles).candles.length > 0, marketOpen);
  if (!i.ok) out.notes.push(`intraday: ${i.status} ${i.error}`);
  await sleep(250);

  // 5) Option chain + Greeks — only where the segment really has options.
  if (samples.option) {
    const oc = await upstoxGet('/v2/option/chain', { instrument_key: samples.option.underlying_key, expiry_date: samples.option.expiry });
    out.optionChain = classifyOutcome(oc, Array.isArray(oc.data?.data) && oc.data.data.length > 0, marketOpen);
    if (!oc.ok) out.notes.push(`option chain: ${oc.status} ${oc.error}`);
    await sleep(250);
    const g = await upstoxGet('/v3/market-quote/option-greek', { instrument_key: samples.option.instrument_key });
    out.greeks = classifyOutcome(g, hasEntries(g), marketOpen);
    if (!g.ok) out.notes.push(`greeks: ${g.status} ${g.error}`);
  }
  return { ...out, samples };
}

async function saveProbe(segment, p) {
  // An interval proven once stays proven: a later probe that ran while the market was closed, rate limited
  // or on an illiquid sample must not erase it.
  let prior = [];
  try {
    const { rows } = await query('SELECT intervals_verified FROM market_segment_status WHERE segment = $1', [segment]);
    prior = rows[0] && rows[0].intervals_verified ? rows[0].intervals_verified.split(',').filter(Boolean) : [];
  } catch { /* first probe */ }
  const order = INTERVAL_LADDER.map(([u, i]) => `${u}:${i}`);
  p.intervals = [...new Set([...prior, ...p.intervals])].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const access = deriveAccessStatus([p.quote, p.ohlc, p.candles, p.intraday]);
  await query(
    `UPDATE market_segment_status SET
        access_status = $2, quote_status = $3, ohlc_status = $4, candles_status = $5, intraday_status = $6,
        option_chain_status = $7, greeks_status = $8, intervals_verified = $9, sample_keys = $10,
        last_probed_at = now(), notes = $11
      WHERE segment = $1 AND instrument_count > 0`,
    [segment, access, p.quote, p.ohlc, p.candles, p.intraday, p.optionChain, p.greeks,
     p.intervals.join(','), (p.samples?.quoteKeys || []).join(','), p.notes.join(' | ').slice(0, 1000) || null]);
  return access;
}

let probing = null;
let lastProbeRun = { at: null, results: {} };

/** Probes every segment that has instruments (or just `only`). One run at a time. */
function probeAll({ only } = {}) {
  if (probing) return probing;
  probing = (async () => {
    await ensureSchema();
    const segs = (await listSegments()).filter((s) => s.instrumentCount > 0 && (!only || only.includes(s.segment)));
    const results = {};
    for (const s of segs) {
      try {
        const p = await probeSegment(s.segment);
        results[s.segment] = await saveProbe(s.segment, p);
      } catch (e) {
        results[s.segment] = 'PROBE INCONCLUSIVE';
        logError({ module: 'probe', segment: s.segment, kind: 'probe_failed', message: e.message });
      }
    }
    lastProbeRun = { at: new Date().toISOString(), results };
    console.log('[probe] done', JSON.stringify(results));
    return lastProbeRun;
  })().finally(() => { probing = null; });
  return probing;
}

/** Streaming proof: called by liveFeedService on the first tick for a segment. */
async function recordStreamingTick(segment) {
  try {
    await query(
      `UPDATE market_segment_status SET streaming_status = 'verified', last_tick_at = now() WHERE segment = $1`, [segment]);
  } catch (e) { logError({ module: 'probe', kind: 'tick_record_failed', message: e.message }); }
}

/** Runs the full probe once if no segment has ever been probed (first connect). */
async function probeIfNeverRun() {
  try {
    await ensureSchema();
    const { rows } = await query('SELECT COUNT(*)::int AS n FROM market_segment_status WHERE last_probed_at IS NOT NULL');
    const { rows: [{ c }] } = await query('SELECT COUNT(*)::int AS c FROM market_registry');
    if (rows[0].n === 0 && c > 0) await probeAll();
  } catch (e) { logError({ module: 'probe', kind: 'first_probe_failed', message: e.message }); }
}

const getLastProbeRun = () => ({ ...lastProbeRun, running: !!probing });

module.exports = { probeAll, probeSegment, probeIfNeverRun, recordStreamingTick, getLastProbeRun };

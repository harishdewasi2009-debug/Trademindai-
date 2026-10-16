// services/upstoxRegistry.js
// ══════════════════════════════════════════════════════════════════════════
//  Verified Market Registry — built ONLY from Upstox's official instrument
//  master. Nothing is hand-typed or seeded: every row, every segment name and
//  every count comes from the downloaded file. Segments are discovered, not
//  whitelisted; expected-but-absent segments are reported as
//  "UNSUPPORTED BY UPSTOX" rather than silently dropped or faked.
//
//  Memory: the master is streamed (utils/jsonArrayStream.js) and written to
//  Postgres in 2,000-row batches, so peak RAM stays small even for the
//  100MB+ complete.json.gz — this matters on a 512MB instance.
// ══════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { query } = require('../db/pool');
const AppError = require('../utils/AppError');
const { streamGzipJsonArray } = require('../utils/jsonArrayStream');
const { normalizeInstrument, EXPECTED_SEGMENTS } = require('../utils/instrumentClassifier');
const { logError } = require('./upstoxHttp');

const MASTER_BASE = 'https://assets.upstox.com/market-quote/instruments/exchange';
// Preferred: the single "complete" file (a superset — it is where any segment
// beyond NSE/BSE/MCX would appear). Fallback: the per-exchange files.
const DEFAULT_SOURCES = [
  [`${MASTER_BASE}/complete.json.gz`],
  [`${MASTER_BASE}/NSE.json.gz`, `${MASTER_BASE}/BSE.json.gz`, `${MASTER_BASE}/MCX.json.gz`],
];
function sourcePlans() {
  const override = (process.env.UPSTOX_INSTRUMENT_FILES || '').split(',').map((s) => s.trim()).filter(Boolean);
  return override.length ? [override] : DEFAULT_SOURCES;
}

// ── schema bootstrap (idempotent) ───────────────────────────────────────
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
      const marker = 'VERIFIED MARKET REGISTRY';
      const idx = sql.indexOf(marker);
      if (idx === -1) throw new Error('registry schema block missing from schema.sql');
      const start = sql.lastIndexOf('-- ═', idx);
      await query(sql.slice(start === -1 ? idx : start));
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

// ── refresh ─────────────────────────────────────────────────────────────
let refreshing = null;
let lastRefresh = { at: null, ok: null, rows: 0, source: null, error: null };
const getRefreshState = () => ({ ...lastRefresh, running: !!refreshing });

const COLS = ['instrument_key', 'symbol', 'name', 'asset_class', 'exchange', 'segment', 'instrument_type', 'currency',
  'expiry', 'strike_price', 'lot_size', 'tick_size', 'isin', 'underlying_key', 'underlying_symbol', 'exchange_token'];

async function upsertBatch(records, refreshId) {
  if (!records.length) return;
  const cols = COLS.map((c) => records.map((r) => (r[c] === undefined || r[c] === null ? null : String(r[c]))));
  await query(
    `INSERT INTO market_registry
       (instrument_key, symbol, name, asset_class, exchange, segment, instrument_type, currency,
        expiry, strike_price, lot_size, tick_size, isin, underlying_key, underlying_symbol, exchange_token, refresh_id, updated_at)
     SELECT k, s, n, ac, ex, sg, it, cu, e::date, sp::numeric, ls::numeric, ts::numeric, isn, uk, us, et, $17::bigint, now()
     FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],
                 $9::text[],$10::text[],$11::text[],$12::text[],$13::text[],$14::text[],$15::text[],$16::text[])
          AS t(k,s,n,ac,ex,sg,it,cu,e,sp,ls,ts,isn,uk,us,et)
     ON CONFLICT (instrument_key) DO UPDATE SET
       symbol=EXCLUDED.symbol, name=EXCLUDED.name, asset_class=EXCLUDED.asset_class, exchange=EXCLUDED.exchange,
       segment=EXCLUDED.segment, instrument_type=EXCLUDED.instrument_type, currency=EXCLUDED.currency,
       expiry=EXCLUDED.expiry, strike_price=EXCLUDED.strike_price, lot_size=EXCLUDED.lot_size, tick_size=EXCLUDED.tick_size,
       isin=EXCLUDED.isin, underlying_key=EXCLUDED.underlying_key, underlying_symbol=EXCLUDED.underlying_symbol,
       exchange_token=EXCLUDED.exchange_token, refresh_id=EXCLUDED.refresh_id, updated_at=now()`,
    [...cols, refreshId]
  );
}

async function ingestFile(url, refreshId, seenKeys) {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  let skipped = 0;
  const total = await streamGzipJsonArray(res.body, async (rows) => {
    const records = [];
    for (const row of rows) {
      const rec = normalizeInstrument(row);
      if (!rec) { skipped++; continue; }
      if (seenKeys.has(rec.instrument_key)) continue; // same key twice in one batch would break ON CONFLICT
      seenKeys.add(rec.instrument_key);
      records.push(rec);
    }
    await upsertBatch(records, refreshId);
  }, { batchSize: 2000 });
  return { total, skipped };
}

async function purgeStale(refreshId) {
  let removed = 0;
  for (;;) {
    const r = await query(
      `DELETE FROM market_registry WHERE ctid IN (
         SELECT ctid FROM market_registry WHERE refresh_id < $1 LIMIT 5000)`, [refreshId]);
    removed += r.rowCount;
    if (r.rowCount < 5000) break;
  }
  return removed;
}

async function recomputeSegmentCounts() {
  await query(
    `INSERT INTO market_segment_status (segment, instrument_count, master_refreshed_at)
       SELECT segment, COUNT(*)::int, now() FROM market_registry GROUP BY segment
     ON CONFLICT (segment) DO UPDATE SET instrument_count = EXCLUDED.instrument_count, master_refreshed_at = now()`);
  // Segments that vanished from the master.
  await query(
    `UPDATE market_segment_status s SET instrument_count = 0, access_status = 'UNSUPPORTED BY UPSTOX'
      WHERE NOT EXISTS (SELECT 1 FROM market_registry r WHERE r.segment = s.segment)`);
  // A segment with rows but still marked unsupported/unverified becomes UNVERIFIED (probe decides the rest).
  await query(
    `UPDATE market_segment_status SET access_status = 'UNVERIFIED'
      WHERE instrument_count > 0 AND access_status = 'UNSUPPORTED BY UPSTOX'`);
}

/** Downloads + ingests the official master. Safe to call concurrently (one run at a time). */
function refreshRegistry({ force = false } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    await ensureSchema();
    const { rows: [{ n, newest }] } = await query(`SELECT COUNT(*)::int AS n, MAX(updated_at) AS newest FROM market_registry`);
    if (!force && n > 0 && newest && Date.now() - new Date(newest).getTime() < 20 * 3600 * 1000) {
      lastRefresh = { ...lastRefresh, ok: true, rows: n, at: new Date(newest).toISOString(), source: 'cached-in-db', error: null };
      return lastRefresh;
    }
    const refreshId = Date.now();
    let lastError = null;
    for (const plan of sourcePlans()) {
      try {
        const seen = new Set();
        let rowsIn = 0;
        for (const url of plan) {
          const r = await ingestFile(url, refreshId, seen);
          rowsIn += r.total;
        }
        if (seen.size === 0) throw new Error('master parsed to 0 instruments');
        // Safety net: don't purge on a suspiciously small refresh (truncated download).
        if (n > 0 && seen.size < n * 0.5) throw new Error(`refresh returned ${seen.size} rows vs ${n} existing — refusing to purge`);
        const removed = await purgeStale(refreshId);
        await recomputeSegmentCounts();
        await markExpectedMissing();
        lastRefresh = { at: new Date().toISOString(), ok: true, rows: seen.size, source: plan.join(' + '), error: null, removed, rowsIn };
        console.log('[registry] refreshed', JSON.stringify(lastRefresh));
        return lastRefresh;
      } catch (e) {
        lastError = e;
        logError({ module: 'registry', kind: 'refresh_failed', source: plan.join(','), message: e.message });
      }
    }
    lastRefresh = { ...lastRefresh, at: new Date().toISOString(), ok: false, error: lastError ? lastError.message : 'unknown' };
    throw new AppError(`Instrument master refresh failed: ${lastRefresh.error}`, 502);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** Expected segment with zero rows → explicit "UNSUPPORTED BY UPSTOX" record (never an integration). */
async function markExpectedMissing() {
  for (const seg of EXPECTED_SEGMENTS) {
    await query(
      `INSERT INTO market_segment_status (segment, instrument_count, master_refreshed_at, access_status, notes)
       SELECT $1, 0, now(), 'UNSUPPORTED BY UPSTOX', 'No instruments with this segment exist in the current Upstox instrument master.'
        WHERE NOT EXISTS (SELECT 1 FROM market_registry WHERE segment = $1)
       ON CONFLICT (segment) DO UPDATE SET instrument_count = 0, access_status = 'UNSUPPORTED BY UPSTOX',
         master_refreshed_at = now(), notes = EXCLUDED.notes`, [seg]);
  }
}

// ── reads ───────────────────────────────────────────────────────────────
const SEG_JOIN = `
  LEFT JOIN market_segment_status s ON s.segment = r.segment
  LEFT JOIN market_last_quote q ON q.instrument_key = r.instrument_key`;
const SELECT_PUBLIC = `
  r.instrument_key, r.symbol, r.name, r.asset_class, r.exchange, r.segment, r.instrument_type, r.currency,
  to_char(r.expiry,'YYYY-MM-DD') AS expiry, r.strike_price, r.lot_size, r.tick_size, r.underlying_key, r.underlying_symbol,
  r.provider, s.access_status, s.quote_status, s.candles_status, s.intraday_status, s.streaming_status,
  s.option_chain_status, s.greeks_status, s.intervals_verified, s.last_probed_at, q.trade_time AS last_quote_at`;

const triState = (status) => (status === 'verified' ? true : (['unsupported', 'denied', 'n/a'].includes(status) ? false : null));

function toPublic(row) {
  const candles = row.candles_status === 'verified' || row.intraday_status === 'verified'
    ? true : (row.candles_status === 'unsupported' && row.intraday_status === 'unsupported' ? false : triState(row.candles_status));
  return {
    instrumentKey: row.instrument_key,
    symbol: row.symbol,
    displayName: row.name || row.symbol,
    assetClass: row.asset_class,
    exchange: row.exchange,
    segment: row.segment,
    instrumentType: row.instrument_type,
    currency: row.currency,
    expiry: row.expiry,
    strike: row.strike_price === null ? null : Number(row.strike_price),
    lotSize: row.lot_size === null ? null : Number(row.lot_size),
    tickSize: row.tick_size === null ? null : Number(row.tick_size),
    underlyingKey: row.underlying_key,
    underlyingSymbol: row.underlying_symbol,
    provider: row.provider,
    // Tri-state: true = verified by a live probe, false = probe proved unsupported/denied, null = not yet verified.
    quoteAvailable: triState(row.quote_status),
    historicalCandlesAvailable: candles,
    streamingAvailable: triState(row.streaming_status),
    optionChainAvailable: triState(row.option_chain_status),
    greeksAvailable: triState(row.greeks_status),
    verifiedIntervals: row.intervals_verified ? row.intervals_verified.split(',') : [],
    dataFreshness: row.last_quote_at ? { lastQuoteAt: row.last_quote_at, source: 'last stored valid quote' } : { lastQuoteAt: null, source: 'no quote retrieved yet' },
    accessStatus: row.access_status || 'UNVERIFIED',
    lastVerifiedAt: row.last_probed_at,
  };
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

async function listSegments() {
  await ensureSchema();
  const { rows } = await query(`SELECT * FROM market_segment_status ORDER BY (instrument_count = 0), segment`);
  const { rows: cls } = await query(`SELECT segment, asset_class, COUNT(*)::int AS n FROM market_registry GROUP BY segment, asset_class ORDER BY n DESC`);
  const byseg = {};
  for (const c of cls) (byseg[c.segment] ||= []).push({ assetClass: c.asset_class, count: c.n });
  return rows.map((s) => ({
    segment: s.segment,
    instrumentCount: s.instrument_count,
    accessStatus: s.access_status,
    assetClasses: byseg[s.segment] || [],
    capabilities: {
      quote: s.quote_status, ohlc: s.ohlc_status, historicalCandles: s.candles_status, intradayCandles: s.intraday_status,
      optionChain: s.option_chain_status, greeks: s.greeks_status, streaming: s.streaming_status,
    },
    verifiedIntervals: s.intervals_verified ? s.intervals_verified.split(',') : [],
    sampleKeys: s.sample_keys ? s.sample_keys.split(',') : [],
    lastTickAt: s.last_tick_at, lastProbedAt: s.last_probed_at, masterRefreshedAt: s.master_refreshed_at, notes: s.notes,
  }));
}

/** Ranked search over the registry. Excludes dated contracts by default so options don't drown out equities. */
async function searchInstruments({ q, segment, assetClass, limit = 30, offset = 0, includeContracts = false } = {}) {
  await ensureSchema();
  const params = [];
  const where = [];
  const push = (v) => { params.push(v); return `$${params.length}`; };
  if (segment) where.push(`r.segment = ${push(segment)}`);
  if (assetClass) where.push(`r.asset_class = ${push(assetClass)}`);
  if (!includeContracts) where.push(`r.expiry IS NULL`);
  let order = 'r.segment, r.symbol';
  const needle = String(q || '').trim().toUpperCase();
  if (needle) {
    const p1 = push(needle), p2 = push(`${escapeLike(needle)}%`), p3 = push(`%${escapeLike(needle)}%`);
    where.push(`(upper(r.symbol) LIKE ${p2} OR upper(r.name) LIKE ${p3})`);
    order = `(upper(r.symbol) = ${p1}) DESC, (upper(r.symbol) LIKE ${p2}) DESC, length(r.symbol), r.symbol`;
  }
  const lim = push(Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100));
  const off = push(Math.max(parseInt(offset, 10) || 0, 0));
  const { rows } = await query(
    `SELECT ${SELECT_PUBLIC} FROM market_registry r ${SEG_JOIN}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${lim} OFFSET ${off}`, params);
  return rows.map(toPublic);
}

async function getInstrument(instrumentKey) {
  await ensureSchema();
  const { rows } = await query(`SELECT ${SELECT_PUBLIC} FROM market_registry r ${SEG_JOIN} WHERE r.instrument_key = $1`, [instrumentKey]);
  return rows.length ? toPublic(rows[0]) : null;
}

/** F&O underlyings for a segment (distinct), with the nearest live expiry. */
async function listUnderlyings({ segment, q, limit = 50 } = {}) {
  await ensureSchema();
  const params = [segment || null];
  let extra = '';
  if (q) { params.push(`${escapeLike(String(q).toUpperCase())}%`); extra = `AND upper(underlying_symbol) LIKE $${params.length}`; }
  params.push(Math.min(parseInt(limit, 10) || 50, 200));
  const { rows } = await query(
    `SELECT underlying_symbol, segment, MIN(underlying_key) AS underlying_key, COUNT(*)::int AS contracts,
            to_char(MIN(expiry) FILTER (WHERE expiry >= CURRENT_DATE),'YYYY-MM-DD') AS nearest_expiry
       FROM market_registry
      WHERE underlying_symbol IS NOT NULL AND expiry IS NOT NULL AND ($1::text IS NULL OR segment = $1) ${extra}
      GROUP BY underlying_symbol, segment ORDER BY underlying_symbol LIMIT $${params.length}`, params);
  return rows.map((r) => ({ underlyingSymbol: r.underlying_symbol, segment: r.segment, underlyingKey: r.underlying_key, contracts: r.contracts, nearestExpiry: r.nearest_expiry }));
}

async function listContracts({ segment, underlying, expiry, type, limit = 200 }) {
  await ensureSchema();
  const params = [underlying.toUpperCase()];
  const where = [`upper(r.underlying_symbol) = $1`, `r.expiry IS NOT NULL`, `r.expiry >= CURRENT_DATE`];
  if (segment) { params.push(segment); where.push(`r.segment = $${params.length}`); }
  if (expiry) { params.push(expiry); where.push(`r.expiry = $${params.length}::date`); }
  if (type) { params.push(type.toUpperCase()); where.push(`r.instrument_type = $${params.length}`); }
  params.push(Math.min(parseInt(limit, 10) || 200, 500));
  const { rows } = await query(
    `SELECT ${SELECT_PUBLIC} FROM market_registry r ${SEG_JOIN} WHERE ${where.join(' AND ')}
      ORDER BY r.expiry, r.strike_price NULLS FIRST, r.instrument_type LIMIT $${params.length}`, params);
  return rows.map(toPublic);
}

async function registryCount() {
  await ensureSchema();
  const { rows: [{ n }] } = await query(`SELECT COUNT(*)::int AS n FROM market_registry`);
  return n;
}

module.exports = {
  ensureSchema, refreshRegistry, getRefreshState, listSegments, searchInstruments, getInstrument,
  listUnderlyings, listContracts, registryCount, toPublic,
};

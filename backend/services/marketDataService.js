// services/marketDataService.js
// ══════════════════════════════════════════════════════════════════════════
//  Upstox market data integration.
//
//  Architecture: ONE Upstox app-level connection (your own Upstox account),
//  shared across all TradeMind users — this is a data feed, not per-user
//  broker login. The access token is stored in the `broker_tokens` table
//  and re-used by every request until it expires (~3:30am IST daily).
//
//  This file owns:
//   - OAuth: building the login URL, exchanging the auth code for a token
//   - Reading/writing the cached token (db: broker_tokens)
//   - Resolving a plain symbol ("RELIANCE") → Upstox instrument_key
//     ("NSE_EQ|INE002A01018"), cached in db: instrument_cache
//   - Fetching live LTP quotes and historical candles
//
//  If UPSTOX_API_KEY / UPSTOX_SECRET are not set, every exported function
//  throws a clear AppError(501) — callers should not silently fall back to
//  fake data; the route layer decides what to do with that error.
// ══════════════════════════════════════════════════════════════════════════

const { config } = require('../config');
const { query } = require('../db/pool');
const AppError = require('../utils/AppError');

const BASE_V2 = 'https://api.upstox.com/v2';
const BASE_V3 = 'https://api.upstox.com/v3';

function assertConfigured() {
  if (!config.upstox.apiKey || !config.upstox.apiSecret) {
    throw new AppError(
      'Market data is not configured on this server. Set UPSTOX_API_KEY and UPSTOX_SECRET.',
      501
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  OAUTH — login URL + code exchange
// ─────────────────────────────────────────────────────────────────────────

/** Builds the URL an admin visits to approve TradeMind's access to Upstox. */
function buildLoginUrl() {
  assertConfigured();
  if (!config.upstox.redirectUri) {
    throw new AppError('UPSTOX_REDIRECT_URI is not set.', 501);
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.upstox.apiKey,
    redirect_uri: config.upstox.redirectUri,
  });
  return `${BASE_V2}/login/authorization/dialog?${params.toString()}`;
}

/** Exchanges the OAuth authorization code for an access token, and stores it. */
async function exchangeCodeForToken(code) {
  assertConfigured();
  if (!code) throw new AppError('Missing authorization code from Upstox redirect.', 400);

  const res = await fetch(`${BASE_V2}/login/authorization/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      client_id: config.upstox.apiKey,
      client_secret: config.upstox.apiSecret,
      redirect_uri: config.upstox.redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new AppError(`Upstox token exchange failed: ${errText.slice(0, 200)}`, 502);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new AppError('Upstox did not return an access token.', 502);
  }

  // Upstox tokens expire at ~3:30am IST the day after issue, regardless of
  // issue time — there is no usable "expires_in" to trust for this. We pin
  // the expiry to the next 3:25am IST (5 min safety margin) so a stale
  // token is never used for a real request.
  const expiresAt = nextUpstoxExpiry();

  await query(
    `INSERT INTO broker_tokens (provider, access_token, expires_at)
     VALUES ('upstox', $1, $2)
     ON CONFLICT (provider) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       expires_at   = EXCLUDED.expires_at,
       created_at   = now()`,
    [data.access_token, expiresAt]
  );

  return { connected: true, expiresAt };
}

/** ~3:25am IST tomorrow, expressed as a UTC Date (IST = UTC+5:30). */
function nextUpstoxExpiry() {
  const now = new Date();
  const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const istExpiry = new Date(Date.UTC(
    istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() + 1,
    3, 25, 0
  ));
  return new Date(istExpiry.getTime() - 5.5 * 60 * 60 * 1000); // back to UTC
}

/** Returns a valid cached access token, or throws if none / expired. */
async function getValidAccessToken() {
  assertConfigured();
  const { rows } = await query(
    `SELECT access_token, expires_at FROM broker_tokens WHERE provider = 'upstox'`
  );
  if (!rows.length) {
    throw new AppError(
      'Upstox is not connected yet. An admin needs to visit /api/market/upstox/login once.',
      503
    );
  }
  const { access_token, expires_at } = rows[0];
  if (new Date(expires_at) <= new Date()) {
    throw new AppError(
      'Upstox session has expired (tokens expire daily). An admin needs to reconnect via /api/market/upstox/login.',
      503
    );
  }
  return access_token;
}

async function upstoxStatus() {
  const { rows } = await query(
    `SELECT expires_at FROM broker_tokens WHERE provider = 'upstox'`
  );
  if (!rows.length) return { connected: false };
  const expiresAt = new Date(rows[0].expires_at);
  return { connected: expiresAt > new Date(), expiresAt };
}

// ─────────────────────────────────────────────────────────────────────────
//  SEMI-AUTOMATED DAILY REFRESH — Upstox's official "Access Token Request"
//  API (https://upstox.com/developer/api-documentation/access-token-request)
//
//  This replaces the full login-redirect dance with: (1) we POST a request,
//  (2) Upstox pushes an approve/reject notification to the admin's phone
//  (in-app + WhatsApp), (3) on approval Upstox POSTs the access_token to
//  our Notifier Webhook URL — which must be set once in the Upstox app
//  dashboard to https://<your-backend>/api/market/upstox/notifier.
//
//  Still needs one human tap/day (Upstox doesn't offer a fully unattended
//  official flow), but it's a single approve button — no typing password/
//  PIN/TOTP into a login form. services/tokenScheduler.js calls
//  requestAccessTokenApproval() automatically every day at 08:00 IST (see
//  server.js, which starts it on boot); the notifier route below stores
//  whatever token comes back, and a follow-up check at 08:45 IST emails
//  the admin if the approval was missed.
// ─────────────────────────────────────────────────────────────────────────

async function requestAccessTokenApproval() {
  assertConfigured();
  const url = `${BASE_V3}/login/auth/token/request/${config.upstox.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_secret: config.upstox.apiSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status !== 'success') {
    throw new AppError(
      `Upstox access-token request failed: ${data.errors?.[0]?.message || res.statusText}`,
      502
    );
  }
  // authorization_expiry is when the APPROVAL WINDOW closes (not the token
  // itself) — the admin must tap approve on their phone before this.
  return { authorizationExpiry: new Date(Number(data.data.authorization_expiry)) };
}

/** Called by the public notifier webhook once the admin approves on their phone. */
async function storeNotifiedToken({ access_token, expires_at }) {
  if (!access_token) throw new AppError('Notifier payload missing access_token.', 400);
  const expiresAt = expires_at ? new Date(Number(expires_at)) : nextUpstoxExpiry();
  await query(
    `INSERT INTO broker_tokens (provider, access_token, expires_at)
     VALUES ('upstox', $1, $2)
     ON CONFLICT (provider) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       expires_at   = EXCLUDED.expires_at,
       created_at   = now()`,
    [access_token, expiresAt]
  );
  return { connected: true, expiresAt };
}

// ─────────────────────────────────────────────────────────────────────────
//  INSTRUMENT RESOLUTION
//  Upstox identifies instruments by instrument_key (exchange|ISIN), not by
//  plain trading symbol. We keep a small built-in seed of frequently-used
//  NSE large-caps so common requests resolve with zero extra calls, and
//  fall back to Upstox's instrument master for anything not in the seed.
// ─────────────────────────────────────────────────────────────────────────
const INDEX_INSTRUMENT_KEYS = {
  'NIFTY 50':   'NSE_INDEX|Nifty 50',
  'SENSEX':     'BSE_INDEX|SENSEX',
  'NIFTY BANK': 'NSE_INDEX|Nifty Bank',
};
const SEED_INSTRUMENTS = {
  RELIANCE:  'NSE_EQ|INE002A01018',
  TCS:       'NSE_EQ|INE467B01029',
  HDFCBANK:  'NSE_EQ|INE040A01034',
  INFY:      'NSE_EQ|INE009A01021',
  ICICIBANK: 'NSE_EQ|INE090A01021',
  SBIN:      'NSE_EQ|INE062A01020',
  WIPRO:     'NSE_EQ|INE075A01022',
  TATAMOTORS:'NSE_EQ|INE155A01022',
  HINDUNILVR:'NSE_EQ|INE030A01027',
  BAJFINANCE:'NSE_EQ|INE296A01024',
  ADANIENT:  'NSE_EQ|INE423A01024',
  ITC:       'NSE_EQ|INE154A01025',
  KOTAKBANK: 'NSE_EQ|INE237A01028',
  LT:        'NSE_EQ|INE018A01030',
  AXISBANK:  'NSE_EQ|INE238A01034',
};

// Upstox publishes one instrument-master file per exchange. NSE is checked
// first by default (better liquidity/data quality for the same company),
// BSE is the fallback — see resolveInstrumentKey().
const EXCHANGE_FILES = {
  NSE_EQ: 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',
  BSE_EQ: 'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz',
};

const instrumentMasterCache = {}; // { NSE_EQ: {bySymbol, fetchedAt}, BSE_EQ: {...} } — in-memory, process lifetime

/**
 * Downloads and parses Upstox's equity instrument master for one exchange
 * (gzipped JSON, ~30MB uncompressed for NSE). Cache miss only — cached in
 * memory for the life of the process per exchange.
 */
async function loadInstrumentMaster(exchange = 'NSE_EQ') {
  const INSTRUMENT_MASTER_TTL_MS = 24 * 60 * 60 * 1000; // refresh once a day — Upstox republishes this file daily
  if (instrumentMasterCache[exchange] && (Date.now() - instrumentMasterCache[exchange].fetchedAt.getTime() < INSTRUMENT_MASTER_TTL_MS)) {
    return instrumentMasterCache[exchange];
  }

  const url = EXCHANGE_FILES[exchange];
  if (!url) throw new AppError(`Unsupported exchange: ${exchange}`, 400);

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new AppError(`Could not download Upstox ${exchange} instrument master.`, 502);

  const zlib = require('zlib');
  const buf = Buffer.from(await res.arrayBuffer());
  const json = zlib.gunzipSync(buf).toString('utf-8');
  const list = JSON.parse(json);

  // Only keep plain equities; the exchange files also include indices/derivatives.
  // FIX: this used to require instrument_type === 'EQ' (exact match) only,
  // which could silently return ZERO rows for BSE on some Upstox instrument
  // snapshots — BSE equities aren't always tagged instrument_type:'EQ' the
  // same way NSE ones are; some rows only carry a reliable segment:'BSE_EQ'
  // (or a lowercase / whitespace variant of instrument_type). Match on either
  // signal, case-insensitively, so BSE stocks actually show up everywhere
  // (screener, search, charts) instead of the list quietly coming back empty.
  const isEquityRow = (row) => {
    const type = (row.instrument_type || '').toString().trim().toUpperCase();
    const segment = (row.segment || '').toString().trim().toUpperCase();
    return (type === 'EQ' || segment === exchange) && !!row.trading_symbol;
  };

  const bySymbol = new Map();
  for (const row of list) {
    if (isEquityRow(row)) {
      bySymbol.set(row.trading_symbol.toUpperCase(), {
        instrumentKey: row.instrument_key,
        name: row.name,
      });
    }
  }

  if (bySymbol.size === 0 && list.length > 0) {
    // Don't fail silently — this is exactly the class of bug that made BSE
    // stocks disappear from every page ("Page 1 of 1", zero rows, no error).
    // Log a sample so a real mismatch in Upstox's schema is easy to spot.
    console.warn(
      `[marketDataService] loadInstrumentMaster(${exchange}): 0 equities matched out of ${list.length} rows. ` +
      `Sample row keys: ${Object.keys(list[0] || {}).join(', ')} — instrument_type sample: ${list[0]?.instrument_type}, segment sample: ${list[0]?.segment}`
    );
  }

  instrumentMasterCache[exchange] = { bySymbol, fetchedAt: new Date() };
  return instrumentMasterCache[exchange];
}

/**
 * Resolves a plain trading symbol to an Upstox instrument_key, caching the
 * result in Postgres. Tries NSE first (default), falls back to BSE if the
 * symbol isn't listed on NSE. Pass exchange: 'BSE_EQ' to force BSE only.
 */
async function resolveInstrumentKey(symbolRaw, exchange) {
  const symbol = (symbolRaw || '').trim().toUpperCase();
  if (!symbol) throw new AppError('stockSymbol is required.', 400);

  if (!exchange && SEED_INSTRUMENTS[symbol]) return SEED_INSTRUMENTS[symbol];

  const exchangesToTry = exchange ? [exchange] : ['NSE_EQ', 'BSE_EQ'];

  for (const ex of exchangesToTry) {
    const { rows } = await query(
      `SELECT instrument_key FROM instrument_cache WHERE exchange = $1 AND trading_symbol = $2`,
      [ex, symbol]
    );
    if (rows.length) return rows[0].instrument_key;

    const { bySymbol } = await loadInstrumentMaster(ex);
    const hit = bySymbol.get(symbol);
    if (!hit) continue; // not on this exchange — try the next one

    await query(
      `INSERT INTO instrument_cache (exchange, trading_symbol, instrument_key, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (exchange, trading_symbol) DO UPDATE SET
         instrument_key = EXCLUDED.instrument_key, name = EXCLUDED.name, updated_at = now()`,
      [ex, symbol, hit.instrumentKey, hit.name]
    );

    return hit.instrumentKey;
  }

  throw new AppError(
    `Unknown or unsupported symbol: ${symbol} (checked ${exchangesToTry.join(', ')})`,
    404
  );
}

/**
 * Returns a page of ALL equities on one exchange (or both), for a full
 * stock browser — as opposed to searchSymbols() which is prefix-matching
 * for a search box. Sorted alphabetically for stable pagination.
 */
async function listAllSymbols({ exchange, page = 1, limit = 50 } = {}) {
  const exchanges = exchange ? [exchange] : ['NSE_EQ', 'BSE_EQ'];
  let all = [];
  for (const ex of exchanges) {
    const { bySymbol } = await loadInstrumentMaster(ex);
    for (const [symbol, info] of bySymbol) {
      all.push({ symbol, exchange: ex, name: info.name });
    }
  }
  all.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const total = all.length;
  const start = (Math.max(1, page) - 1) * limit;
  const items = all.slice(start, start + limit);
  return { items, total, page: Math.max(1, page), limit, totalPages: Math.ceil(total / limit) };
}
async function searchSymbols(prefixRaw, limit = 20) {
  const prefix = (prefixRaw || '').trim().toUpperCase();
  if (!prefix) return [];

  const results = [];
  for (const exchange of ['NSE_EQ', 'BSE_EQ']) {
    const { bySymbol } = await loadInstrumentMaster(exchange);
    for (const [symbol, info] of bySymbol) {
      if (symbol.startsWith(prefix)) {
        results.push({ symbol, exchange, name: info.name });
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────
//  LIVE QUOTE (LTP)
// ─────────────────────────────────────────────────────────────────────────

// UPDATED: switched from the LTP-only endpoint to the fuller quotes
// endpoint so we also get ohlc.close (previous day's close) — needed to
// compute %change for the frontend ticker, which only ever had last_price
// before. NOTE: this couldn't be tested against a live Upstox connection
// while writing it (no network access in this environment) — the field
// names below (last_price, ohlc.close) match Upstox's documented response
// shape, but double-check the actual JSON once you're connected, in case
// it's changed since. If ohlc.close turns out to be missing/different,
// changePct below will just come back null and the frontend already
// handles that (falls back to 0% rather than crashing).
async function getLtp(symbol) {
  const accessToken = await getValidAccessToken();
  const instrumentKey = await resolveInstrumentKey(symbol);

  const url = `${BASE_V2}/market-quote/quotes?${new URLSearchParams({ instrument_key: instrumentKey })}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new AppError(`Upstox quote request failed: ${errText.slice(0, 200)}`, 502);
  }

  const data = await res.json();
  const key = Object.keys(data.data || {})[0];
  const quote = key ? data.data[key] : null;
  if (!quote) throw new AppError('Upstox returned no quote for this symbol.', 502);

  const lastPrice = quote.last_price;
  const previousClose = quote.ohlc?.close ?? null;
  const changePct = (typeof previousClose === 'number' && previousClose > 0 && typeof lastPrice === 'number')
    ? ((lastPrice - previousClose) / previousClose) * 100
    : null;

  return {
    symbol: symbol.toUpperCase(),
    instrumentKey,
    lastPrice,
    previousClose,
    changePct,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetches quotes for MANY symbols in one Upstox call (comma-separated
 * instrument_key) instead of one call per symbol. Each entry in `symbols`
 * can optionally be { symbol, exchange } to force NSE or BSE; a plain
 * string defaults to NSE-then-BSE resolution.
 *
 * Short-lived shared cache (3s): if many concurrent users request the same
 * symbol set within a few seconds of each other — very likely, since the
 * frontend ticker polls the same curated list every 15s — they share one
 * upstream Upstox call instead of each triggering a fresh one. This is a
 * real step toward supporting more concurrent users without hitting
 * Upstox's per-app rate limit, though it's in-memory only (per Node
 * process) — scaling to multiple Render instances would need a
 * Redis-backed cache instead for it to stay shared across them.
 */
const quoteBatchCache = new Map(); // cacheKey -> { data, expiresAt }
const QUOTE_CACHE_TTL_MS = 3000;

async function getLtpBatch(symbols) {
  if (!Array.isArray(symbols) || !symbols.length) {
    throw new AppError('symbols must be a non-empty array.', 400);
  }

  const cacheKey = JSON.stringify(symbols.map((s) => (typeof s === 'string' ? s : `${s.symbol}:${s.exchange || ''}`)).sort());
  const cached = quoteBatchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const accessToken = await getValidAccessToken();

  // Resolve every symbol to an instrument_key, keeping a map back to the
  // original symbol so we can shape the response the same way regardless
  // of which exchange it was actually found on.
  const entries = await Promise.all(
    symbols.map(async (s) => {
      const symbol = typeof s === 'string' ? s : s.symbol;
      const exchange = typeof s === 'string' ? undefined : s.exchange;
      try {
        const instrumentKey = await resolveInstrumentKey(symbol, exchange);
        return { symbol: symbol.toUpperCase(), instrumentKey, error: null };
      } catch (err) {
        return { symbol: symbol.toUpperCase(), instrumentKey: null, error: err.message };
      }
    })
  );

  const resolved = entries.filter((e) => e.instrumentKey);
  const unresolved = entries.filter((e) => !e.instrumentKey);
  if (!resolved.length) return { quotes: [], errors: unresolved };

  const url = `${BASE_V2}/market-quote/quotes?${new URLSearchParams({
    instrument_key: resolved.map((e) => e.instrumentKey).join(','),
  })}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new AppError(`Upstox batch quote request failed: ${errText.slice(0, 200)}`, 502);
  }

  const data = await res.json();
  const byInstrumentKey = new Map(
    Object.values(data.data || {}).map((q) => [q.instrument_token || q.instrument_key, q])
  );

  const quotes = resolved.map(({ symbol, instrumentKey }) => {
    // Upstox keys the response object by a slightly different string than
    // the request instrument_key in some cases, so also try a loose match.
    const quote =
      byInstrumentKey.get(instrumentKey) ||
      Object.values(data.data || {}).find((q) => q.instrument_token === instrumentKey);

    if (!quote) return { symbol, instrumentKey, lastPrice: null, previousClose: null, changePct: null };

    const lastPrice = quote.last_price;
    const previousClose = quote.ohlc?.close ?? null;
    const changePct = (typeof previousClose === 'number' && previousClose > 0 && typeof lastPrice === 'number')
      ? ((lastPrice - previousClose) / previousClose) * 100
      : null;

    return { symbol, instrumentKey, lastPrice, previousClose, changePct };
  });

  const result = { quotes, errors: unresolved, fetchedAt: new Date().toISOString() };
  quoteBatchCache.set(cacheKey, { data: result, expiresAt: Date.now() + QUOTE_CACHE_TTL_MS });
  return result;
}
async function getIndexQuotes() {
  const cacheKey = 'INDICES';
  const cached = quoteBatchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const accessToken = await getValidAccessToken();
  const entries = Object.entries(INDEX_INSTRUMENT_KEYS);

  const url = `${BASE_V2}/market-quote/quotes?${new URLSearchParams({
    instrument_key: entries.map(([, key]) => key).join(','),
  })}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new AppError(`Upstox index quote request failed: ${errText.slice(0, 200)}`, 502);
  }

  const data = await res.json();
  const byInstrumentKey = new Map(
    Object.values(data.data || {}).map((q) => [q.instrument_token || q.instrument_key, q])
  );

  const quotes = entries.map(([label, instrumentKey]) => {
    const quote = byInstrumentKey.get(instrumentKey);
    if (!quote) return { label, instrumentKey, lastPrice: null, previousClose: null, changePct: null };

    const lastPrice = quote.last_price;
    const previousClose = quote.ohlc?.close ?? null;
    const changePct = (typeof previousClose === 'number' && previousClose > 0 && typeof lastPrice === 'number')
      ? ((lastPrice - previousClose) / previousClose) * 100
      : null;

    return { label, instrumentKey, lastPrice, previousClose, changePct };
  });

  const result = { quotes, fetchedAt: new Date().toISOString() };
  quoteBatchCache.set(cacheKey, { data: result, expiresAt: Date.now() + QUOTE_CACHE_TTL_MS });
  return result;
}// ─────────────────────────────────────────────────────────────────────────
//  INDEX QUOTES (NIFTY 50 / SENSEX / NIFTY BANK)
// ─────────────────────────────────────────────────────────────────────────

async function getIndexQuotes() {
  const accessToken = await getValidAccessToken();
  const entries = Object.entries(INDEX_INSTRUMENT_KEYS);

  const url = `${BASE_V2}/market-quote/quotes?${new URLSearchParams({
    instrument_key: entries.map(([, key]) => key).join(','),
  })}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new AppError(`Upstox index quote request failed: ${errText.slice(0, 200)}`, 502);
  }

  const data = await res.json();
  const values = Object.values(data.data || {});

  const indices = entries.map(([label, instrumentKey]) => {
    const quote =
      values.find((q) => q.instrument_token === instrumentKey) ||
      values.find((q) => q.instrument_token?.replace('%7C', '|') === instrumentKey);

    if (!quote) return { label, instrumentKey, lastPrice: null, previousClose: null, changePct: null };

    const lastPrice = quote.last_price;
    const previousClose = quote.ohlc?.close ?? null;
    const changePct = (typeof previousClose === 'number' && previousClose > 0 && typeof lastPrice === 'number')
      ? ((lastPrice - previousClose) / previousClose) * 100
      : null;

    return { label, instrumentKey, lastPrice, previousClose, changePct };
  });

  return { indices, fetchedAt: new Date().toISOString() };
}

async function getIndexHistoricalCandles(label, { unit = 'minutes', interval = 5, from, to } = {}) {
  const instrumentKey = INDEX_INSTRUMENT_KEYS[label.toUpperCase()];
  if (!instrumentKey) throw new AppError(`Unknown index: ${label}`, 400);
  if (!VALID_UNITS.includes(unit)) {
    throw new AppError(`unit must be one of: ${VALID_UNITS.join(', ')}`, 400);
  }
  const accessToken = await getValidAccessToken();
  const toDate = to || new Date().toISOString().slice(0, 10);
  const fromDate = from || defaultFromDate(unit);
  const encodedKey = encodeURIComponent(instrumentKey);
  const url = `${BASE_V3}/historical-candle/${encodedKey}/${unit}/${interval}/${toDate}/${fromDate}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new AppError(`Upstox index candle request failed: ${errText.slice(0, 200)}`, 502);
  }
  const data = await res.json();
  const rawCandles = data.data?.candles || [];
  const candles = rawCandles.map(([timestamp, o, h, l, c, v]) => ({ t: timestamp, o, h, l, c, v })).reverse();
  return { label, instrumentKey, unit, interval, candles };
}
// ─────────────────────────────────────────────────────────────────────────
//  OPTION CHAIN (real Upstox v2 API — replaces fabricated OI/PCR data)
// ─────────────────────────────────────────────────────────────────────────
async function getOptionChain(underlyingInstrumentKey, expiryDate) {
  assertConfigured();
  const accessToken = await getValidAccessToken();
  const url = `https://api.upstox.com/v2/option/chain?${new URLSearchParams({
    instrument_key: underlyingInstrumentKey,
    expiry_date: expiryDate,
  })}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new AppError(`Upstox option chain request failed: ${errText.slice(0, 200)}`, 502);
  }
  const data = await res.json();
  return data.data || []; // array of {strike_price, pcr, underlying_spot_price, call_options, put_options}
}
//  unit: 'minutes' | 'hours' | 'days' | 'weeks' | 'months'  (Upstox v3 terms)
//  interval: numeric step for minutes/hours (e.g. 1, 5, 15, 30); ignored
//            for days/weeks/months.
// ─────────────────────────────────────────────────────────────────────────

const VALID_UNITS = ['minutes', 'hours', 'days', 'weeks', 'months'];

// ─────────────────────────────────────────────────────────────────────────
//  HISTORICAL CANDLES
// ─────────────────────────────────────────────────────────────────────────
async function getHistoricalCandles(symbol, { unit = 'days', interval = 1, from, to, exchange } = {}) {
  if (!VALID_UNITS.includes(unit)) {
    throw new AppError(`unit must be one of: ${VALID_UNITS.join(', ')}`, 400);
  }
  const accessToken = await getValidAccessToken();
  // exchange: 'NSE_EQ' | 'BSE_EQ' — lets the chart's NSE/BSE switch force a
  // specific listing for dual-listed symbols instead of always defaulting
  // to whichever one resolveInstrumentKey finds first (NSE).
  const instrumentKey = await resolveInstrumentKey(symbol, exchange);

  const toDate = to || new Date().toISOString().slice(0, 10);
  const fromDate = from || defaultFromDate(unit);

  const encodedKey = encodeURIComponent(instrumentKey);
  const url = `${BASE_V3}/historical-candle/${encodedKey}/${unit}/${interval}/${toDate}/${fromDate}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new AppError(`Upstox historical-candle request failed: ${errText.slice(0, 200)}`, 502);
  }

  const data = await res.json();
  const rawCandles = data.data?.candles || [];

  // Upstox returns candles newest-first as
  //   [timestamp, open, high, low, close, volume, openInterest]
  // The frontend's drawCandles() expects oldest-first { o,h,l,c,v,t }.
const candles = rawCandles
    .map(([timestamp, o, h, l, c, v]) => ({ t: timestamp, o, h, l, c, v }))
    .reverse();

  const todayStr = new Date().toISOString().slice(0, 10);
  const intraday = await getIntradayCandles(instrumentKey, unit, interval);
  const merged = [...candles.filter((c) => !c.t.startsWith(todayStr)), ...intraday];

  return { symbol: symbol.toUpperCase(), instrumentKey, unit, interval, candles: merged };
}
/** Fetches TODAY's candles (Upstox's separate intraday endpoint — historical never includes today). */
async function getIntradayCandles(instrumentKey, unit, interval) {
  try {
    const accessToken = await getValidAccessToken();
    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `${BASE_V3}/historical-candle/intraday/${encodedKey}/${unit}/${interval}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return []; // e.g. market closed — don't break the whole chart over this
    const data = await res.json();
    const raw = data.data?.candles || [];
    return raw.map(([timestamp, o, h, l, c, v]) => ({ t: timestamp, o, h, l, c, v })).reverse();
  } catch {
    return [];
  }
}
function defaultFromDate(unit) {
  const d = new Date();
  if (unit === 'minutes' || unit === 'hours') d.setDate(d.getDate() - 30);
  else if (unit === 'days') d.setMonth(d.getMonth() - 6);
  else d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  buildLoginUrl,
  exchangeCodeForToken,
  upstoxStatus,
  getValidAccessToken,
  requestAccessTokenApproval,
  storeNotifiedToken,
  resolveInstrumentKey,
  searchSymbols,
  listAllSymbols,
  getLtp,
  getLtpBatch,
  getOptionChain,
  getHistoricalCandles,
  getIndexQuotes,
  getIndexHistoricalCandles,
};

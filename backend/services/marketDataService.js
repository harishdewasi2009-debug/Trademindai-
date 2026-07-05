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
//  INSTRUMENT RESOLUTION
//  Upstox identifies instruments by instrument_key (exchange|ISIN), not by
//  plain trading symbol. We keep a small built-in seed of frequently-used
//  NSE large-caps so common requests resolve with zero extra calls, and
//  fall back to Upstox's instrument master for anything not in the seed.
// ─────────────────────────────────────────────────────────────────────────

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

let instrumentMasterCache = null; // { bySymbol: Map, fetchedAt: Date } — in-memory, process lifetime

/**
 * Downloads and parses Upstox's NSE equity instrument master (gzipped JSON).
 * This is ~30MB uncompressed; we only do this on a cache miss, and cache
 * the parsed map in memory for the life of the process.
 */
async function loadInstrumentMaster() {
  if (instrumentMasterCache) return instrumentMasterCache;

  const res = await fetch('https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz', {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new AppError('Could not download Upstox instrument master.', 502);

  const zlib = require('zlib');
  const buf = Buffer.from(await res.arrayBuffer());
  const json = zlib.gunzipSync(buf).toString('utf-8');
  const list = JSON.parse(json);

  const bySymbol = new Map();
  for (const row of list) {
    // Only keep plain equities; Upstox's NSE file also includes indices/derivatives.
    if (row.instrument_type === 'EQ' && row.trading_symbol) {
      bySymbol.set(row.trading_symbol.toUpperCase(), {
        instrumentKey: row.instrument_key,
        name: row.name,
      });
    }
  }
  instrumentMasterCache = { bySymbol, fetchedAt: new Date() };
  return instrumentMasterCache;
}

/** Resolves a plain NSE trading symbol to an Upstox instrument_key, caching the result in Postgres. */
async function resolveInstrumentKey(symbolRaw) {
  const symbol = (symbolRaw || '').trim().toUpperCase();
  if (!symbol) throw new AppError('stockSymbol is required.', 400);

  if (SEED_INSTRUMENTS[symbol]) return SEED_INSTRUMENTS[symbol];

  const { rows } = await query(
    `SELECT instrument_key FROM instrument_cache WHERE exchange = 'NSE_EQ' AND trading_symbol = $1`,
    [symbol]
  );
  if (rows.length) return rows[0].instrument_key;

  const { bySymbol } = await loadInstrumentMaster();
  const hit = bySymbol.get(symbol);
  if (!hit) throw new AppError(`Unknown or unsupported symbol: ${symbol}`, 404);

  await query(
    `INSERT INTO instrument_cache (exchange, trading_symbol, instrument_key, name)
     VALUES ('NSE_EQ', $1, $2, $3)
     ON CONFLICT (exchange, trading_symbol) DO UPDATE SET
       instrument_key = EXCLUDED.instrument_key, name = EXCLUDED.name, updated_at = now()`,
    [symbol, hit.instrumentKey, hit.name]
  );

  return hit.instrumentKey;
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

  const url = `${BASE_V3}/market-quote/quotes?${new URLSearchParams({ instrument_key: instrumentKey })}`;
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

// ─────────────────────────────────────────────────────────────────────────
//  HISTORICAL CANDLES
//  unit: 'minutes' | 'hours' | 'days' | 'weeks' | 'months'  (Upstox v3 terms)
//  interval: numeric step for minutes/hours (e.g. 1, 5, 15, 30); ignored
//            for days/weeks/months.
// ─────────────────────────────────────────────────────────────────────────

const VALID_UNITS = ['minutes', 'hours', 'days', 'weeks', 'months'];

async function getHistoricalCandles(symbol, { unit = 'days', interval = 1, from, to } = {}) {
  if (!VALID_UNITS.includes(unit)) {
    throw new AppError(`unit must be one of: ${VALID_UNITS.join(', ')}`, 400);
  }
  const accessToken = await getValidAccessToken();
  const instrumentKey = await resolveInstrumentKey(symbol);

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

  return { symbol: symbol.toUpperCase(), instrumentKey, unit, interval, candles };
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
  resolveInstrumentKey,
  getLtp,
  getHistoricalCandles,
};

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
const { isTradingDay } = require('../utils/tradingCalendar');

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
// BSE is the fallback — see resolveInstrumentKey(). MCX_FO is the
// commodity-derivatives segment (Gold, Silver, Crude Oil, Natural Gas,
// base metals, etc.) — unlike NSE/BSE it carries no cash-equity segment at
// all, so every row in MCX.json.gz is itself a future/option contract; see
// the MCX branch inside loadInstrumentMaster() below for how that's turned
// into one "front month" instrument_key per commodity.
const EXCHANGE_FILES = {
  NSE_EQ: 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',
  BSE_EQ: 'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz',
  MCX_FO: 'https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz',
};

// Every exchange the app knows how to browse/search across by default (the
// "give me everything" loops: searchSymbols, searchFnoSymbols, listAllSymbols,
// getFnoUnderlyings). resolveInstrumentKey() intentionally does NOT default
// to this list — an ambiguous plain symbol (watchlist add, quote lookup)
// still only auto-resolves against NSE then BSE, exactly as before, so an
// equity ticker can never accidentally resolve to a commodity contract.
// Callers that specifically want MCX must pass exchange: 'MCX_FO'.
const ALL_BROWSABLE_EXCHANGES = ['NSE_EQ', 'BSE_EQ', 'MCX_FO'];

// A 401 means the token itself is invalid — retrying won't fix that, and
  // the SDK's own auto-reconnect timer has a bug that throws an uncaught
  // exception on every retry, which was crashing the whole backend. Stop
  // the feed ourselves on 401 instead of letting the SDK keep retrying.
  streamer.on('error', (err) => {
    const message = err?.message || String(err);
    console.error('[liveFeedService] Upstox stream error:', message);
    if (/401/.test(message)) {
      console.error('[liveFeedService] Token appears invalid/expired — stopping the feed instead of letting the SDK retry.');
      stopLiveFeed();
    }
  });
  streamer.on('close', () => console.warn('[liveFeedService] Upstox stream closed.'));
  streamer.on('autoReconnectStopped', () => console.error('[liveFeedService] Gave up reconnecting to Upstox — call startLiveFeed() again with a fresh token.'));

  streamer.connect();
  if (exchange === 'MCX_FO') {
    instrumentMasterCache.MCX_FO = parseMcxInstrumentMaster(list);
    return instrumentMasterCache.MCX_FO;
  }

  // NOTE: Upstox's NSE.json.gz and BSE.json.gz are NOT guaranteed to use
  // identical field names/values row-to-row (reported by multiple devs on
  // the Upstox community forum). Relying on a single exact field match
  // (instrument_type === 'EQ') silently produced ZERO rows for BSE_EQ on
  // some instrument-master snapshots — that's why "BSE only" in the
  // screener came back empty even though API access was fine. To be
  // resilient to schema drift we now:
  //   1) Accept either `segment` (e.g. "BSE_EQ") or `instrument_type` as
  //      the equity marker.
  //   2) Accept a few known aliases for the trading-symbol/key fields.
  //   3) Skip obvious derivative/options rows (expiry/strike present).
 const bySymbol = new Map();
  // F&O underlyings (stocks + indices that actually have listed options) —
  // Upstox's per-exchange file mixes equity rows in with derivative rows
  // (segment "NSE_FO"/"BSE_FO"), each derivative row carrying an
  // `underlying_symbol`. We collect those into a Set here, in the same
  // pass, instead of a hardcoded/stale F&O stock list that would need
  // manual updates every quarter when NSE revises it.
  const fnoUnderlyings = new Set();
  let skippedNoSymbol = 0;
  for (const row of list) {
    if (row.expiry || row.strike_price) {
      if (row.underlying_symbol) fnoUnderlyings.add(String(row.underlying_symbol).toUpperCase());
      continue; // derivatives/options rows — not added to the equity bySymbol map
    }

    const tradingSymbol = row.trading_symbol || row.tradingsymbol || row.tradingSymbol || row.symbol;
    const instrumentKey = row.instrument_key || row.instrumentKey;
    if (!tradingSymbol || !instrumentKey) { skippedNoSymbol++; continue; }

    // Upstox's segment/instrument_type fields are unreliable on the BSE
    // file (sometimes blank for real equities, sometimes shared with debt
    // instruments) — that inconsistency is what caused BSE to alternate
    // between "0 stocks" and "full of bonds/NCDs" depending on how strict
    // this check was. The ISIN itself is reliable and exchange-agnostic:
    // Indian ISINs encode a security-type code right after the issuer code
    // — "01" is always equity shares (bonds/NCDs use "08", preference
    // shares "02", etc). instrument_key is "EXCHANGE|ISIN", e.g.
    // "BSE_EQ|INE002A01018" — so we check that instead of segment/type.
    const isin = String(instrumentKey).split('|')[1] || '';
    const isEquity = isin.slice(7, 9) === '01';
    if (!isEquity) continue;

    bySymbol.set(String(tradingSymbol).toUpperCase(), {
      instrumentKey,
      name: row.name || String(tradingSymbol),
    });
  }
  if (bySymbol.size === 0) {
    // Don't cache an empty result — a transient/malformed download shouldn't
    // black out an entire exchange for the next 24h TTL. Throw so the route
    // surfaces a real error instead of a silent "no stocks found".
    throw new AppError(
      `Upstox ${exchange} instrument master parsed to 0 equities (downloaded ${list.length} rows, ${skippedNoSymbol} missing symbol/key). The file format may have changed.`,
      502
    );
  }

 instrumentMasterCache[exchange] = { bySymbol, fnoUnderlyings, fetchedAt: new Date() };
  return instrumentMasterCache[exchange];
  })();

  instrumentMasterInFlight[exchange] = loadPromise;
  try {
    return await loadPromise;
  } finally {
    delete instrumentMasterInFlight[exchange];
  }
}

// ── MCX (commodity derivatives) instrument-master parsing ────────────────
// MCX has no cash-equity segment — every row in MCX.json.gz is itself a
// futures or options contract on a commodity (GOLD, SILVER, CRUDEOIL,
// NATURALGAS, COPPER, ZINC, ALUMINIUM, LEAD, MENTHAOIL, COTTON, etc.), and
// the same commodity has several rows at once (one per expiry month, plus
// CE/PE option rows). So unlike NSE/BSE there is no single "the equity
// row" to key on — instead, for each commodity we pick the FUTURES
// contract with the nearest expiry that hasn't already lapsed (the "front
// month"/"near month" contract, the one carrying most of the trading
// volume) and use that as the one instrument_key the rest of the app
// treats as "this commodity's price" — the same role NIFTY 50's single
// index instrument_key plays for INDEX_INSTRUMENT_KEYS above. This re-picks
// itself automatically as contracts expire and roll, with no manual
// updates needed when MCX opens a new expiry each month.
function parseMcxInstrumentMaster(list) {
  const nearestFutureByUnderlying = new Map(); // UNDERLYING -> { instrumentKey, name, expiry }
  const fnoUnderlyings = new Set(); // commodities that have a listed CE/PE options chain
  const todayMs = Date.now();
  let skippedNoSymbol = 0;

  for (const row of list) {
    const instrumentType = (row.instrument_type || '').toUpperCase();
    const instrumentKey = row.instrument_key || row.instrumentKey;
    const underlying = String(row.underlying_symbol || row.asset_symbol || row.trading_symbol || row.name || '')
      .toUpperCase()
      .replace(/\s+(FUT|CE|PE)$/, '')
      .trim();
    if (!instrumentKey || !underlying) { skippedNoSymbol++; continue; }

    if (instrumentType === 'CE' || instrumentType === 'PE') {
      fnoUnderlyings.add(underlying);
      continue;
    }
    if (instrumentType !== 'FUT') continue; // ignore anything else (spreads, indices, etc.)

    const expiryMs = row.expiry ? Number(row.expiry) : NaN;
    if (!Number.isFinite(expiryMs) || expiryMs < todayMs) continue; // already-expired contract

    const existing = nearestFutureByUnderlying.get(underlying);
    if (!existing || expiryMs < existing.expiry) {
      nearestFutureByUnderlying.set(underlying, {
        instrumentKey,
        name: row.name || underlying,
        expiry: expiryMs,
      });
    }
  }

  const bySymbol = new Map();
  for (const [underlying, info] of nearestFutureByUnderlying) {
    bySymbol.set(underlying, { instrumentKey: info.instrumentKey, name: info.name });
    fnoUnderlyings.add(underlying); // every commodity with a live future is a valid F&O underlying
  }

  if (bySymbol.size === 0) {
    throw new AppError(
      `Upstox MCX instrument master parsed to 0 active commodity contracts (downloaded ${list.length} rows, ${skippedNoSymbol} missing symbol/key). The file format may have changed.`,
      502
    );
  }

  return { bySymbol, fnoUnderlyings, fetchedAt: new Date() };
}

// Every stock symbol (across NSE + BSE) that actually has listed options,
// plus the tradeable indices (NIFTY, BANKNIFTY, SENSEX, etc) and every MCX
// commodity with a live futures/options contract (GOLD, SILVER, CRUDEOIL,
// NATURALGAS, etc). Backs the Options page's search bar so it only ever
// suggests underlyings that will actually return a real option chain,
// instead of all 5,000+ equities.
async function getFnoUnderlyings() {
  const symbols = new Set();
  for (const exchange of ALL_BROWSABLE_EXCHANGES) {
    try {
      const { fnoUnderlyings } = await loadInstrumentMaster(exchange);
      fnoUnderlyings.forEach((s) => symbols.add(s));
    } catch {
      // let the other exchange still contribute
    }
  }
  return symbols;
}

// Same as searchSymbols() but filtered down to only F&O-enabled
// underlyings — used by the Options page's underlying search bar.
async function searchFnoSymbols(prefixRaw, limit = 20, exchangeFilter) {
  const prefix = (prefixRaw || '').trim().toUpperCase();
  if (!prefix) return [];

  const fnoSet = await getFnoUnderlyings();
  const results = [];
  for (const exchange of (exchangeFilter ? [exchangeFilter] : ALL_BROWSABLE_EXCHANGES)) {
    let bySymbol;
    try {
      ({ bySymbol } = await loadInstrumentMaster(exchange));
    } catch {
      continue;
    }
    for (const [symbol, info] of bySymbol) {
      if (symbol.startsWith(prefix) && fnoSet.has(symbol)) {
        results.push({ symbol, exchange, name: info.name });
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
}

/**
 * Resolves a plain trading symbol to an Upstox instrument_key, caching the
 * result in Postgres. Tries NSE first (default), falls back to BSE if the
 * symbol isn't listed on NSE. Pass exchange: 'BSE_EQ' to force BSE only, or
 * exchange: 'MCX_FO' to resolve a commodity (e.g. "GOLD", "CRUDEOIL") to
 * its current front-month contract — MCX is never tried automatically, an
 * equity lookup with no exchange given stays NSE-then-BSE only.
 */
// FIX (MCX quotes/candles/screener going dead a few weeks after this was
// first cached — "MCX not showing live quote price"): instrument_cache was
// treated as permanent for every exchange, which is correct for NSE/BSE
// (an equity's instrument_key/ISIN never changes) but WRONG for MCX_FO.
// A commodity resolves to its current FRONT-MONTH FUTURES CONTRACT
// (see parseMcxInstrumentMaster above), which expires and rolls to a new
// contract every month. Once that contract's instrument_key got cached
// here, resolveInstrumentKey kept returning it forever — including after
// the contract expired — so Upstox had nothing live left to quote against
// it. Equities skip this check (no ttlMs passed) and keep the old
// permanent-cache behavior; only MCX_FO rows are subject to it. 24h matches
// the in-memory instrument-master TTL (INSTRUMENT_MASTER_TTL_MS above) so a
// re-resolution always has a freshly-downloaded master to pick the new
// front-month contract from.
async function resolveInstrumentKey(symbolRaw, exchange) {
  const symbol = (symbolRaw || '').trim().toUpperCase();
  if (!symbol) throw new AppError('stockSymbol is required.', 400);

  if (!exchange && SEED_INSTRUMENTS[symbol]) return SEED_INSTRUMENTS[symbol];

  const exchangesToTry = exchange ? [exchange] : ['NSE_EQ', 'BSE_EQ'];

  for (const ex of exchangesToTry) {
    const { rows } = await query(
      ex === 'MCX_FO'
        ? `SELECT instrument_key FROM instrument_cache
           WHERE exchange = $1 AND trading_symbol = $2 AND updated_at > now() - interval '24 hours'`
        : `SELECT instrument_key FROM instrument_cache WHERE exchange = $1 AND trading_symbol = $2`,
      [ex, symbol]
    );
    if (rows.length) return rows[0].instrument_key;

    let bySymbol;
    try {
      ({ bySymbol } = await loadInstrumentMaster(ex));
    } catch (e) {
      continue; // this exchange's file failed to download/parse — still try the other one
    }
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
 * Returns a page of ALL equities/commodities on one exchange (or all of
 * them), for a full stock/contract browser — as opposed to searchSymbols()
 * which is prefix-matching for a search box. Sorted alphabetically for
 * stable pagination. Pass exchange: 'MCX_FO' to browse commodities only.
 */
async function listAllSymbols({ exchange, page = 1, limit = 50 } = {}) {
  const exchanges = exchange ? [exchange] : ALL_BROWSABLE_EXCHANGES;
  let all = [];
  const failures = [];
  for (const ex of exchanges) {
    try {
      const { bySymbol } = await loadInstrumentMaster(ex);
      for (const [symbol, info] of bySymbol) {
        all.push({ symbol, exchange: ex, name: info.name });
      }
    } catch (e) {
      // If the person asked for one specific exchange, surface the error —
      // that's the only data source they wanted. If they asked for "both",
      // still return whichever exchange succeeded rather than blanking the
      // whole screener because e.g. BSE's file had a bad day.
      if (exchange) throw e;
      failures.push(ex);
    }
  }
  all.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const total = all.length;
  const start = (Math.max(1, page) - 1) * limit;
  const items = all.slice(start, start + limit);
  return {
    items, total, page: Math.max(1, page), limit, totalPages: Math.ceil(total / limit),
    ...(failures.length ? { partialFailure: failures } : {}),
  };
}
async function searchSymbols(prefixRaw, limit = 20, exchangeFilter) {
  const prefix = (prefixRaw || '').trim().toUpperCase();
  if (!prefix) return [];

  const results = [];
  for (const exchange of (exchangeFilter ? [exchangeFilter] : ALL_BROWSABLE_EXCHANGES)) {
    let bySymbol;
    try {
      ({ bySymbol } = await loadInstrumentMaster(exchange));
    } catch (e) {
      continue; // let other exchanges still return results
    }
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
async function getLtp(symbol, exchange) {
  const accessToken = await getValidAccessToken();
  const instrumentKey = await resolveInstrumentKey(symbol, exchange);

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
    exchange: instrumentKey.split('|')[0] || null,
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

// ─────────────────────────────────────────────────────────────────────────
//  CANDLE CACHE + 429 RETRY — fixes "Error 1015: You are being rate
//  limited" (Cloudflare, sitting in front of Upstox) cascading into 502s
//  on the charts. Two causes were combined: (1) historical-candle calls had
//  zero caching, so every chart open/reload re-hit Upstox even for data
//  that was just fetched seconds ago, and (2) a single 429 was treated as
//  a hard failure with no retry. Fixed with a short-lived shared cache
//  (mirrors the quoteBatchCache pattern above) plus automatic backoff retry
//  on 429 specifically.
// ─────────────────────────────────────────────────────────────────────────
const CANDLE_CACHE_TTL_MS = 60_000; // 1 minute — historical bars don't need per-second freshness
const candleCache = new Map(); // cacheKey -> { data, expiresAt }

// FIX (hero chart price flipping between real-time and yesterday's close
// every ~minute): getIntradayCandles() used to return [] on ANY failure
// (timeout, 429, a transient empty payload from Upstox) with no fallback.
// Since getIndexHistoricalCandles() merges historical + intraday and takes
// the LAST candle as "today's price", a single flaky intraday poll silently
// dropped all of today's session — the chart reverted to the last daily
// candle (yesterday's close) for that ~60s cache window, then jumped back
// to the real live price once the next poll succeeded. That alternation
// looked like the price was "randomly" changing to numbers that don't
// match the real market. The indices strip above never had this problem
// because getIndexQuotes() already sticks to lastGoodIndexQuotes on a
// failed fetch instead of returning nothing — this mirrors that same
// stickiness for intraday candles.
const lastGoodIntraday = new Map(); // instrumentKey:unit:interval -> candles[]

/**
 * fetch() wrapper that automatically retries on HTTP 429. Cloudflare
 * returns 429 (with "Error 1015: You are being rate limited") when too
 * many requests land in a short window — e.g. the hero chart and the main
 * symbol chart both requesting candles on the same page load. Retries with
 * backoff before giving up, honoring Retry-After when Upstox/Cloudflare
 * sends one.
 */
async function fetchUpstoxWithRetry(url, options, retries = 2) {
  let res;
  for (let attempt = 0; attempt <= retries; attempt++) {
    res = await fetch(url, options);
    if (res.status !== 429 || attempt === retries) return res;
    const retryAfterHeader = parseInt(res.headers.get('retry-after'), 10);
    const waitMs = Number.isFinite(retryAfterHeader) ? retryAfterHeader * 1000 : 500 * (attempt + 1) ** 2;
    await new Promise(r => setTimeout(r, waitMs));
  }
  return res;
}
/** Used by getLtpBatch() when Upstox's live quote has no usable last_price/
 *  previousClose (e.g. after market close) — pulls the last two daily
 *  candles instead, same pattern as the index fallback, so the caller
 *  still gets a real last-close price and real day change instead of null. */
async function getDailyCloseFallback(instrumentKey) {
  try {
    const accessToken = await getValidAccessToken();
    const toDate = new Date().toISOString().slice(0, 10);
    const fromDate = defaultFromDate('days');
    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `${BASE_V3}/historical-candle/${encodedKey}/days/1/${toDate}/${fromDate}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const candles = (data.data?.candles || []).slice().reverse(); // oldest-first
    if (candles.length < 2) return null;
    const lastClose = candles[candles.length - 1][4];
    const prevClose = candles[candles.length - 2][4];
    if (!(prevClose > 0)) return null;
    return { lastPrice: lastClose, previousClose: prevClose, changePct: ((lastClose - prevClose) / prevClose) * 100 };
  } catch {
    return null;
  }
}


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
  // FIX (Reliance/NSE/BSE — and any index requested via this batch
  // endpoint — silently showing yesterday's close instead of the live
  // price): Upstox sometimes echoes instrument_token back with the pipe
  // URL-encoded ("NSE_EQ%7CINE002A01018") instead of literal
  // ("NSE_EQ|INE002A01018"). The map below used to key on the raw token,
  // so a %7C-encoded token never matched our real "|" instrumentKey, the
  // quote lookup silently missed, and every affected row fell through to
  // getDailyCloseFallback() below (a real but stale price) instead of the
  // live one. getIndexQuotes() already normalizes this same %7C quirk —
  // this mirrors that fix here so stock and index rows fetched through
  // /api/market/quotes get it too.
  const normalizeToken = (t) => (typeof t === 'string' ? t.replace('%7C', '|') : t);
  const byInstrumentKey = new Map(
    Object.values(data.data || {}).map((q) => [normalizeToken(q.instrument_token || q.instrument_key), q])
  );

 const quotes = await Promise.all(resolved.map(async ({ symbol, instrumentKey }) => {
    // Upstox keys the response object by a slightly different string than
    // the request instrument_key in some cases, so also try a loose match.
    const quote =
      byInstrumentKey.get(instrumentKey) ||
      Object.values(data.data || {}).find((q) => normalizeToken(q.instrument_token) === instrumentKey);

    // FIX (screener showing the same price for a symbol's NSE row and its
    // BSE row): instrumentKey is "EXCHANGE|ISIN" (e.g. "BSE_EQ|INE..."),
    // so the exchange this quote actually resolved to is right there — we
    // now echo it back so the caller (frontend) can key its results by
    // symbol+exchange instead of by symbol alone. Without this, two rows
    // for the same trading symbol (one NSE, one BSE) were indistinguishable
    // once the response came back, and whichever one the frontend read
    // last silently overwrote the other with its own price.
    const exchange = instrumentKey.split('|')[0] || null;

    const lastPrice = quote?.last_price;
    const netChange = quote?.net_change;
const previousClose = (typeof lastPrice === 'number' && typeof netChange === 'number')
  ? lastPrice - netChange
  : (quote?.ohlc?.close ?? null);

    // After market hours Upstox's live quote endpoint can return nothing for
    // a symbol (no fresh tick to serve) — this is the same gap already
    // handled for the index strip in the frontend's refreshIndices(). Fall
    // back to the last two daily candles so the Screener's Up/Down filter
    // still has real data instead of silently excluding every stock.
    if (typeof lastPrice !== 'number' || typeof previousClose !== 'number' || previousClose <= 0) {
      const fallback = await getDailyCloseFallback(instrumentKey).catch(() => null);
      if (fallback) return { symbol, instrumentKey, exchange, ...fallback, closed: true };
      return { symbol, instrumentKey, exchange, lastPrice: null, previousClose: null, changePct: null };
    }

    const changePct = ((lastPrice - previousClose) / previousClose) * 100;
    return { symbol, instrumentKey, exchange, lastPrice, previousClose, changePct };
  }));
  const result = { quotes, errors: unresolved, fetchedAt: new Date().toISOString() };
  quoteBatchCache.set(cacheKey, { data: result, expiresAt: Date.now() + QUOTE_CACHE_TTL_MS });
  return result;
}
// ─────────────────────────────────────────────────────────────────────────
//  INDEX QUOTES (NIFTY 50 / SENSEX / NIFTY BANK)
// ─────────────────────────────────────────────────────────────────────────

const lastGoodIndexQuotes = {}; // { 'NIFTY 50': {lastPrice, previousClose, changePct, fetchedAt}, ... }

function isIndianMarketOpen(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  // FIX: weekday+time alone can't tell a real trading day apart from a
  // published exchange holiday (Holi, Diwali-Balipratipada, Republic Day,
  // etc.) — without this check the Screener kept logging scanner signals
  // on holidays, polluting the "everyday accuracy" numbers with days the
  // market was never actually open. See utils/tradingCalendar.js.
  if (!isTradingDay(now)) return false;
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= (9 * 60 + 15) && minutes < (15 * 60 + 30);
}

async function getIndexQuotes() {
  const entries = Object.entries(INDEX_INSTRUMENT_KEYS);
  const marketOpen = isIndianMarketOpen();

  let values = [];
  try {
    const accessToken = await getValidAccessToken();
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
    values = Object.values(data.data || {});
  } catch (err) {
    values = [];
  }

  const indices = entries.map(([label, instrumentKey]) => {
    const quote =
      values.find((q) => q.instrument_token === instrumentKey) ||
      values.find((q) => q.instrument_token?.replace('%7C', '|') === instrumentKey);

    const cached = lastGoodIndexQuotes[label];
    const lastPrice = quote?.last_price;
    // IMPORTANT: don't use quote.ohlc.close as "previous close". While the
    // market is open, Upstox's ohlc.close is indeed yesterday's close — but
    // once the market shuts for the day, Upstox updates ohlc.close to *today's*
    // close, which by then equals last_price. That silently collapsed every
    // index's change to exactly 0.00% (and always "up", since 0 >= 0) the
    // moment the market closed. net_change is Upstox's own already-correct
    // absolute change vs. the real previous close and doesn't have this
    // after-hours flip, so prefer it — this mirrors the same fix already
    // applied to getQuotes() for individual stocks above.
    const netChange = quote?.net_change;
    const rawPrevClose = (typeof lastPrice === 'number' && typeof netChange === 'number')
      ? lastPrice - netChange
      : quote?.ohlc?.close;
    const previousClose = (typeof rawPrevClose === 'number' && rawPrevClose > 0)
      ? rawPrevClose
      : (cached?.previousClose ?? null);

    const haveFreshPrice = typeof lastPrice === 'number' && lastPrice > 0;
    const changePct = (haveFreshPrice && typeof previousClose === 'number' && previousClose > 0)
      ? ((lastPrice - previousClose) / previousClose) * 100
      : null;

    if (haveFreshPrice && changePct !== null) {
      const fresh = { lastPrice, previousClose, changePct, fetchedAt: new Date().toISOString() };
      lastGoodIndexQuotes[label] = fresh;
      return { label, instrumentKey, ...fresh, stale: false };
    }
    if (cached) {
      return { label, instrumentKey, ...cached, stale: true };
    }
    return { label, instrumentKey, lastPrice: null, previousClose: null, changePct: null, stale: true };
  });

  return {
    indices,
    marketStatus: marketOpen ? 'open' : 'closed',
    fetchedAt: new Date().toISOString(),
  };
}


async function getIndexHistoricalCandles(label, { unit = 'minutes', interval = 5, from, to } = {}) {
  const instrumentKey = INDEX_INSTRUMENT_KEYS[label.toUpperCase()];
  if (!instrumentKey) throw new AppError(`Unknown index: ${label}`, 400);
  if (!VALID_UNITS.includes(unit)) {
    throw new AppError(`unit must be one of: ${VALID_UNITS.join(', ')}`, 400);
  }
  const toDate = to || new Date().toISOString().slice(0, 10);
  const fromDate = from || defaultFromDate(unit);

  const cacheKey = `idx:${label.toUpperCase()}:${unit}:${interval}:${fromDate}:${toDate}`;
  const cached = candleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const accessToken = await getValidAccessToken();
  const encodedKey = encodeURIComponent(instrumentKey);
  const url = `${BASE_V3}/historical-candle/${encodedKey}/${unit}/${interval}/${toDate}/${fromDate}`;

  // FIX: unlike getHistoricalCandles() (used for stocks), this never pulled
  // in today's candles. Upstox's historical-candle endpoint only ever
  // covers *completed* sessions — it never includes the current day — so
  // the NIFTY 50 / SENSEX / NIFTY BANK hero chart was always missing
  // today's candle during market hours and looked frozen a day behind,
  // even though every candle it did show was real. Now mirrors the stock
  // path: fetch today's candles from the separate intraday endpoint in
  // parallel and merge them in.
  const intradayPromise = ['weeks', 'months'].includes(unit)
    ? Promise.resolve([])
    : getIntradayCandles(instrumentKey, unit, interval);

  const res = await fetchUpstoxWithRetry(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errText = await res.text();
    const msg = res.status === 429
      ? 'Upstox index candle request was rate limited even after retrying — try again shortly.'
      : `Upstox index candle request failed: ${errText.slice(0, 200)}`;
    throw new AppError(msg, 502);
  }
  const data = await res.json();
  const rawCandles = data.data?.candles || [];
  const candles = rawCandles.map(([timestamp, o, h, l, c, v]) => ({ t: timestamp, o, h, l, c, v })).reverse();

  const todayStr = new Date().toISOString().slice(0, 10);
  const intraday = await intradayPromise;
  const merged = [...candles.filter((c) => typeof c.t === 'string' && !c.t.startsWith(todayStr)), ...intraday];

  const result = { label, instrumentKey, unit, interval, candles: merged };
  candleCache.set(cacheKey, { data: result, expiresAt: Date.now() + CANDLE_CACHE_TTL_MS });
  return result;
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
  const instrumentKey = await resolveInstrumentKey(symbol, exchange);

  const toDate = to || new Date().toISOString().slice(0, 10);
  const fromDate = from || defaultFromDate(unit);

  const cacheKey = `sym:${symbol.toUpperCase()}:${exchange || ''}:${unit}:${interval}:${fromDate}:${toDate}`;
  const cached = candleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const accessToken = await getValidAccessToken();
  const encodedKey = encodeURIComponent(instrumentKey);
  const url = `${BASE_V3}/historical-candle/${encodedKey}/${unit}/${interval}/${toDate}/${fromDate}`;

  // FIX (candle fetches getting cancelled client-side at 20s): this used to
  // await the historical call, THEN await the intraday call, adding their
  // latencies together — each can take up to 15s alone, or longer with 429
  // retries. Kicking off intraday here (in parallel with the historical
  // fetch below) instead of after it roughly halves worst-case latency, so
  // it actually fits inside the frontend's 20s fetch timeout.
  const intradayPromise = ['weeks', 'months'].includes(unit)
    ? Promise.resolve([])
    : getIntradayCandles(instrumentKey, unit, interval);

  const res = await fetchUpstoxWithRetry(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    const msg = res.status === 429
      ? 'Upstox historical-candle request was rate limited even after retrying — try again shortly.'
      : `Upstox historical-candle request failed: ${errText.slice(0, 200)}`;
    throw new AppError(msg, 502);
  }

  const data = await res.json();
  const rawCandles = Array.isArray(data.data?.candles) ? data.data.candles : [];

  // Upstox returns candles newest-first as
  //   [timestamp, open, high, low, close, volume, openInterest]
  // The frontend's drawCandles() expects oldest-first { o,h,l,c,v,t }.
  // FIX (500 "Something went wrong" on /candles/:symbol): this used to
  // assume every entry was a well-formed [timestamp,o,h,l,c,v] array and
  // that c.t was always a string, then called c.t.startsWith(todayStr)
  // unconditionally below. A single malformed/short row from Upstox (or a
  // symbol with a gap in its data) threw an uncaught TypeError, which
  // errorHandler.js reports only as the generic "Something went wrong" —
  // giving no hint what actually broke. Now: skip any row that isn't a
  // proper array with a string timestamp instead of crashing on it.
  const candles = rawCandles
    .filter((row) => Array.isArray(row) && typeof row[0] === 'string')
    .map(([timestamp, o, h, l, c, v]) => ({ t: timestamp, o, h, l, c, v }))
    .reverse();

  const todayStr = new Date().toISOString().slice(0, 10);
  // Upstox's intraday endpoint only returns meaningful data for day/minute/
  // hour granularity — today's single session doesn't map onto a "weeks" or
  // "months" candle, so skip the call entirely for those units instead of
  // firing a request that can only ever come back empty (or error). This is
  // the weekly leg the Multi-Timeframe / "Check daily vs weekly" view uses.
  const intraday = await intradayPromise;
  const merged = [...candles.filter((c) => typeof c.t === 'string' && !c.t.startsWith(todayStr)), ...intraday];

  const result = { symbol: symbol.toUpperCase(), instrumentKey, unit, interval, candles: merged };
  candleCache.set(cacheKey, { data: result, expiresAt: Date.now() + CANDLE_CACHE_TTL_MS });
  return result;
}
/** Fetches TODAY's candles (Upstox's separate intraday endpoint — historical never includes today). */
async function getIntradayCandles(instrumentKey, unit, interval) {
  const stickyKey = `${instrumentKey}:${unit}:${interval}`;
  try {
    const cacheKey = `intraday:${instrumentKey}:${unit}:${interval}`;
    const cached = candleCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const accessToken = await getValidAccessToken();
    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `${BASE_V3}/historical-candle/intraday/${encodedKey}/${unit}/${interval}`;
    const res = await fetchUpstoxWithRetry(url, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      // Before market open there genuinely is no intraday data yet — that's
      // a real [], not a failure, so don't mask it with stale data. Any
      // other non-ok (timeout, 429 after retries, transient 5xx) is a
      // real failure worth falling back for.
      if (res.status === 400 && !isIndianMarketOpen()) return [];
      return lastGoodIntraday.get(stickyKey) || [];
    }
    const data = await res.json();
    const raw = data.data?.candles || [];
    const result = raw.map(([timestamp, o, h, l, c, v]) => ({ t: timestamp, o, h, l, c, v })).reverse();
    // An empty-but-ok payload during market hours is also more likely a
    // transient Upstox blip than "no trades happened all day" — prefer the
    // last good snapshot over letting the chart lose today's session.
    if (!result.length && isIndianMarketOpen()) {
      const sticky = lastGoodIntraday.get(stickyKey);
      if (sticky) return sticky;
    }
    if (result.length) lastGoodIntraday.set(stickyKey, result);
    // Short TTL — intraday candles should stay reasonably fresh during market hours.
    candleCache.set(cacheKey, { data: result, expiresAt: Date.now() + 15_000 });
    return result;
  } catch {
    return lastGoodIntraday.get(stickyKey) || [];
  }
}
function defaultFromDate(unit) {
  const d = new Date();
  if (unit === 'minutes' || unit === 'hours') d.setDate(d.getDate() - 30);
  else if (unit === 'days') d.setMonth(d.getMonth() - 6);
  else d.setFullYear(d.getFullYear() - 5);
  return d.toISOString().slice(0, 10);
}

// ── Screener "Time Interval" chip -> candle params ───────────────────────
// FIX: the Screener sidebar's Time Interval chips (1 Minute ... 5 Year)
// were purely cosmetic — they set screenerPeriod client-side and even sent
// it to the backend as ?period=, but nothing on the backend ever read that
// query param, so every signal and every "full analysis" report was always
// computed off hardcoded daily candles no matter which interval was
// selected. This mapping is what actually drives the computation now. The
// short intraday/1D/1W/1M chips map to a real Upstox candle granularity;
// Upstox has no such thing as a single "3 month" candle, so the longer
// chips (3mo-5y) stay on daily candles but widen how much history the
// indicators are computed over instead — same idea as the Analysis page's
// 6M/1Y hero-chart range presets.
const PERIOD_CANDLE_PARAMS = {
  '1m': { unit: 'minutes', interval: 1 },
  '5m': { unit: 'minutes', interval: 5 },
  '15m': { unit: 'minutes', interval: 15 },
  '30m': { unit: 'minutes', interval: 30 },
  '1h': { unit: 'hours', interval: 1 },
  '4h': { unit: 'hours', interval: 4 },
  '1d': { unit: 'days', interval: 1 },
  '1w': { unit: 'weeks', interval: 1 },
  '1mo': { unit: 'months', interval: 1 },
  '3mo': { unit: 'days', interval: 1, lookbackDays: 90 },
  '6mo': { unit: 'days', interval: 1, lookbackDays: 182 },
  '1y': { unit: 'days', interval: 1, lookbackDays: 365 },
  '3y': { unit: 'days', interval: 1, lookbackDays: 365 * 3 },
  '5y': { unit: 'days', interval: 1, lookbackDays: 365 * 5 },
};
function candleParamsForPeriod(period) {
  const entry = PERIOD_CANDLE_PARAMS[period];
  if (!entry) return { unit: 'days', interval: 1 }; // unknown/absent period: same default as before
  const { unit, interval, lookbackDays } = entry;
  if (!lookbackDays) return { unit, interval };
  const from = new Date();
  from.setDate(from.getDate() - lookbackDays);
  return { unit, interval, from: from.toISOString().slice(0, 10) };
}

// ─────────────────────────────────────────────────────────────────────────
//  SCREENER BULLISH / BEARISH / NEUTRAL BIAS — computed technical analysis, not AI
// ─────────────────────────────────────────────────────────────────────────
// Every value here comes from real daily candles (same Upstox
// historical-candle data the charts use) run through utils/indicators.js.
// No LLM is involved anywhere in this path. Per-symbol results are cached
// for SIGNAL_CACHE_TTL_MS since a daily-candle-based signal doesn't need
// to move on every live tick like price does — this also keeps Upstox
// request volume sane when the Screener renders 50 symbols at once.
const { computeAllIndicators, deriveSignal, buildFullTechnicalReport } = require('../utils/indicators');
const { computeQuantReport } = require('../utils/quantReport');
const scannerAccuracyService = require('./scannerAccuracyService');
const signalCache = new Map(); // "SYMBOL:EXCHANGE" -> { data, expiresAt }
const SIGNAL_CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes
const reportCache = new Map(); // "SYMBOL:EXCHANGE" -> { data, expiresAt }
const quantReportCache = new Map(); // "SYMBOL:EXCHANGE:PERIOD:BENCHMARK" -> { data, expiresAt }
const QUANT_REPORT_CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes — matches signal/report cache

// ── FULL TECHNICAL REPORT (Screener "full analysis" view) ────────────────
// Rule-based, no AI/LLM involved — same real candles + indicators as the
// screener bias, but returns every section of the full descriptive report
// (Trend, Price Action, Support/Resistance, Moving Average, RSI, MACD,
// Volume, Candlestick Analysis, Volatility, Trend Strength/ADX, Bollinger
// Bands, Fibonacci Zone, Indicator Summary, Technical Score, Conclusion).
// COMPLIANCE: purely descriptive, no buy/sell/hold verdict — see
// buildFullTechnicalReport() in utils/indicators.js.
async function getFullTechnicalReport(symbol, exchange, period) {
  // FIX: cache key used to ignore timeframe entirely, so once a report was
  // cached for a symbol (e.g. from the default daily view) every other
  // Time Interval chip would just be served that same cached daily report
  // for the next 20 minutes instead of being recomputed at its own
  // candle granularity.
  const cacheKey = `${symbol.toUpperCase()}:${exchange || ''}:${period || '1d'}`;
  const cached = reportCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  try {
    const { unit, interval, from } = candleParamsForPeriod(period);
    const { candles } = await getHistoricalCandles(symbol, { unit, interval, from, exchange });
    const ind = computeAllIndicators(candles);
    const report = buildFullTechnicalReport(ind, { lookback: 60 });
    const data = report
      ? { symbol: symbol.toUpperCase(), currentPrice: ind.currentPrice, period: period || '1d', unit, interval, ...report }
      : { symbol: symbol.toUpperCase(), error: 'Not enough real candle history yet to build a full report.' };
    reportCache.set(cacheKey, { data, expiresAt: Date.now() + SIGNAL_CACHE_TTL_MS });
    return data;
  } catch (err) {
    return { symbol: symbol.toUpperCase(), error: err.message };
  }
}

async function getTechnicalSignal(symbol, exchange, period) {
  // FIX: same stale-cache-across-timeframes bug as getFullTechnicalReport
  // above — the cache key must include the period, otherwise whichever
  // Time Interval chip happened to populate the cache first "wins" for
  // every other chip for the next 20 minutes.
  const cacheKey = `${symbol.toUpperCase()}:${exchange || ''}:${period || '1d'}`;
  const cached = signalCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  try {
    const { unit, interval, from } = candleParamsForPeriod(period);
    const { candles } = await getHistoricalCandles(symbol, { unit, interval, from, exchange });
    const ind = computeAllIndicators(candles);
    const derived = deriveSignal(ind);
    // COMPLIANCE: exposes strength/bullishVotes (descriptive), not a
    // signal/confidence verdict — see indicators.js deriveSignal() note.
    // exchange included so a dual-listed symbol's NSE-row and BSE-row
    // signals never collide under a single "SYMBOL" key on the frontend
    // (same fix as getLtpBatch's exchange field above).
    const data = derived
      ? { symbol: symbol.toUpperCase(), exchange: exchange || null, period: period || '1d', currentPrice: ind.currentPrice, strength: derived.strength, strengthScore: derived.strengthScore, bullishVotes: derived.bullishVotes, totalVotes: derived.totalVotes, votes: derived.votes }
      : { symbol: symbol.toUpperCase(), exchange: exchange || null, period: period || '1d', currentPrice: ind.currentPrice, strength: null, strengthScore: null, bullishVotes: null, totalVotes: null, votes: [], error: 'Not enough candle history yet.' };
    signalCache.set(cacheKey, { data, expiresAt: Date.now() + SIGNAL_CACHE_TTL_MS });

    // Log this freshly-computed signal for accuracy tracking — every stock
    // the Screener scans, at every timeframe, gets recorded (deduped to one
    // row per symbol+timeframe+day by the DB unique constraint). Only while
    // the market is actually open, and never lets a logging failure break
    // the Screener response — see scannerAccuracyService.js.
    if (derived && ind.currentPrice && isIndianMarketOpen()) {
      scannerAccuracyService
        .logSignal({ symbol: symbol.toUpperCase(), exchange, period: period || '1d', derived, currentPrice: ind.currentPrice })
        .catch((err) => console.warn(`[scannerAccuracy] log failed for ${symbol}:`, err.message));
    }

    return data;
  } catch (err) {
    return { symbol: symbol.toUpperCase(), period: period || '1d', currentPrice: null, strength: null, strengthScore: null, bullishVotes: null, totalVotes: null, votes: [], error: err.message };
  }
}

// ── GET-style aggregator: the full quant-analysis engine (statistics,
// price-action structure, extra technical indicators, divergences,
// anomalies, benchmark-relative strength, and a grouped composite score)
// on top of the existing core technical report. See utils/quantReport.js
// for the full breakdown and the compliance rationale for why this stays
// descriptive rather than a buy/sell verdict.
async function getQuantReport(symbol, exchange, period, benchmarkUnderlying) {
  const cacheKey = `${symbol.toUpperCase()}:${exchange || ''}:${period || '1d'}:${benchmarkUnderlying || ''}`;
  const cached = quantReportCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  try {
    const { unit, interval, from } = candleParamsForPeriod(period);
    const { candles } = await getHistoricalCandles(symbol, { unit, interval, from, exchange });

    let benchmarkCandles;
    if (benchmarkUnderlying) {
      try {
        const benchResult = await getIndexHistoricalCandles(benchmarkUnderlying, { unit, interval, from });
        benchmarkCandles = benchResult?.candles;
      } catch (err) {
        // Benchmark is optional context — a failure here shouldn't break
        // the rest of a real, otherwise-successful quant report.
        console.warn(`[quantReport] benchmark fetch failed for ${benchmarkUnderlying}:`, err.message);
      }
    }

    const report = computeQuantReport(candles, { benchmarkCandles });
    const data = { symbol: symbol.toUpperCase(), period: period || '1d', unit, interval, benchmark: benchmarkUnderlying || null, ...report };
    quantReportCache.set(cacheKey, { data, expiresAt: Date.now() + QUANT_REPORT_CACHE_TTL_MS });
    return data;
  } catch (err) {
    return { symbol: symbol.toUpperCase(), period: period || '1d', error: err.message };
  }
}

// Fetches signals for many symbols with limited concurrency (Upstox has no
// batch historical-candle endpoint, so this is N individual requests —
// capped at 6 in flight at a time to stay well under rate limits).
async function getSignalsBatch(symbols, period) {
  const list = Array.isArray(symbols) ? symbols : [];
  const CONCURRENCY = 6;
  const results = [];
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const idx = i++;
      const s = list[idx];
      const symbol = typeof s === 'string' ? s : s.symbol;
      const exchange = typeof s === 'string' ? undefined : s.exchange;
      results[idx] = await getTechnicalSignal(symbol, exchange, period);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  return results;
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
  searchFnoSymbols,
  getFnoUnderlyings,
  listAllSymbols,
  getLtp,
  getLtpBatch,
  getOptionChain,
  getHistoricalCandles,
  getIndexQuotes,
  getIndexHistoricalCandles,
  getTechnicalSignal,
  getSignalsBatch,
  isIndianMarketOpen,
  getFullTechnicalReport,
  getQuantReport,
  candleParamsForPeriod,
};

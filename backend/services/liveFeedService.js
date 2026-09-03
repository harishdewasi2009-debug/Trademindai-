// services/liveFeedService.js
// ══════════════════════════════════════════════════════════════════════════
//  REAL Upstox WebSocket live feed (Market Data Feed V3).
//
//  Replaces REST polling for live ticks:
//   Upstox pushes a tick the instant a price changes → we relay it straight
//   to every connected browser tab over our own WebSocket at /ws/market.
//
//  Uses the official `upstox-js-sdk` package (MarketDataStreamerV3), which
//  handles the OAuth handshake, redirect, and protobuf decoding internally
//  and hands us plain JSON in the "message" event — no manual protobuf
//  wrangling needed on our side.
//
//  Requires: npm install upstox-js-sdk   (run this once in /backend)
// ══════════════════════════════════════════════════════════════════════════
const UpstoxClient = require('upstox-js-sdk');
const { resolveInstrumentKey } = require('./marketDataService');

// Same curated list the frontend ticker/screener already uses — kept here
// too so the live feed can subscribe on the backend without waiting for a
// browser to ask for anything. Add symbols here if you add them on the
// frontend's TICKER_SYMBOLS list.
const DEFAULT_SYMBOLS = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'WIPRO', 'ICICIBANK', 'SBIN', 'BAJFINANCE', 'HCLTECH', 'AXISBANK',
  'TATAMOTORS', 'ADANIENT', 'MARUTI', 'SUNPHARMA', 'LTIM', 'TITAN', 'KOTAKBANK', 'LT', 'ITC', 'HINDUNILVR',
  'BAJAJFINSV', 'CIPLA', 'APOLLOHOSP', 'ASTRAL', 'DMART', 'POLYCAB', 'ABFRL', 'NESTLEIND', 'ULTRACEMCO', 'ONGC',
];
// The handful of MCX commodities most retail traders actually watch — kept
// small and separate from DEFAULT_SYMBOLS since each one costs an instrument-
// master lookup (front-month contract resolution, see marketDataService's
// parseMcxInstrumentMaster) rather than a free seeded lookup. Streamed
// alongside the equities above so the live feed has commodity ticks ready
// without waiting for a browser to open the MCX tab first.
const DEFAULT_MCX_SYMBOLS = ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER'];
const INDEX_INSTRUMENT_KEYS = {
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'NIFTY BANK': 'NSE_INDEX|Nifty Bank',
  'SENSEX': 'BSE_INDEX|SENSEX',
};

// A plain symbol ("RELIANCE") can be listed on both NSE and BSE. The
// default/DEFAULT_SYMBOLS feed is always NSE, so it keeps the old bare
// "RELIANCE" key for backward compatibility with the ticker/watchlist,
// which never send an exchange. An explicit BSE watch (from the Charts
// page's NSE/BSE switch) gets its own "BSE:RELIANCE" key so its ticks never
// get confused with — or overwritten by — the NSE feed for the same symbol.
// MCX commodities always get an "MCX:" prefix — there's no bare/default
// form for them the way NSE is the default for equities, since a commodity
// symbol like "GOLD" has no equity-side meaning to collide with.
function feedKeyFor(symbol, exchange) {
  if (exchange === 'MCX_FO') return `MCX:${symbol}`;
  return exchange === 'BSE_EQ' ? `BSE:${symbol}` : symbol;
}

let streamer = null;
const browserClients = new Set();       // Set<ws.WebSocket> — connected frontend tabs
let instrumentKeyToSymbol = new Map();  // "NSE_EQ|INE..." -> { symbol, feedKey }
const lastKnownFeed = new Map();        // feedKey -> last tick, sent as an instant snapshot to new clients

/** Call from server.js when a browser opens a WS connection to /ws/market (after auth). */
function registerBrowserClient(ws) {
  browserClients.add(ws);
  ws.on('close', () => browserClients.delete(ws));
  ws.on('error', () => browserClients.delete(ws));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf-8')); } catch { return; }
    if (msg.type === 'watch' && typeof msg.symbol === 'string') {
      watchSymbol(msg.symbol, msg.exchange).catch((err) => console.warn('[liveFeedService] watchSymbol failed:', err.message));
    }
  });
  if (lastKnownFeed.size) {
    ws.send(JSON.stringify({ type: 'snapshot', feeds: Object.fromEntries(lastKnownFeed) }));
  }
}

/** Called when a browser asks to watch a symbol that isn't already in the
 *  live feed (e.g. searched/charted but not in DEFAULT_SYMBOLS). Resolves
 *  its instrument key and adds it to the running Upstox subscription.
 *  Pass exchange: 'BSE_EQ' to watch the BSE listing specifically, or
 *  exchange: 'MCX_FO' to watch a commodity (GOLD, CRUDEOIL, ...) — otherwise
 *  resolveInstrumentKey tries NSE first, same default as everywhere else. */
async function watchSymbol(symbolRaw, exchangeRaw) {
  if (!streamer) return; // live feed not started yet — nothing to add to
  const symbol = symbolRaw.toUpperCase();
  const exchange = ['NSE_EQ', 'BSE_EQ', 'MCX_FO'].includes(exchangeRaw) ? exchangeRaw : undefined;
  const feedKey = feedKeyFor(symbol, exchange);
  if ([...instrumentKeyToSymbol.values()].some((v) => v.feedKey === feedKey)) return; // already watching

  const instrumentKey = await resolveInstrumentKey(symbol, exchange);
  instrumentKeyToSymbol.set(instrumentKey, { symbol, feedKey });
  streamer.subscribe([instrumentKey], 'full');
  console.log(`[liveFeedService] Added ${feedKey} to live feed on demand.`);
}
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of browserClients) {
    if (client.readyState === 1 /* OPEN */) client.send(msg);
  }
}

/** Pulls an LTP + previous-close pair out of whichever shape Upstox sent this tick in. */
function extractLtpc(feed) {
  return feed.ltpc || feed.fullFeed?.marketFF?.ltpc || feed.fullFeed?.indexFF?.ltpc || null;
}

/**
 * (Re)starts the Upstox live feed with a fresh access token. Call this:
 *   - once at server boot, if Upstox is already connected
 *   - every time a new token is stored (initial admin connect + the daily
 *     refresh via the notifier webhook) — tokens expire ~3:30am IST daily,
 *     so the old socket goes stale and must be replaced.
 */
async function startLiveFeed(accessToken, symbols = DEFAULT_SYMBOLS, mcxSymbols = DEFAULT_MCX_SYMBOLS) {
  stopLiveFeed();

  const resolved = await Promise.all(symbols.map(async (symbol) => {
    try {
      const instrumentKey = await resolveInstrumentKey(symbol);
      return { symbol, instrumentKey, feedKey: symbol };
    } catch {
      return null; // symbol didn't resolve — skip it, don't kill the whole feed
    }
  }));
  // MCX commodities resolved separately with exchange: 'MCX_FO' pinned —
  // otherwise resolveInstrumentKey's default NSE-then-BSE lookup would just
  // 404 on a symbol like "CRUDEOIL" that isn't an equity at all.
  const resolvedMcx = await Promise.all(mcxSymbols.map(async (symbol) => {
    try {
      const instrumentKey = await resolveInstrumentKey(symbol, 'MCX_FO');
      return { symbol, instrumentKey, feedKey: feedKeyFor(symbol, 'MCX_FO') };
    } catch (e) {
      console.warn(`[liveFeedService] MCX symbol ${symbol} did not resolve — skipping:`, e.message);
      return null;
    }
  }));
  const valid = [...resolved, ...resolvedMcx].filter(Boolean);
  instrumentKeyToSymbol = new Map(valid.map((v) => [v.instrumentKey, { symbol: v.symbol, feedKey: v.feedKey }]));
  const instrumentKeys = valid.map((v) => v.instrumentKey);
for (const [symbol, instrumentKey] of Object.entries(INDEX_INSTRUMENT_KEYS)) {
    instrumentKeyToSymbol.set(instrumentKey, { symbol, feedKey: symbol });
    instrumentKeys.push(instrumentKey);
  }
  if (!instrumentKeys.length) {
    console.warn('[liveFeedService] No symbols resolved — live feed not started.');
    return;
  }

  const defaultClient = UpstoxClient.ApiClient.instance;
  defaultClient.authentications['OAUTH2'].accessToken = accessToken;

  streamer = new UpstoxClient.MarketDataStreamerV3();

  streamer.on('open', () => {
    console.log(`[liveFeedService] Connected to Upstox — subscribing to ${instrumentKeys.length} symbols`);
    streamer.subscribe(instrumentKeys, 'full');
  });

 streamer.on('message', (raw) => {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString('utf-8'));
    } catch {
      return; // ping/keepalive or non-JSON frame — ignore
    }
    const feeds = parsed.feeds || {};
    console.log('[liveFeedService] tick for:', Object.keys(feeds).map((k) => instrumentKeyToSymbol.get(k)?.feedKey || k).join(', '));
    const out = {};
    for (const [instrumentKey, feed] of Object.entries(feeds)) {
      const info = instrumentKeyToSymbol.get(instrumentKey);
      const ltpc = extractLtpc(feed);
      if (!info || !ltpc || typeof ltpc.ltp !== 'number') continue;

      const price = ltpc.ltp;
      const prevClose = ltpc.cp;
      const changePct = (typeof prevClose === 'number' && prevClose > 0)
        ? ((price - prevClose) / prevClose) * 100
        : 0;

      const entry = { price, changePct, up: changePct >= 0 };
      out[info.feedKey] = entry;
      lastKnownFeed.set(info.feedKey, entry);
    }
    if (Object.keys(out).length) broadcast({ type: 'tick', feeds: out });
  });

  // FIX (server crash loop): a 401 here means the access token itself is
  // invalid/expired — no amount of reconnecting will fix that, and the
  // upstox-js-sdk's own internal auto-reconnect timer has a bug that throws
  // an uncaught exception on every retry attempt (see server.js's
  // uncaughtException handler for the full story), which was crashing the
  // whole backend in a loop. Stop the feed ourselves the moment we see a
  // 401 instead of letting the SDK keep hammering that buggy retry path —
  // startUpstoxTokenScheduler() will call startLiveFeed() again with a
  // fresh token once one is available.
  streamer.on('error', (err) => {
    const message = err?.message || String(err);
    console.error('[liveFeedService] Upstox stream error:', message);
    if (/401/.test(message)) {
      console.error('[liveFeedService] Token appears invalid/expired — stopping the feed instead of letting the SDK retry (avoids a known upstox-js-sdk reconnect crash).');
      stopLiveFeed();
    }
  });
  streamer.on('close', () => console.warn('[liveFeedService] Upstox stream closed.'));
  streamer.on('autoReconnectStopped', () => console.error('[liveFeedService] Gave up reconnecting to Upstox — call startLiveFeed() again with a fresh token.'));

  streamer.connect();
}

function stopLiveFeed() {
  if (streamer) {
    try { streamer.disconnect(); } catch { /* already closed */ }
    streamer = null;
  }
}

module.exports = { startLiveFeed, stopLiveFeed, registerBrowserClient, watchSymbol, DEFAULT_SYMBOLS, DEFAULT_MCX_SYMBOLS, INDEX_INSTRUMENT_KEYS };

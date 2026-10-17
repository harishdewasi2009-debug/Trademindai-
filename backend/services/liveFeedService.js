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
const { normalizeToken } = require('../utils/quoteUtils');

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
    // Registry-era watch: any verified Upstox instrument, addressed by its instrument_key.
    if (msg.type === 'watch' && typeof msg.instrumentKey === 'string') {
      watchInstrument(msg.instrumentKey).then(() => {
        // Already-subscribed instruments (the default stocks/indices/MCX list) would otherwise show nothing
        // until their next price change — hand the new viewer the last known tick straight away.
        const last = lastKnownFeed.get(msg.instrumentKey);
        if (last && ws.readyState === 1) ws.send(JSON.stringify({ type: 'tick', feeds: { [msg.instrumentKey]: last } }));
      }).catch((err) => {
        console.warn('[liveFeedService] watchInstrument failed:', err.message);
        try { ws.send(JSON.stringify({ type: 'watch_rejected', instrumentKey: msg.instrumentKey, reason: err.message })); } catch { /* socket closed */ }
      });
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
// ── Registry-era streaming: watch ANY verified instrument by instrument_key ──
// Subscription cap (Upstox limits WebSocket subscriptions per connection/user;
// verify the current figure for your plan and set UPSTOX_WS_MAX_SUBSCRIPTIONS).
const MAX_SUBSCRIPTIONS = parseInt(process.env.UPSTOX_WS_MAX_SUBSCRIPTIONS, 10) || 1000;
const dynamicKeys = [];            // instrument_keys added on demand, oldest first
const defaultKeys = new Set();     // never evicted
const { isValidInstrumentKey } = require('../utils/instrumentKey');
const segmentsVerifiedThisFeed = new Set();
let feedStartedAt = null;
let lastTickAt = null;
let reconnectState = { attempts: 0, timer: null, lastError: null };

async function watchInstrument(instrumentKey) {
  if (!streamer) throw new Error('Live feed is not running.');
  if (!isValidInstrumentKey(instrumentKey)) throw new Error('Invalid instrument key.');
  if (instrumentKeyToSymbol.has(instrumentKey)) return;
  // Only instruments present in the verified registry may be streamed.
  const { query } = require('../db/pool');
  const { rows } = await query('SELECT symbol FROM market_registry WHERE instrument_key = $1', [instrumentKey]);
  if (!rows.length) throw new Error('Instrument is not in the verified Upstox registry.');

  if (instrumentKeyToSymbol.size >= MAX_SUBSCRIPTIONS) {
    const evict = dynamicKeys.shift();
    if (!evict) throw new Error(`Subscription limit (${MAX_SUBSCRIPTIONS}) reached.`);
    try { streamer.unsubscribe([evict]); } catch { /* best effort */ }
    instrumentKeyToSymbol.delete(evict);
  }
  instrumentKeyToSymbol.set(instrumentKey, { symbol: rows[0].symbol, feedKey: instrumentKey });
  dynamicKeys.push(instrumentKey);
  streamer.subscribe([instrumentKey], 'full');
}

function getFeedState() {
  return {
    running: !!streamer, startedAt: feedStartedAt, lastTickAt,
    subscriptions: instrumentKeyToSymbol.size, maxSubscriptions: MAX_SUBSCRIPTIONS,
    segmentsWithVerifiedTicks: [...segmentsVerifiedThisFeed],
    reconnect: { attempts: reconnectState.attempts, scheduled: !!reconnectState.timer, lastError: reconnectState.lastError },
    browserClients: browserClients.size,
  };
}

// Bounded exponential backoff reconnect. Auth failures (401/403) are never
// retried — the daily token scheduler restarts the feed with a fresh token.
const MAX_RECONNECT_ATTEMPTS = 8;
function scheduleReconnect(reason) {
  reconnectState.lastError = reason;
  if (/401|403|unauthor|forbidden|invalid token/i.test(reason || '')) return;
  if (reconnectState.timer || reconnectState.attempts >= MAX_RECONNECT_ATTEMPTS) return;
  const delay = Math.min(5000 * 2 ** reconnectState.attempts, 5 * 60_000);
  reconnectState.attempts++;
  console.warn(`[liveFeedService] reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectState.attempts}/${MAX_RECONNECT_ATTEMPTS})`);
  reconnectState.timer = setTimeout(async () => {
    reconnectState.timer = null;
    try {
      const { getValidAccessToken } = require('./marketDataService');
      await startLiveFeed(await getValidAccessToken(), undefined, undefined, { isReconnect: true });
    } catch (e) {
      console.warn('[liveFeedService] reconnect failed:', e.message);
      scheduleReconnect(e.message);
    }
  }, delay);
  reconnectState.timer.unref?.();
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
async function startLiveFeed(accessToken, symbols = DEFAULT_SYMBOLS, mcxSymbols = DEFAULT_MCX_SYMBOLS, { isReconnect = false } = {}) {
  stopLiveFeed();
  if (!isReconnect) { reconnectState.attempts = 0; }
  if (reconnectState.timer && !isReconnect) { clearTimeout(reconnectState.timer); reconnectState.timer = null; }
  segmentsVerifiedThisFeed.clear(); dynamicKeys.length = 0; defaultKeys.clear();

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
  // One real sample instrument per discovered segment, so each segment's
  // streaming availability is PROVEN by an actual tick rather than assumed.
  try {
    const { query } = require('../db/pool');
    const { rows } = await query(`SELECT segment, sample_keys FROM market_segment_status WHERE instrument_count > 0 AND sample_keys IS NOT NULL`);
    for (const r of rows) {
      const k = String(r.sample_keys).split(',')[0];
      if (k && !instrumentKeyToSymbol.has(k)) { instrumentKeyToSymbol.set(k, { symbol: k, feedKey: k }); instrumentKeys.push(k); }
    }
  } catch (e) { /* registry not built yet — streaming proof happens after the first probe */ }
  for (const k of instrumentKeys) defaultKeys.add(k);
  if (!instrumentKeys.length) {
    console.warn('[liveFeedService] No symbols resolved — live feed not started.');
    return;
  }

  const defaultClient = UpstoxClient.ApiClient.instance;
  defaultClient.authentications['OAUTH2'].accessToken = accessToken;

  streamer = new UpstoxClient.MarketDataStreamerV3();

  // Belt-and-suspenders on top of the "stop on any error" fix below: tell
  // the SDK itself not to auto-reconnect, in case its internal retry timer
  // ever fires before our own error handler gets a chance to call
  // stopLiveFeed().
  streamer.autoReconnect(false);

  streamer.on('open', () => {
    reconnectState.attempts = 0; reconnectState.lastError = null; feedStartedAt = new Date().toISOString();
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
    for (const [rawKey, feed] of Object.entries(feeds)) {
      const instrumentKey = normalizeToken(rawKey); // Upstox sometimes echoes "NSE_INDEX%7CNifty%2050"
      const info = instrumentKeyToSymbol.get(instrumentKey);
      const ltpc = extractLtpc(feed);
      if (!info || !ltpc || typeof ltpc.ltp !== 'number') continue;

      const price = ltpc.ltp;
      const prevClose = ltpc.cp;
      const changePct = (typeof prevClose === 'number' && prevClose > 0)
        ? ((price - prevClose) / prevClose) * 100
        : 0;

      const ltt = Number(ltpc.ltt);
      const entry = { price, changePct, up: changePct >= 0, ts: Number.isFinite(ltt) && ltt > 0 ? ltt : Date.now(), source: 'Upstox' };
      lastTickAt = new Date().toISOString();
      const seg = instrumentKey.split('|')[0];
      if (seg && !segmentsVerifiedThisFeed.has(seg)) {
        segmentsVerifiedThisFeed.add(seg);
        require('./upstoxProbe').recordStreamingTick(seg);
      }
      out[info.feedKey] = entry;
      lastKnownFeed.set(info.feedKey, entry);
      // FIX (market instruments "not working" live): the ticker's default stocks, the 3 indices and the MCX
      // list were broadcast ONLY under a legacy feed key ("RELIANCE", "NIFTY 50", "MCX:GOLD"), but the Market
      // page listens under the instrument_key — so those instruments never ticked. Publish under both.
      if (info.feedKey !== instrumentKey) { out[instrumentKey] = entry; lastKnownFeed.set(instrumentKey, entry); }
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
  // FIX (Google sign-in "signal timed out" — server up but unresponsive):
  // the SDK's buggy internal auto-reconnect timer wasn't only failing on
  // 401 — it also throws as AggregateError, TypeError, etc. Retrying every
  // ~1 second, each attempt hitting the same crash-prone internal path,
  // flooded Node's single-threaded event loop with synchronous error
  // handling. The server never actually crashed (uncaughtException catches
  // it now), but it became too busy to service other requests — like
  // /api/auth/google — within the frontend's timeout window. Since a
  // reconnect loop that's failing this fast is never going to self-heal
  // anyway, stop the feed on ANY stream error now, not just 401s, so it
  // fails once and stays quiet instead of retrying forever.
  streamer.on('error', (err) => {
    const message = err?.message || String(err);
    console.error('[liveFeedService] Upstox stream error:', message, '— stopping the feed instead of letting the SDK retry.');
    stopLiveFeed();
    scheduleReconnect(message); // our own bounded backoff (the SDK's internal retry stays disabled)
  });
  streamer.on('close', () => console.warn('[liveFeedService] Upstox stream closed.'));
  streamer.on('autoReconnectStopped', () => console.error('[liveFeedService] Gave up reconnecting to Upstox — call startLiveFeed() again with a fresh token.'));

  streamer.connect();
}

function stopLiveFeed() {
  if (streamer) {
    try { streamer.disconnect(); } catch { /* already closed */ }
    try { streamer.removeAllListeners?.(); } catch { /* not supported, fine */ }
    streamer = null;
  }
}

module.exports = { startLiveFeed, stopLiveFeed, registerBrowserClient, watchSymbol, watchInstrument, getFeedState, DEFAULT_SYMBOLS, DEFAULT_MCX_SYMBOLS, INDEX_INSTRUMENT_KEYS };

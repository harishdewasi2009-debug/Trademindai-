// services/liveFeedService.js
const UpstoxClient = require('upstox-js-sdk');
const { resolveInstrumentKey } = require('./marketDataService');

const DEFAULT_SYMBOLS = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'WIPRO', 'ICICIBANK', 'SBIN', 'BAJFINANCE', 'HCLTECH', 'AXISBANK',
  'TATAMOTORS', 'ADANIENT', 'MARUTI', 'SUNPHARMA', 'LTIM', 'TITAN', 'KOTAKBANK', 'LT', 'ITC', 'HINDUNILVR',
  'BAJAJFINSV', 'CIPLA', 'APOLLOHOSP', 'ASTRAL', 'DMART', 'POLYCAB', 'ABFRL', 'NESTLEIND', 'ULTRACEMCO', 'ONGC',
];

let streamer = null;
const browserClients = new Set();
let instrumentKeyToSymbol = new Map();
const lastKnownFeed = new Map();

function registerBrowserClient(ws) {
  browserClients.add(ws);
  ws.on('close', () => browserClients.delete(ws));
  ws.on('error', () => browserClients.delete(ws));
  if (lastKnownFeed.size) {
    ws.send(JSON.stringify({ type: 'snapshot', feeds: Object.fromEntries(lastKnownFeed) }));
  }
}

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of browserClients) {
    if (client.readyState === 1) client.send(msg);
  }
}

function extractLtpc(feed) {
  return feed.ltpc || feed.fullFeed?.marketFF?.ltpc || feed.fullFeed?.indexFF?.ltpc || null;
}

async function startLiveFeed(accessToken, symbols = DEFAULT_SYMBOLS) {
  stopLiveFeed();

  const resolved = await Promise.all(symbols.map(async (symbol) => {
    try {
      const instrumentKey = await resolveInstrumentKey(symbol);
      return { symbol, instrumentKey };
    } catch {
      return null;
    }
  }));
  const valid = resolved.filter(Boolean);
  instrumentKeyToSymbol = new Map(valid.map((v) => [v.instrumentKey, v.symbol]));
  const instrumentKeys = valid.map((v) => v.instrumentKey);

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
      return;
    }
    const feeds = parsed.feeds || {};
    const out = {};
    for (const [instrumentKey, feed] of Object.entries(feeds)) {
      const symbol = instrumentKeyToSymbol.get(instrumentKey);
      const ltpc = extractLtpc(feed);
      if (!symbol || !ltpc || typeof ltpc.ltp !== 'number') continue;

      const price = ltpc.ltp;
      const prevClose = ltpc.cp;
      const changePct = (typeof prevClose === 'number' && prevClose > 0)
        ? ((price - prevClose) / prevClose) * 100
        : 0;

      const entry = { price, changePct, up: changePct >= 0 };
      out[symbol] = entry;
      lastKnownFeed.set(symbol, entry);
    }
    if (Object.keys(out).length) broadcast({ type: 'tick', feeds: out });
  });

  streamer.on('error', (err) => console.error('[liveFeedService] Upstox stream error:', err?.message || err));
  streamer.on('close', () => console.warn('[liveFeedService] Upstox stream closed.'));
  streamer.on('autoReconnectStopped', () => console.error('[liveFeedService] Gave up reconnecting.'));

  streamer.connect();
}

function stopLiveFeed() {
  if (streamer) {
    try { streamer.disconnect(); } catch {}
    streamer = null;
  }
}

module.exports = { startLiveFeed, stopLiveFeed, registerBrowserClient, DEFAULT_SYMBOLS };

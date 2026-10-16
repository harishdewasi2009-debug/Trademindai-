// utils/quoteUtils.js
// ══════════════════════════════════════════════════════════════════════════
//  Pure helpers for Upstox full-quote (/v2/market-quote/quotes) payloads.
//  Only fields Upstox actually returned are exposed; anything absent stays
//  null — nothing is estimated, derived from a guess, or filled in.
// ══════════════════════════════════════════════════════════════════════════
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v) => (isNum(v) ? v : null);

/** Upstox sometimes echoes the key with the pipe URL-encoded ("NSE_EQ%7C…"). */
const normalizeToken = (t) => (typeof t === 'string' ? t.replace(/%7C/gi, '|') : t);

/** Index the response's data object by the real instrument_key. */
function indexQuotesByToken(dataObj) {
  const map = new Map();
  for (const q of Object.values(dataObj || {})) {
    const tok = normalizeToken(q?.instrument_token || q?.instrument_key);
    if (tok) map.set(tok, q);
  }
  return map;
}

function parseTradeTimeMs(q) {
  // last_trade_time is epoch ms (string or number); `timestamp` is an ISO string for the snapshot.
  const ltt = Number(q?.last_trade_time);
  if (Number.isFinite(ltt) && ltt > 0) return ltt;
  const ts = Date.parse(q?.timestamp);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * @returns {object|null} null when the payload has no usable last_price
 */
function parseQuote(q) {
  if (!q || !isNum(q.last_price)) return null;
  const lastPrice = q.last_price;
  const netChange = numOrNull(q.net_change);
  // After the close Upstox rewrites ohlc.close to TODAY's close, which would
  // flatten the change to 0 — so prefer last_price - net_change (the real
  // previous close) and only fall back to ohlc.close when net_change is absent.
  const prevClose = netChange !== null ? lastPrice - netChange : numOrNull(q.ohlc?.close);
  const change = prevClose !== null ? lastPrice - prevClose : null;
  const changePct = prevClose !== null && prevClose > 0 ? (change / prevClose) * 100 : null;
  const depth = q.depth && (Array.isArray(q.depth.buy) || Array.isArray(q.depth.sell))
    ? { buy: q.depth.buy || [], sell: q.depth.sell || [] } : null;
  return {
    lastPrice,
    previousClose: prevClose,
    change,
    changePct,
    open: numOrNull(q.ohlc?.open),
    high: numOrNull(q.ohlc?.high),
    low: numOrNull(q.ohlc?.low),
    volume: numOrNull(q.volume),
    averagePrice: numOrNull(q.average_price),
    openInterest: numOrNull(q.oi),
    totalBuyQuantity: numOrNull(q.total_buy_quantity),
    totalSellQuantity: numOrNull(q.total_sell_quantity),
    upperCircuit: numOrNull(q.upper_circuit_limit),
    lowerCircuit: numOrNull(q.lower_circuit_limit),
    tradeTimeMs: parseTradeTimeMs(q),
    depth, // real market depth exactly as Upstox sent it, or null — never synthesized
  };
}

module.exports = { parseQuote, indexQuotesByToken, normalizeToken, parseTradeTimeMs };

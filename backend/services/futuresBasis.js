// services/futuresBasis.js
// Futures basis = futures last price − underlying spot last price, both from Upstox quotes.
// Computed only when the master gives an equity/index underlying key AND both quotes exist.
// Annualised basis is a simple (basis% × 365 / days-to-expiry) figure and is labelled as computed.
const { listContracts, getInstrument } = require('./upstoxRegistry');
const { getQuotesBatch } = require('./instrumentData');

const SPOT_SEGMENTS = /^(NSE|BSE)_(EQ|INDEX)$/;

function basisRow(fut, futQuote, spotPrice, todayMs = Date.now()) {
  const days = fut.expiry ? Math.ceil((Date.parse(`${fut.expiry}T15:30:00+05:30`) - todayMs) / 86400e3) : null;
  const price = futQuote && futQuote.lastPrice;
  const base = { instrumentKey: fut.instrumentKey, symbol: fut.symbol, expiry: fut.expiry, lotSize: fut.lotSize, daysToExpiry: days,
    futuresPrice: Number.isFinite(price) ? price : null, openInterest: futQuote ? futQuote.openInterest : null, volume: futQuote ? futQuote.volume : null };
  if (!Number.isFinite(price) || !Number.isFinite(spotPrice) || spotPrice <= 0) return { ...base, basis: null, basisPct: null, annualizedPct: null };
  const basis = price - spotPrice;
  const basisPct = (basis / spotPrice) * 100;
  return { ...base, basis: Number(basis.toFixed(4)), basisPct: Number(basisPct.toFixed(4)),
    annualizedPct: days && days >= 1 ? Number(((basisPct * 365) / days).toFixed(2)) : null };
}

async function getBasis({ underlying, segment }) {
  const futs = (await listContracts({ segment, underlying, type: 'FUT', limit: 12 })).filter((f) => f.instrumentType === 'FUT' || /FUT/.test(f.instrumentType || ''));
  if (!futs.length) return { underlying, available: false, reason: 'No futures contracts for this underlying exist in the Upstox instrument master.', rows: [] };
  const underlyingKey = futs[0].underlyingKey;
  const spotInst = underlyingKey ? await getInstrument(underlyingKey) : null;
  const spotUsable = spotInst && SPOT_SEGMENTS.test(spotInst.segment);
  const keys = futs.map((f) => f.instrumentKey).concat(spotUsable ? [underlyingKey] : []);
  const quotes = await getQuotesBatch(keys);
  const byKey = new Map(quotes.map((q) => [q.instrument.instrumentKey, q]));
  const spotQ = spotUsable ? byKey.get(underlyingKey) : null;
  const spotPrice = spotQ && spotQ.quote ? spotQ.quote.lastPrice : null;
  const rows = futs.map((f) => basisRow(f, (byKey.get(f.instrumentKey) || {}).quote || null, spotPrice));
  return {
    underlying, available: true, source: 'Upstox', computed: true,
    spot: spotUsable ? { instrumentKey: underlyingKey, symbol: spotInst.symbol, price: spotPrice, tradeTime: spotQ ? spotQ.tradeTime : null } : null,
    basisNote: spotUsable
      ? (spotPrice == null ? 'Underlying quote unavailable from Upstox right now — basis not computed.' : 'Basis and annualised basis are computed here from two Upstox quotes; they are not Upstox-published fields.')
      : 'This underlying has no spot instrument in the Upstox master (e.g. commodity/currency futures), so basis is not computed.',
    rows,
  };
}

module.exports = { getBasis, basisRow };

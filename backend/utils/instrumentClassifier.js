// utils/instrumentClassifier.js
// ══════════════════════════════════════════════════════════════════════════
//  Turns one raw row of an Upstox instrument-master file into a normalized
//  registry record. NOTHING here invents an instrument: every field comes
//  from the row itself. The only derived fields are `asset_class` and
//  `currency`, and both are derived by explicit, documented rules below —
//  where a rule cannot decide, the value is 'other' / null rather than a guess.
//
//  Segment names are NOT hardcoded as a whitelist: whatever `segment` Upstox
//  publishes is stored as-is, so a new segment appears automatically.
// ══════════════════════════════════════════════════════════════════════════

// Segment names we *expect* may exist (from the integration brief). Used only
// for reporting: an expected segment with zero rows is flagged
// "UNSUPPORTED BY UPSTOX" instead of being silently omitted.
const EXPECTED_SEGMENTS = [
  'NSE_EQ', 'NSE_INDEX', 'NSE_FO', 'NCD_FO', 'NSE_COM',
  'BSE_EQ', 'BSE_INDEX', 'BSE_FO', 'BCD_FO',
  'MCX_FO', 'MCX_INDEX',
  'GLOBAL_INDEX', 'GLOBAL_INDICATOR',
];

const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));
const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Upstox expiry is epoch-milliseconds (number or numeric string). → ISO date or null. */
function parseExpiry(v) {
  const n = num(v);
  if (n === null || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function exchangeOfSegment(segment) {
  if (!segment) return null;
  if (segment.startsWith('NSE') || segment === 'NCD_FO') return 'NSE';
  if (segment.startsWith('BSE') || segment === 'BCD_FO') return 'BSE';
  if (segment.startsWith('MCX')) return 'MCX';
  if (segment.startsWith('GLOBAL')) return 'GLOBAL';
  return segment.split('_')[0] || null;
}

/**
 * asset_class rules (first match wins):
 *   segment GLOBAL_INDEX / *_INDEX or instrument_type INDEX → index  (global_index for GLOBAL_INDEX)
 *   segment GLOBAL_INDICATOR                                 → global_indicator
 *   segment NCD_FO / BCD_FO                                  → currency_future | currency_option
 *   segment MCX_* / *_COM                                    → commodity_future | commodity_option | commodity
 *   instrument_type CE/PE                                    → option
 *   instrument_type FUT                                      → future
 *   instrument_type ETF / name contains ETF (EQ segments)    → etf
 *   segment *_EQ                                             → equity
 *   otherwise                                                → other
 */
function classifyAssetClass(segment, instrumentType, name) {
  const seg = (segment || '').toUpperCase();
  const type = (instrumentType || '').toUpperCase();
  const isOpt = type === 'CE' || type === 'PE';
  const isFut = type === 'FUT';

  if (seg === 'GLOBAL_INDEX') return 'global_index';
  if (seg === 'GLOBAL_INDICATOR') return 'global_indicator';
  if (seg.endsWith('_INDEX') || type === 'INDEX') return 'index';
  if (seg === 'NCD_FO' || seg === 'BCD_FO') return isOpt ? 'currency_option' : isFut ? 'currency_future' : 'currency';
  if (seg.startsWith('MCX') || seg.endsWith('_COM')) return isOpt ? 'commodity_option' : isFut ? 'commodity_future' : 'commodity';
  if (isOpt) return 'option';
  if (isFut) return 'future';
  if (seg.endsWith('_EQ')) {
    if (type === 'ETF' || /\bETF\b/i.test(name || '')) return 'etf';
    return 'equity';
  }
  return 'other';
}

/** Returns null for rows that cannot be keyed (no instrument_key). */
function normalizeInstrument(row) {
  const instrumentKey = str(row.instrument_key ?? row.instrumentKey);
  if (!instrumentKey) return null;

  const segment = str(row.segment) || (instrumentKey.includes('|') ? instrumentKey.split('|')[0] : null);
  const instrumentType = str(row.instrument_type ?? row.instrumentType);
  const tradingSymbol = str(row.trading_symbol ?? row.tradingsymbol ?? row.tradingSymbol ?? row.symbol);
  const name = str(row.name ?? row.short_name) || tradingSymbol;
  const assetClass = classifyAssetClass(segment, instrumentType, name);
  const exchange = str(row.exchange) || exchangeOfSegment(segment);

  // Currency: only stated when the segment itself implies it. Indian
  // exchange segments settle in INR. Global segments carry no currency in
  // the file, so it stays null instead of being guessed.
  const indian = segment && !segment.startsWith('GLOBAL');
  const currency = str(row.currency) || (indian ? 'INR' : null);

  return {
    instrument_key: instrumentKey,
    symbol: tradingSymbol || name || instrumentKey,
    name,
    asset_class: assetClass,
    exchange,
    segment,
    instrument_type: instrumentType,
    currency,
    expiry: parseExpiry(row.expiry),
    strike_price: num(row.strike_price),
    lot_size: num(row.lot_size ?? row.minimum_lot),
    tick_size: num(row.tick_size),
    isin: str(row.isin),
    underlying_key: str(row.underlying_key),
    underlying_symbol: str(row.underlying_symbol ?? row.asset_symbol),
    exchange_token: str(row.exchange_token),
    provider: 'upstox',
  };
}

module.exports = { EXPECTED_SEGMENTS, normalizeInstrument, classifyAssetClass, parseExpiry, exchangeOfSegment };

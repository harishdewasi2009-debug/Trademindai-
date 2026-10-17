// utils/instrumentKey.js — shared Upstox instrument_key validation.
// Real keys look like "NSE_EQ|INE002A01018", "NSE_FO|12345", "NSE_INDEX|Nifty 50",
// but index/global names can contain other punctuation ( ) / + ' % , etc. The old
// whitelist regex rejected those, so such instruments "had no working key".
// We only require: SEGMENT|something, printable characters, bounded length.
const KEY_RE = /^[A-Za-z0-9_]+\|[^\u0000-\u001f\u007f]+$/;
const MAX_LEN = 120;
const isValidInstrumentKey = (k) => typeof k === 'string' && k.length <= MAX_LEN && KEY_RE.test(k.trim()) && !/^\s|\s$/.test(k) ;
module.exports = { isValidInstrumentKey, KEY_RE, MAX_LEN };

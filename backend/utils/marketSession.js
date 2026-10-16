// utils/marketSession.js
// ══════════════════════════════════════════════════════════════════════════
//  Pure helpers: trading-hours estimate per segment, and data-freshness
//  classification. The official Upstox market-status API is preferred at
//  runtime (see services/instrumentData.js); this file is the fallback and
//  is always labelled `source: 'estimated-schedule'` so the UI never
//  presents an estimate as an official status.
// ══════════════════════════════════════════════════════════════════════════
const { isTradingDay } = require('./tradingCalendar');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Regular-session windows in IST minutes-from-midnight. These are the
// exchanges' published standard hours; special sessions (Muhurat trading,
// MCX evening-session shifts when US DST changes) are NOT modelled — which
// is exactly why the result is flagged as an estimate.
const SESSION_WINDOWS = {
  equityLike: { open: 9 * 60 + 15, close: 15 * 60 + 30, label: '09:15–15:30 IST' },
  currency:   { open: 9 * 60,      close: 17 * 60,      label: '09:00–17:00 IST' },
  commodity:  { open: 9 * 60,      close: 23 * 60 + 30, label: '09:00–23:30 IST' },
};

function sessionKindForSegment(segment) {
  const s = (segment || '').toUpperCase();
  if (s === 'NCD_FO' || s === 'BCD_FO') return 'currency';
  if (s.startsWith('MCX') || s.endsWith('_COM')) return 'commodity';
  if (s.startsWith('GLOBAL')) return null;               // no schedule we can verify
  if (s.startsWith('NSE') || s.startsWith('BSE')) return 'equityLike';
  return null;
}

/**
 * @returns {{status:'open'|'closed'|'unknown', source:string, hours:string|null}}
 */
function estimateMarketStatus(segment, now = new Date()) {
  const kind = sessionKindForSegment(segment);
  if (!kind) return { status: 'unknown', source: 'no-verifiable-schedule', hours: null };
  const w = SESSION_WINDOWS[kind];
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const dow = ist.getUTCDay();
  if (dow === 0 || dow === 6) return { status: 'closed', source: 'estimated-schedule', hours: w.label };
  if (kind === 'equityLike' && !isTradingDay(now)) return { status: 'closed', source: 'estimated-schedule', hours: w.label };
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const open = mins >= w.open && mins < w.close;
  return { status: open ? 'open' : 'closed', source: 'estimated-schedule', hours: w.label };
}

/** Segment → exchange code used by Upstox's /v2/market/status/{exchange}. */
const STATUS_API_EXCHANGE = {
  NSE_EQ: 'NSE', NSE_INDEX: 'NSE', NSE_FO: 'NFO', NCD_FO: 'NCD',
  BSE_EQ: 'BSE', BSE_INDEX: 'BSE', BSE_FO: 'BFO', BCD_FO: 'BCD',
  MCX_FO: 'MCX', MCX_INDEX: 'MCX',
};

/** Interprets the status string Upstox returns (e.g. NORMAL_OPEN / NORMAL_CLOSE). Unknown → null. */
function interpretStatusString(s) {
  const v = String(s || '').toUpperCase();
  if (!v) return null;
  if (v.includes('CLOSE')) return 'closed';
  if (v.includes('OPEN') && !v.includes('PRE')) return 'open';
  if (v.includes('PRE')) return 'closed'; // pre-open auction: no continuous trading yet
  return null;
}

// Per-asset-class "how old can the last trade be while the market is open
// before we call the data stale". Liquid cash/index/futures tick constantly;
// far-strike options, currency and global indicators can legitimately go
// minutes between trades, so they get a wider window rather than false alarms.
function staleThresholdSeconds(segment, assetClass) {
  if (assetClass === 'option' || assetClass === 'commodity_option' || assetClass === 'currency_option') return 900;
  if (assetClass === 'global_indicator') return 3600;
  if ((segment || '').startsWith('GLOBAL')) return 900;
  if (assetClass === 'index') return 120;
  return 300;
}

/**
 * Labels how trustworthy a quote's timing is.
 *  - 'real-time'  market open and last trade is recent
 *  - 'delayed'    market open but last trade older than the threshold (stale)
 *  - 'last-close' market closed → this is the last valid quote, shown with its own timestamp
 *  - 'unknown'    no timestamp or market status to judge by
 */
function classifyFreshness({ marketStatus, tradeTimeMs, nowMs = Date.now(), segment, assetClass }) {
  const hasTs = Number.isFinite(tradeTimeMs) && tradeTimeMs > 0;
  const ageSeconds = hasTs ? Math.max(0, Math.round((nowMs - tradeTimeMs) / 1000)) : null;
  const threshold = staleThresholdSeconds(segment, assetClass);
  let mode;
  if (marketStatus === 'closed') mode = hasTs ? 'last-close' : 'unknown';
  else if (marketStatus === 'open') mode = hasTs ? (ageSeconds <= threshold ? 'real-time' : 'delayed') : 'unknown';
  else mode = hasTs ? (ageSeconds <= threshold ? 'real-time' : 'last-close') : 'unknown';
  return { mode, ageSeconds, staleAfterSeconds: threshold, stale: mode === 'delayed' };
}

module.exports = {
  SESSION_WINDOWS, sessionKindForSegment, estimateMarketStatus, STATUS_API_EXCHANGE,
  interpretStatusString, staleThresholdSeconds, classifyFreshness,
};

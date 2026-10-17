// controllers/registryController.js — Verified Upstox market registry API.
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const { query } = require('../db/pool');
const registry = require('../services/upstoxRegistry');
const probe = require('../services/upstoxProbe');
const data = require('../services/instrumentData');
const { upstoxGet, recentErrors } = require('../services/upstoxHttp');
const { buildAuditMarkdown } = require('../utils/auditReport');
const { COMPUTABLE_INDICATORS } = require('../utils/seriesIndicators');
const liveFeedService = require('../services/liveFeedService');
const tracker = require('../services/analysisTracker');
const futuresBasis = require('../services/futuresBasis');
const { getPlan } = require('../config/plans');

const { isValidInstrumentKey } = require('../utils/instrumentKey');
function keyParam(v) {
  const key = String(v || '').trim();
  if (!key || !isValidInstrumentKey(key)) throw new AppError('A valid Upstox instrument key is required (e.g. NSE_EQ|INE002A01018).', 400);
  return key;
}
// Keys are "SEGMENT|id"; only a comma followed by a new "SEGMENT|" starts the next key, so a key that itself
// contains a comma (some index/indicator names do) is no longer cut in half.
const splitKeys = (v) => String(v || '').split(/,(?=[A-Za-z0-9_]+\|)/).map((x) => x.trim()).filter(Boolean);
const SEG_RE = /^[A-Z_]{2,30}$/;
const segParam = (v) => (v ? (SEG_RE.test(String(v)) ? String(v) : (() => { throw new AppError('Invalid segment.', 400); })()) : undefined);

const getSegments = asyncHandler(async (req, res) => {
  const segments = await registry.listSegments();
  res.set('Cache-Control', 'private, max-age=30');
  res.json({ segments, registryState: registry.getRefreshState() });
});

const searchInstruments = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').slice(0, 40);
  // free-text search: any printable text is safe (it is bound as a parameter and LIKE-escaped)
  const items = await registry.searchInstruments({
    q, segment: segParam(req.query.segment),
    assetClass: req.query.assetClass ? String(req.query.assetClass).replace(/[^a-z_]/g, '') : undefined,
    limit: req.query.limit, offset: req.query.offset, includeContracts: req.query.contracts === '1',
  });
  res.json({ items, count: items.length });
});

const getUnderlyings = asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').slice(0, 30).replace(/[^A-Za-z0-9&_.\- ]/g, '');
  res.json({ items: await registry.listUnderlyings({ segment: segParam(req.query.segment), q, limit: req.query.limit }) });
});

const getContracts = asyncHandler(async (req, res) => {
  const underlying = String(req.query.underlying || '').replace(/[^A-Za-z0-9&_.\- ]/g, '').slice(0, 40);
  if (!underlying) throw new AppError('underlying is required.', 400);
  const expiry = /^\d{4}-\d{2}-\d{2}$/.test(req.query.expiry || '') ? req.query.expiry : undefined;
  const type = ['CE', 'PE', 'FUT'].includes(String(req.query.type || '').toUpperCase()) ? String(req.query.type).toUpperCase() : undefined;
  res.json({ items: await registry.listContracts({ segment: segParam(req.query.segment), underlying, expiry, type, limit: req.query.limit }) });
});

const getInstrument = asyncHandler(async (req, res) => {
  const inst = await registry.getInstrument(keyParam(req.query.key));
  if (!inst) throw new AppError('Instrument is not in the verified Upstox registry.', 404);
  res.json({ instrument: inst });
});

const getQuote = asyncHandler(async (req, res) => {
  res.json(await data.getQuote(keyParam(req.query.key)));
});

const getQuotes = asyncHandler(async (req, res) => {
  const keys = splitKeys(req.query.keys);
  if (!keys.length || keys.length > 50) throw new AppError('Provide 1–50 instrument keys.', 400);
  keys.forEach(keyParam);
  res.json({ quotes: await data.getQuotesBatch(keys), source: 'Upstox', fetchedAt: new Date().toISOString() });
});

const getCandles = asyncHandler(async (req, res) => {
  const unit = String(req.query.unit || 'days');
  const interval = parseInt(req.query.interval || '1', 10);
  const dateOk = (s) => (s === undefined || /^\d{4}-\d{2}-\d{2}$/.test(s));
  if (!dateOk(req.query.from) || !dateOk(req.query.to)) throw new AppError('from/to must be YYYY-MM-DD.', 400);
  const requested = req.query.indicators
    ? String(req.query.indicators).split(',').map((s) => s.trim()).filter((s) => COMPUTABLE_INDICATORS.includes(s))
    : undefined;
  res.json(await data.getCandles(keyParam(req.query.key), {
    unit, interval, from: req.query.from, to: req.query.to,
    indicators: req.query.indicators !== 'none', requested,
  }));
});

const getAnalysisContext = asyncHandler(async (req, res) => {
  const unit = String(req.query.unit || 'days');
  const interval = parseInt(req.query.interval || '1', 10);
  const context = await data.getAnalysisContext(keyParam(req.query.key), { unit, interval });
  // Record the read for outcome tracking (frozen criteria; evaluated later against real candles).
  let tracking = { recorded: false, reason: 'not attempted' };
  try {
    const inst = await registry.getInstrument(context.instrument.key);
    tracking = await tracker.recordAnalysis({ instrument: inst, unit, interval, technical: context.technical, lastCandleTs: context.lastCandleTs });
  } catch (e) { tracking = { recorded: false, reason: 'tracking unavailable: ' + e.message }; }
  res.json({ context, tracking });
});

const getBasis = asyncHandler(async (req, res) => {
  const underlying = String(req.query.underlying || '').replace(/[^A-Za-z0-9&_.\- ]/g, '').slice(0, 40);
  if (!underlying) throw new AppError('underlying is required.', 400);
  res.json(await futuresBasis.getBasis({ underlying, segment: segParam(req.query.segment) }));
});

const getAccuracy = asyncHandler(async (req, res) => {
  res.json(await tracker.getStats({ segment: segParam(req.query.segment) }));
});
const adminEvaluate = asyncHandler(async (req, res) => {
  res.json(await tracker.evaluateDue((k, o) => data.getCandles(k, o)));
});

// Option chain / Greeks — Elite feature, same gate as the existing options page.
const getOptionChain = asyncHandler(async (req, res) => {
  const key = keyParam(req.query.key);
  const expiry = String(req.query.expiry || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) throw new AppError('expiry (YYYY-MM-DD) is required.', 400);
  const r = await upstoxGet('/v2/option/chain', { instrument_key: key, expiry_date: expiry });
  if (!r.ok) throw new AppError(`Upstox option chain unavailable: ${r.error}`, r.status === 401 || r.status === 403 ? 403 : 502);
  res.json({ underlying: key, expiry, chain: r.data?.data || [], source: 'Upstox', fetchedAt: new Date().toISOString() });
});

const getOptionGreeks = asyncHandler(async (req, res) => {
  const keys = splitKeys(req.query.keys);
  if (!keys.length || keys.length > 50) throw new AppError('Provide 1–50 option instrument keys.', 400);
  keys.forEach(keyParam);
  const r = await upstoxGet('/v3/market-quote/option-greek', { instrument_key: keys.join(',') });
  if (!r.ok) throw new AppError(`Upstox option Greeks unavailable: ${r.error}`, r.status === 401 || r.status === 403 ? 403 : 502);
  res.json({ greeks: r.data?.data || {}, source: 'Upstox', fetchedAt: new Date().toISOString() });
});

// ── instrument-key watchlist ────────────────────────────────────────────
const WATCHLIST_LIMITS = { free: 5, basic: 50, pro: 50, elite: Infinity };
const getWatchlist = asyncHandler(async (req, res) => {
  await registry.ensureSchema();
  const { rows } = await query('SELECT id, instrument_key, symbol, name, segment, created_at FROM market_watchlist WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json({ items: rows, limit: WATCHLIST_LIMITS[req.user.plan] ?? 5 });
});
const addWatch = asyncHandler(async (req, res) => {
  const key = keyParam(req.body?.instrumentKey);
  const inst = await registry.getInstrument(key);
  if (!inst) throw new AppError('Instrument is not in the verified Upstox registry.', 404);
  const limit = WATCHLIST_LIMITS[req.user.plan] ?? 5;
  const { rows: [{ count }] } = await query('SELECT COUNT(*)::int AS count FROM market_watchlist WHERE user_id = $1', [req.user.id]);
  if (count >= limit) throw new AppError(`Your ${getPlan(req.user.plan).name} plan allows up to ${limit} watchlist instruments. Upgrade for more.`, 403);
  const { rows } = await query(
    `INSERT INTO market_watchlist (user_id, instrument_key, symbol, name, segment) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, instrument_key) DO UPDATE SET name = EXCLUDED.name RETURNING id, instrument_key, symbol, name, segment, created_at`,
    [req.user.id, key, inst.symbol, inst.displayName, inst.segment]);
  res.status(201).json({ item: rows[0] });
});
const removeWatch = asyncHandler(async (req, res) => {
  const { rowCount } = await query('DELETE FROM market_watchlist WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rowCount) throw new AppError('Watchlist item not found.', 404);
  res.json({ message: 'Removed from watchlist.' });
});

// ── admin ───────────────────────────────────────────────────────────────
const adminRefresh = asyncHandler(async (req, res) => {
  const p = registry.refreshRegistry({ force: true });
  if (req.query.wait === '1') return res.json(await p);
  p.catch(() => {}); // failure is recorded in refresh state + error log
  res.status(202).json({ message: 'Registry refresh started.', state: registry.getRefreshState() });
});
const adminProbe = asyncHandler(async (req, res) => {
  const only = req.query.segment ? [segParam(req.query.segment)] : undefined;
  const p = probe.probeAll({ only });
  p.catch(() => {});
  res.status(202).json({ message: 'Capability probe started (takes a few minutes).', state: probe.getLastProbeRun() });
});
const adminStatus = asyncHandler(async (req, res) => {
  res.json({
    registry: registry.getRefreshState(), registryRows: await registry.registryCount(),
    probe: probe.getLastProbeRun(), liveFeed: liveFeedService.getFeedState(), recentErrors: recentErrors().slice(0, 50),
  });
});
const adminAudit = asyncHandler(async (req, res) => {
  const segments = await registry.listSegments();
  const keys = [...new Set(segments.flatMap((s) => s.sampleKeys))];
  const symbolsByKey = {};
  if (keys.length) {
    const { rows } = await query('SELECT instrument_key, symbol FROM market_registry WHERE instrument_key = ANY($1)', [keys]);
    rows.forEach((r) => { symbolsByKey[r.instrument_key] = r.symbol; });
  }
  const md = buildAuditMarkdown(segments, symbolsByKey, { masterSource: registry.getRefreshState().source });
  if (req.query.format === 'json') return res.json({ segments });
  res.type('text/markdown').send(md);
});

module.exports = {
  getSegments, searchInstruments, getUnderlyings, getContracts, getInstrument, getQuote, getQuotes, getCandles,
  getAnalysisContext, getBasis, getAccuracy, adminEvaluate, getOptionChain, getOptionGreeks, getWatchlist, addWatch, removeWatch,
  adminRefresh, adminProbe, adminStatus, adminAudit,
};

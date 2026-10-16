// services/upstoxHttp.js
// ══════════════════════════════════════════════════════════════════════════
//  The ONE gateway for the registry-era Upstox REST calls. It adds, in a
//  single place, what the official API rules require:
//   • the backend-held Bearer token (credentials never leave the server)
//   • rate limiting under Upstox's published standard-API ceilings
//     (50 req/s, 500 req/min, 2000 req/30 min) — we stay well below them
//   • automatic Retry-After-aware backoff on HTTP 429
//   • a bounded in-memory error log (admin-visible) + structured console logs
//   • a uniform result shape: { ok, status, data, error }
// ══════════════════════════════════════════════════════════════════════════
const { getValidAccessToken } = require('./marketDataService');

const BASE = 'https://api.upstox.com';

// Conservative budget (override via env if Upstox changes limits).
const LIMITS = [
  { windowMs: 1_000,     max: parseInt(process.env.UPSTOX_RPS_LIMIT, 10)   || 20 },
  { windowMs: 60_000,    max: parseInt(process.env.UPSTOX_RPM_LIMIT, 10)   || 300 },
  { windowMs: 1_800_000, max: parseInt(process.env.UPSTOX_R30M_LIMIT, 10) || 1500 },
];
const stamps = []; // timestamps (ms) of recent outbound calls, oldest first

/** Resolves when a request slot is available under every window. */
async function acquireSlot() {
  for (;;) {
    const now = Date.now();
    const horizon = now - LIMITS[LIMITS.length - 1].windowMs;
    while (stamps.length && stamps[0] < horizon) stamps.shift();

    let waitMs = 0;
    for (const { windowMs, max } of LIMITS) {
      const inWindow = stamps.filter((t) => t > now - windowMs);
      if (inWindow.length >= max) waitMs = Math.max(waitMs, inWindow[inWindow.length - max] + windowMs - now);
    }
    if (waitMs <= 0) { stamps.push(now); return; }
    // Never queue a user request behind a multi-minute window — fail fast instead.
    if (waitMs > 8_000) {
      const err = new Error('Upstox request budget exhausted; try again shortly.');
      err.code = 'LOCAL_RATE_LIMIT';
      throw err;
    }
    await new Promise((r) => setTimeout(r, waitMs + 5));
  }
}

const errorLog = []; // ring buffer
const MAX_ERRORS = 200;
function logError(entry) {
  const rec = { at: new Date().toISOString(), ...entry };
  errorLog.push(rec);
  if (errorLog.length > MAX_ERRORS) errorLog.shift();
  console.warn('[upstox]', JSON.stringify(rec));
}
const recentErrors = () => errorLog.slice().reverse();

/**
 * GET an Upstox endpoint. `path` starts with /v2 or /v3. `params` is a plain object.
 * Never throws for HTTP-level failures — returns { ok:false, status, error }.
 */
async function upstoxGet(path, params = {}, { timeoutMs = 15_000, retries = 2 } = {}) {
  let token;
  try { token = await getValidAccessToken(); }
  catch (e) { return { ok: false, status: e.statusCode || 503, data: null, error: e.message, kind: 'no_token' }; }

  const qs = new URLSearchParams(params).toString();
  const url = `${BASE}${path}${qs ? `?${qs}` : ''}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try { await acquireSlot(); }
    catch (e) { return { ok: false, status: 429, data: null, error: e.message, kind: 'rate_limited' }; }

    let res;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (attempt === retries) {
        logError({ path, kind: 'network', message: e.message });
        return { ok: false, status: 0, data: null, error: e.name === 'TimeoutError' ? 'Upstox request timed out.' : e.message, kind: 'error' };
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }

    if (res.status === 429) {
      if (attempt === retries) {
        logError({ path, kind: 'rate_limited', status: 429 });
        return { ok: false, status: 429, data: null, error: 'Upstox rate limit hit.', kind: 'rate_limited' };
      }
      const ra = parseInt(res.headers.get('retry-after'), 10);
      await new Promise((r) => setTimeout(r, Number.isFinite(ra) ? ra * 1000 : 500 * (attempt + 1) ** 2));
      continue;
    }

    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const message = body?.errors?.[0]?.message || body?.message || res.statusText || 'Upstox error';
      const kind = res.status === 401 || res.status === 403 ? 'denied' : res.status >= 500 ? 'error' : 'unsupported';
      if (res.status >= 500 || res.status === 401 || res.status === 403) logError({ path, kind, status: res.status, message });
      return { ok: false, status: res.status, data: body, error: String(message).slice(0, 300), kind };
    }
    return { ok: true, status: res.status, data: body, error: null, kind: 'ok' };
  }
  return { ok: false, status: 0, data: null, error: 'unreachable', kind: 'error' };
}

module.exports = { upstoxGet, recentErrors, logError, BASE };

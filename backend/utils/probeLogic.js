// utils/probeLogic.js
// ══════════════════════════════════════════════════════════════════════════
//  Pure decision logic for the live capability probes: how an HTTP outcome
//  becomes a capability status, and how capability statuses roll up into one
//  segment access_status. Kept pure so the rules are unit-tested.
// ══════════════════════════════════════════════════════════════════════════

/**
 * @param res   { ok, kind, status } from upstoxGet()
 * @param hasData  whether a 200 response actually carried usable data
 * @param marketOpen  400s while the market is closed usually mean "no data yet", not "unsupported"
 */
function classifyOutcome(res, hasData, marketOpen = true) {
  if (!res) return 'error';
  if (res.ok) return hasData ? 'verified' : 'empty';
  // 401 = our token is invalid/expired (not a segment entitlement problem) → inconclusive.
  if (res.status === 401) return 'error';
  if (res.kind === 'denied') return 'denied';
  if (res.kind === 'rate_limited') return 'rate_limited';
  if (res.kind === 'no_token') return 'error';
  if (res.kind === 'unsupported') return (res.status === 400 && !marketOpen) ? 'empty' : 'unsupported';
  return 'error';
}

/**
 * Roll the data-bearing capability statuses up into one human-readable status.
 *   VERIFIED            quote or candles proven with real data
 *   ACCESS DENIED       every tested capability returned 401/403
 *   UNSUPPORTED BY UPSTOX  every tested capability was rejected as unsupported
 *   NO DATA RETURNED    API accepted the calls but returned nothing (market closed / no entitlement)
 *   PROBE INCONCLUSIVE  errors / rate limits — try again
 */
function deriveAccessStatus(statuses) {
  const s = statuses.filter((x) => x && x !== 'untested' && x !== 'n/a');
  if (!s.length) return 'UNVERIFIED';
  if (s.includes('verified')) return 'VERIFIED';
  if (s.every((x) => x === 'denied')) return 'ACCESS DENIED';
  if (s.every((x) => x === 'unsupported' || x === 'denied')) return 'UNSUPPORTED BY UPSTOX';
  if (s.every((x) => x === 'empty' || x === 'unsupported' || x === 'denied')) return 'NO DATA RETURNED';
  return 'PROBE INCONCLUSIVE';
}

module.exports = { classifyOutcome, deriveAccessStatus };

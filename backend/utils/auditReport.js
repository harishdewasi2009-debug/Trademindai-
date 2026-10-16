// utils/auditReport.js — builds the "verified Upstox market segments" table from LIVE probe results.
// Pure: takes segment rows (see upstoxRegistry.listSegments) + a map of sample keys → symbols.
const cell = (s) => String(s ?? '—').replace(/\|/g, '/').replace(/\n/g, ' ');
const sym = (status) => ({
  verified: '✅ verified', empty: '⚠️ no data returned', denied: '⛔ access denied', unsupported: '❌ unsupported',
  rate_limited: '⏳ rate limited', error: '❓ error', untested: '— not probed', 'n/a': '— n/a',
}[status] || cell(status));

function buildAuditMarkdown(segments, symbolsByKey = {}, meta = {}) {
  const lines = [];
  lines.push('# Upstox market-segment audit');
  lines.push('');
  lines.push(`Generated: ${meta.generatedAt || new Date().toISOString()}`);
  if (meta.masterSource) lines.push(`Instrument master source: ${meta.masterSource}`);
  lines.push('');
  lines.push('Every cell below comes from the live instrument master and live authorized Upstox API probes. "not probed" means no probe has run yet; it does NOT mean supported or unsupported.');
  lines.push('');
  lines.push('| Segment | Instruments | Example instruments | Quotes | OHLC | Historical candles (verified intervals) | Intraday | Option chain | Greeks | Streaming | Freshness | Access status |');
  lines.push('|---|---:|---|---|---|---|---|---|---|---|---|---|');
  for (const s of segments) {
    const examples = (s.sampleKeys || []).slice(0, 3).map((k) => symbolsByKey[k] || k).join(', ') || '—';
    const c = s.capabilities;
    const freshness = s.lastTickAt ? `last stream tick ${s.lastTickAt}` : 'no stream tick recorded';
    lines.push(`| ${cell(s.segment)} | ${s.instrumentCount} | ${cell(examples)} | ${sym(c.quote)} | ${sym(c.ohlc)} | ${sym(c.historicalCandles)}${s.verifiedIntervals.length ? ` (${s.verifiedIntervals.join(', ')})` : ''} | ${sym(c.intradayCandles)} | ${sym(c.optionChain)} | ${sym(c.greeks)} | ${sym(c.streaming)} | ${cell(freshness)} | **${cell(s.accessStatus)}** |`);
  }
  lines.push('');
  lines.push('## Required permissions');
  lines.push('');
  lines.push('- A registered Upstox API app (API key + secret) and a valid access token, refreshed daily (tokens expire ~03:30 IST). The token is held only on the backend.');
  lines.push('- Per-segment entitlements are not assumed: a segment showing **ACCESS DENIED** returned HTTP 401/403 for the connected account; **UNSUPPORTED BY UPSTOX** means Upstox rejected the instruments or lists none in its master.');
  lines.push('- Market streaming is limited by Upstox WebSocket subscription caps; the backend enforces `UPSTOX_WS_MAX_SUBSCRIPTIONS`.');
  const unsupported = segments.filter((s) => s.accessStatus === 'UNSUPPORTED BY UPSTOX');
  if (unsupported.length) {
    lines.push('');
    lines.push('## Marked UNSUPPORTED BY UPSTOX (no other provider is used)');
    lines.push('');
    for (const s of unsupported) lines.push(`- ${s.segment}${s.notes ? ` — ${s.notes}` : ''}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { buildAuditMarkdown };

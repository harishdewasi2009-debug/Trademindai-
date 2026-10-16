#!/usr/bin/env node
// scripts/upstoxAudit.js — `npm run audit:upstox`
// Refreshes the registry from Upstox's official instrument master, runs the
// live capability probes (needs a valid stored Upstox token), then writes the
// verified segment table to docs/UPSTOX_MARKET_AUDIT.md.
require('dotenv').config();
const fs = require('fs');
const path = require('path');

(async () => {
  const registry = require('../services/upstoxRegistry');
  const probe = require('../services/upstoxProbe');
  const { query } = require('../db/pool');
  const { buildAuditMarkdown } = require('../utils/auditReport');

  console.log('1/3 Refreshing registry from the Upstox instrument master…');
  await registry.refreshRegistry({ force: true });
  console.log('2/3 Probing every segment with live authorized API calls (takes a few minutes)…');
  await probe.probeAll();
  console.log('3/3 Writing report…');
  const segments = await registry.listSegments();
  const keys = [...new Set(segments.flatMap((s) => s.sampleKeys))];
  const symbolsByKey = {};
  if (keys.length) {
    const { rows } = await query('SELECT instrument_key, symbol FROM market_registry WHERE instrument_key = ANY($1)', [keys]);
    rows.forEach((r) => { symbolsByKey[r.instrument_key] = r.symbol; });
  }
  const md = buildAuditMarkdown(segments, symbolsByKey, { masterSource: registry.getRefreshState().source });
  const out = path.join(__dirname, '../docs/UPSTOX_MARKET_AUDIT.md');
  fs.writeFileSync(out, md);
  console.log(md);
  console.log(`Saved → ${out}`);
  process.exit(0);
})().catch((e) => { console.error('Audit failed:', e.message); process.exit(1); });

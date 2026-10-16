# Upstox market-segment audit

**Status: NOT YET GENERATED against live Upstox.**
This sandbox has no network access and no Upstox token, so no segment could be verified here. Nothing below is claimed as supported until your server proves it.

## Generate the real table (one command, on a machine with your credentials)

```
cd backend && npm run migrate && npm run audit:upstox
```
(or, while the server runs: `POST /api/market/registry/admin/refresh`, then `POST /api/market/registry/admin/probe`, then `GET /api/market/registry/admin/audit`.)

This downloads Upstox's official instrument master, makes live authorized calls per segment (quotes, OHLC, every candle interval, intraday, option chain, Greeks), and overwrites this file with the verified table: segment, instrument count, example instruments, quote/historical/streaming status, freshness, access status and permissions. Streaming is proven by a real tick arriving for that segment.

## Segments the registry looks for (discovered from the file, not assumed)

NSE_EQ, NSE_INDEX, NSE_FO, NCD_FO, NSE_COM, BSE_EQ, BSE_INDEX, BSE_FO, BCD_FO, MCX_FO, MCX_INDEX, GLOBAL_INDEX, GLOBAL_INDICATOR.
Any other segment present in the master is also ingested automatically. An expected segment with zero rows is recorded as **UNSUPPORTED BY UPSTOX** and shown that way in the UI — no other provider is substituted.

## Status vocabulary

verified · no data returned (200, empty) · access denied (401/403) · unsupported (400/404) · rate limited · error · not probed.

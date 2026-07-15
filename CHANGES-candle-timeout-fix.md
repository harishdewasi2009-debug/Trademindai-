# Fix: RELIANCE (and other symbol) candle requests stuck "pending" / cancelled at 20s

## Root cause
`GET /api/market/candles/:symbol` on the backend makes **two Upstox calls
sequentially** — the historical-candle request, then (inside
`getIntradayCandles`) a second call for today's candles. Each has its own
15s timeout, and `fetchUpstoxWithRetry` can retry up to 2 more times on a
429. Worst case this comfortably exceeds a minute, while the frontend's
`apiFetch` only waits 20s (`API_TIMEOUT_MS`) before aborting. Result: the
backend is still working, but the frontend gives up first, shown in
DevTools as the request going from `(pending)` to `(cancelled)` at 20.00s.

Two changes fix this together — apply both.

---

## 1. Backend — run the two Upstox calls in parallel

**File:** `trademind/backend/services/marketDataService.js`
**Function:** `getHistoricalCandles`

### Change 1a — start the intraday call immediately (around line 848)

**Before:**
```js
  const url = `${BASE_V3}/historical-candle/${encodedKey}/${unit}/${interval}/${toDate}/${fromDate}`;

  const res = await fetchUpstoxWithRetry(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
```

**After:**
```js
  const url = `${BASE_V3}/historical-candle/${encodedKey}/${unit}/${interval}/${toDate}/${fromDate}`;

  // FIX (candle fetches getting cancelled client-side at 20s): this used to
  // await the historical call, THEN await the intraday call, adding their
  // latencies together — each can take up to 15s alone, or longer with 429
  // retries. Kicking off intraday here (in parallel with the historical
  // fetch below) instead of after it roughly halves worst-case latency, so
  // it actually fits inside the frontend's 20s fetch timeout.
  const intradayPromise = ['weeks', 'months'].includes(unit)
    ? Promise.resolve([])
    : getIntradayCandles(instrumentKey, unit, interval);

  const res = await fetchUpstoxWithRetry(url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
```

### Change 1b — await the promise instead of calling it fresh (around line 883)

**Before:**
```js
  const intraday = ['weeks', 'months'].includes(unit) ? [] : await getIntradayCandles(instrumentKey, unit, interval);
  const merged = [...candles.filter((c) => typeof c.t === 'string' && !c.t.startsWith(todayStr)), ...intraday];
```

**After:**
```js
  const intraday = await intradayPromise;
  const merged = [...candles.filter((c) => typeof c.t === 'string' && !c.t.startsWith(todayStr)), ...intraday];
```

---

## 2. Frontend — give candle requests more headroom than quote requests

**File:** `trademind/frontend/index.html`
**Function:** `fetchRealCandles` (around line 6402)

**Before:**
```js
    const res=await apiFetch(url);
```

**After:**
```js
    const res=await apiFetch(url,{signal:AbortSignal.timeout(35000)});
```

`apiFetch` already respects a caller-supplied `signal`
(`signal=opts.signal||AbortSignal.timeout(API_TIMEOUT_MS)`), so this just
raises the timeout to 35s for candle requests specifically, without
touching the default 20s used everywhere else (quotes, auth, etc.).

---

## Also applied earlier in this session (already in your zip / done separately)

**File:** `trademind/frontend/index.html`, function `fetchYahooChart` (~line 2608)
Added a timeout to the raw `fetch()` used for the Yahoo/CORS-proxy index
chart calls (NIFTY/SENSEX/BANK NIFTY), which previously had no timeout at
all and could hang forever if a proxy stalled.

**Before:**
```js
      const res=await fetch(proxy(target),{cache:'no-store'});
```

**After:**
```js
      const res=await fetch(proxy(target),{cache:'no-store',signal:AbortSignal.timeout(API_TIMEOUT_MS)});
```

---

## How to apply
1. Open each file in GitHub's web editor (pencil icon).
2. Ctrl+F / Cmd+F for the function name to jump to the right spot.
3. Make the before → after edit exactly as shown.
4. Commit `marketDataService.js` and `index.html` together — the frontend
   timeout bump alone won't help without the backend parallelization, and
   vice versa.

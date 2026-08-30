// utils/optionsEngine.js
// ══════════════════════════════════════════════════════════════════════════
//  Options analytics computed from the REAL Upstox option chain
//  (marketDataService.getOptionChain — spot price, strikes, and each
//  strike's actual market IV). Greeks are derived via the standard
//  Black-Scholes formula from that real IV — never invented or backfilled.
//  COMPLIANCE: Greeks/expected-move are descriptions of what the CURRENT
//  option prices imply, not predictions of where the stock will go.
// ══════════════════════════════════════════════════════════════════════════

function erf(x) {
  // Abramowitz-Stegun approximation (max error ~1.5e-7) — good enough for
  // Greeks, avoids pulling in a stats library for one function.
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

/**
 * Black-Scholes Greeks for a European option (index/stock options in India
 * are cash-settled European-style — appropriate here).
 * @param {number} S spot price   @param {number} K strike
 * @param {number} T time to expiry in YEARS   @param {number} r risk-free rate (decimal, e.g. 0.065)
 * @param {number} sigma implied volatility (decimal, e.g. 0.22 for 22%)
 * @param {'call'|'put'} type
 */
function blackScholesGreeks(S, K, T, r, sigma, type = 'call') {
  if (!S || !K || T <= 0 || !sigma || sigma <= 0) return null;
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const isCall = type === 'call';

  const delta = isCall ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = normPdf(d1) / (S * sigma * Math.sqrt(T));
  const vega = (S * normPdf(d1) * Math.sqrt(T)) / 100; // per 1% IV move
  const theta = isCall
    ? (-(S * normPdf(d1) * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normCdf(d2)) / 365
    : (-(S * normPdf(d1) * sigma) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * normCdf(-d2)) / 365;
  const rho = isCall
    ? (K * T * Math.exp(-r * T) * normCdf(d2)) / 100
    : (-K * T * Math.exp(-r * T) * normCdf(-d2)) / 100;
  const theoreticalPrice = isCall
    ? S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2)
    : K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);

  return {
    delta: Number(delta.toFixed(4)),
    gamma: Number(gamma.toFixed(5)),
    theta: Number(theta.toFixed(2)),  // per calendar day, in price terms
    vega: Number(vega.toFixed(2)),    // per 1% change in IV
    rho: Number(rho.toFixed(3)),
    theoreticalPrice: Number(theoreticalPrice.toFixed(2)),
  };
}

function yearsToExpiry(expiryDateStr) {
  const expiry = new Date(`${expiryDateStr}T15:30:00+05:30`); // NSE close
  const days = Math.max(0.0001, (expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return { years: days / 365, days: Number(days.toFixed(1)) };
}

/** Annotates every strike in a real Upstox option chain with computed
 *  Greeks, using that strike's OWN real market IV (call & put IV usually
 *  differ slightly, so each side is priced off its own IV). */
function computeChainGreeks(chain, spotPrice, expiryDate, riskFreeRate = 0.065) {
  if (!Array.isArray(chain) || !chain.length) return [];
  const { years } = yearsToExpiry(expiryDate);
  return chain.map((row) => {
    const callIV = row.call_options?.option_greeks?.iv ?? row.call_options?.iv ?? null;
    const putIV = row.put_options?.option_greeks?.iv ?? row.put_options?.iv ?? null;
    const strike = row.strike_price;
    return {
      strike,
      call: callIV ? { iv: callIV, ...blackScholesGreeks(spotPrice, strike, years, riskFreeRate, callIV / 100, 'call') } : null,
      put: putIV ? { iv: putIV, ...blackScholesGreeks(spotPrice, strike, years, riskFreeRate, putIV / 100, 'put') } : null,
    };
  });
}

/** Put-Call Ratio by open interest — a classic sentiment gauge. Values
 *  well above 1 are traditionally read as bearish-leaning (more put OI),
 *  well below 1 as bullish-leaning — reported as a descriptive reading,
 *  not a signal. */
function computePCR(chain) {
  if (!Array.isArray(chain) || !chain.length) return null;
  let callOI = 0, putOI = 0;
  for (const row of chain) {
    callOI += row.call_options?.market_data?.oi ?? row.call_options?.oi ?? 0;
    putOI += row.put_options?.market_data?.oi ?? row.put_options?.oi ?? 0;
  }
  const pcr = callOI ? Number((putOI / callOI).toFixed(2)) : null;
  return {
    pcr, callOI, putOI,
    reading: pcr == null ? 'Unavailable' : pcr >= 1.3 ? 'Elevated put OI (traditionally read bearish-leaning)' : pcr <= 0.7 ? 'Elevated call OI (traditionally read bullish-leaning)' : 'Balanced',
  };
}

/** Max Pain — the strike at which total option-writer payout (across both
 *  calls and puts) would be smallest at expiry, given CURRENT open
 *  interest. A commonly watched (though not guaranteed) expiry-pin level. */
function computeMaxPain(chain) {
  if (!Array.isArray(chain) || !chain.length) return null;
  const strikes = chain.map((r) => r.strike_price);
  let bestStrike = null, bestPain = Infinity;
  for (const settle of strikes) {
    let pain = 0;
    for (const row of chain) {
      const callOI = row.call_options?.market_data?.oi ?? row.call_options?.oi ?? 0;
      const putOI = row.put_options?.market_data?.oi ?? row.put_options?.oi ?? 0;
      if (settle > row.strike_price) pain += (settle - row.strike_price) * callOI;
      if (settle < row.strike_price) pain += (row.strike_price - settle) * putOI;
    }
    if (pain < bestPain) { bestPain = pain; bestStrike = settle; }
  }
  return { maxPainStrike: bestStrike, note: 'Strike where aggregate option-writer payout is currently lowest — a commonly watched expiry-pin reference, not a guarantee price settles there.' };
}

/** Expected move implied by ATM IV over the days remaining to expiry —
 *  a 1-standard-deviation price range, not a target/prediction. */
function computeExpectedMove(spotPrice, atmIVPct, expiryDate) {
  const { years, days } = yearsToExpiry(expiryDate);
  const sigma = atmIVPct / 100;
  const move = spotPrice * sigma * Math.sqrt(years);
  return {
    daysToExpiry: days,
    oneSDMoveAbs: Number(move.toFixed(2)),
    oneSDRange: [Number((spotPrice - move).toFixed(2)), Number((spotPrice + move).toFixed(2))],
    note: 'Implied 1-standard-deviation range from ATM IV (~68% historical-frequency band under log-normal assumptions) — a volatility-implied range, not a forecast.',
  };
}

module.exports = {
  blackScholesGreeks, computeChainGreeks, computePCR, computeMaxPain, computeExpectedMove, yearsToExpiry,
};

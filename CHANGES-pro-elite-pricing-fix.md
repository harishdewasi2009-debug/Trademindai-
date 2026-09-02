# Fix: Pro/Elite checkout charging the wrong amount (₹499/₹999 instead of ₹999/₹3,199)

## Symptom
Pricing page copy (top-of-file summary comment in `plans.js`, the FAQ
answer in `frontend/index.html`, and the worst-case margin math already
written in the per-plan comments) all described Pro at ₹999 and Elite at
₹3,199 — but the actual `amountInPaise` values used at checkout, and the
prices shown on the pricing cards/comparison table/buy buttons, were still
the old ₹499 (Pro) and ₹999 (Elite). Whoever last updated the pricing
model updated the docs and quota math but never the numbers that actually
get charged or displayed.

## Fix
- `backend/config/plans.js`: `pro.amountInPaise` 49900 → 99900 (₹999),
  `elite.amountInPaise` 99900 → 319900 (₹3,199).
- `frontend/index.html`: pricing cards (`#price-pro`, `#price-elite`),
  comparison table headers (`#comp-price-pro`, `#comp-price-elite`), and
  the `onclick="openPay(...)"` buy-button amounts (only used for the
  confirmation modal's display text — the actual charge always came from
  the backend's `amountInPaise`, but it needs to match or the modal shows
  a different number than what gets charged).

## Files changed
- `backend/config/plans.js`
- `frontend/index.html`

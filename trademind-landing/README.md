# TradeMindAI — Landing Page

A two-section landing page (hero + philosophy statement) built with React,
Vite, TypeScript, and Tailwind CSS.

## Design tokens

- **Colors**: `ink` #070B14 (background), `teal` #12374A, `signal` #D4A24C
  (gold accent — the "signal" color), `mist` #8891A3, `paper` #EDEEF0
- **Type**: Fraunces (display/headline, italic), Inter (body/nav/buttons),
  IBM Plex Mono (data labels, eyebrows, ticker text)
- **Signature element**: `MarketPulse.tsx` — a canvas-drawn signal line that
  plots itself in on load, then settles into an ambient breathing tick

## Run it

```bash
npm install
npm run dev
```

Then open the printed local URL. For a production build:

```bash
npm run build
npm run preview
```

## Notes

- Built and reviewed this environment couldn't reach the npm registry
  (sandboxed, no network), so the code was written carefully and reviewed
  by hand rather than compiled here — run `npm install` locally to fetch
  dependencies and do a normal `tsc` type-check before deploying.
- The hero tagline/subhead and the philosophy-section quote are placeholder
  copy — swap them in `src/components/Hero.tsx` and
  `src/components/PhilosophySection.tsx`.
- Reduced-motion is respected throughout (canvas animation and parallax
  both check `prefers-reduced-motion`).

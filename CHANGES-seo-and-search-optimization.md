# SEO + search optimisation

## What was added
**Frontend (`frontend/`)**
- `index.html`: new title/description (per your spec), canonical, robots, hreflang `en-IN`, Organization / WebSite / WebApplication JSON-LD (no ratings or reviews), new H1, crawlable `<a href>` link block in the footer, `<noscript>` fallback, `/?page=<id>` deep links, copyright 2025 -> 2026.
- 21 static, indexable pages (each with its own title, description, canonical, Open Graph, BreadcrumbList):
  `/ai-stock-analysis/ /technical-analysis/ /nse-stock-analysis/ /bse-stock-analysis/ /nifty-50-analysis/ /stock-market-screener/ /mcx-commodity-analysis/ /stock-chart-analysis/ /trading-indicators/`
  plus the pages Google uses for sitelinks: `/features/ /pricing/ /trust-accuracy/ /contact/`
  plus `/learn/` and 6 articles under `/learn/<slug>/` (Article JSON-LD, author, dates).
- `sitemap.xml` (21 URLs) and `robots.txt`.

**Search (all search boxes share one engine in `index.html`)**
- 200 ms debounce, request cancellation, 60 s cache, exchange chips (All/NSE/BSE/MCX), exchange + instrument-type labels,
  recent searches with Clear, keyboard navigation (Up/Down/Enter/Esc), ARIA combobox, loading / empty / error+retry states.
- Prices appear only when the quote API returns one, tagged "last close" when the market is closed.
- Backend (`services/marketDataService.js`, `middleware/validate.js`): ranked search (exact symbol > symbol prefix > company-name words > name contains > symbol contains > one-typo match), spaces/dots/hyphens allowed ("TATA STEEL", "BAJAJ-AUTO"), server-side result cache. Existing rate limiter, auth and plan checks are unchanged.

## Deploy
1. Upload everything under `frontend/` (all new folders + `index.html`, `sitemap.xml`, `robots.txt`) and the two backend files. Redeploy both Render services.
2. Open `https://trademindai.co.in/sitemap.xml`, `/robots.txt` and `/ai-stock-analysis/` to confirm they load.

## Manual Search Console steps (cannot be done from code)
1. https://search.google.com/search-console -> add property `https://trademindai.co.in` (URL prefix) -> verify (HTML tag: paste into `<head>` of `frontend/index.html`).
2. Sitemaps -> submit `sitemap.xml`.
3. URL Inspection -> request indexing for `/`, `/ai-stock-analysis/`, `/stock-market-screener/`, `/pricing/`, `/features/`.
4. Add Google Analytics 4 / Search Console linking only with a consent banner (Privacy Policy mentions usage data).
5. Review Performance monthly: pages with impressions but low CTR, queries at positions 8-20.

## Notes
- Sitelinks (like the screenshot) are chosen by Google automatically; they cannot be forced. The site now has what Google uses: distinct pages named Features / Pricing / Trust and Methodology / Contact / AI Stock Analysis, linked from every page and the footer. Allow weeks after indexing.
- Rankings cannot be guaranteed. Dedicated pages + sitemap + Search Console are the foundation.
- Homepage meta description is 182 chars (your wording); Google may trim it.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An eBay affiliate tool that scouts children's/YA book deals and generates ready-to-post tweets with EPN affiliate links. It targets NYT Bestseller books sold cheaply on eBay, generating 3 tweet variants per deal and exporting a Buffer schedule.

## Dev Commands

```bash
npm run dev      # Start Vite dev server (localhost:5173)
npm run build    # Production build to dist/
```

## Structure

- `epn-book-deal-scout.jsx` — the entire application (UI + data logic)
- `src/main.jsx` — Vite entry point, mounts `App` from the JSX above
- `epn-book-scout-handoff.md` — Cloudflare Worker code + deploy steps

## Architecture

The app calls a **Cloudflare Worker proxy** at `https://finddeals.trovescore.com` (production) or an empty string (dev — so `/nyt` and `/ebay` are relative, hitting Vite's dev server or a local proxy). The `WORKER` constant at the top of the JSX uses `import.meta.env.DEV` to switch:

```js
const WORKER = import.meta.env.DEV ? "" : "https://finddeals.trovescore.com";
```

Worker endpoints:
- `GET /nyt?list=<list-name>` → proxies NYT Books API, returns `{ results: { books: [...] } }`
- `GET /ebay?q=<title>` → proxies eBay Browse API, returns `{ itemSummaries: [...] }`

The worker code and `wrangler.toml` are in `epn-book-scout-handoff.md`. Secrets are set via `wrangler secret put NYT_API_KEY` and `wrangler secret put EBAY_APP_ID`.

## Key Data Flows

**Scout flow**: `runScout()` calls `scoutCategory("mg")` then `scoutCategory("ya", mgTitles)`. Each call fetches the NYT list, then iterates books calling `fetchEbay()` per title (400ms throttle between calls). MG titles are excluded from the YA scan to prevent duplicates.

**Two-tier deals**:
- Budget (≤$20): `priceScore * 2 + condScore + gapBonus`, minimum score 7 to show. priceScore: ≤$5→5, ≤$10→4, ≤$15→3, ≤$20→2.
- Premium ($20–$200): only included if ≥20% savings vs new. `priceScore + condScore + gapBonus`.
- condScore: conditionId 2500→5, 3000→4, 4000→3, 5000→2. gapBonus: ≥50% off→2/3, ≥30%→1/2.
- New reference price requires ≥2 new listings to avoid single-outlier skew.

**EPN affiliate links**: Direct URL parameter injection. Format: `https://www.ebay.com/itm/ITEM_ID?mkcid=1&mkrid=711-53200-19255-0&siteid=0&toolid=10001&mkevt=1&campid=CAMPID`. Never use `rover.ebay.com` (returns a 1×1 pixel).

**Tweet constraints**: Body ≤100 characters (`.slice(0, 100)`). Three angles: urgency/Price Drop, social/NYT List, gift/Gift Angle.

**Buffer export**: Posts interleaved MG/YA across all three angles, one post every other day.

**Persistence**: Uses `localStorage` — keys: `scout-history` (post log), `scout-runs` (full deal objects per run, capped at 100), `scout-posted` (Set of ebayUrls marked posted). The `postedUrls` Set drives the "Posted to X" checkbox state across runs.

## NYT List Names

| Category | List name |
|----------|-----------|
| Middle Grade | `middle-grade` |
| Young Adult / Adult Fiction | `hardcover-fiction` |

(Configured in `NYT_LIST` constant at top of JSX.)

## Environment Variables

All `VITE_*` variables are optional with defaults:

| Variable | Default | Effect |
|----------|---------|--------|
| `VITE_EPN_CAMPID` | `""` | EPN campaign ID (affiliate links disabled if unset) |
| `VITE_NYT_SCAN_LIMIT` | `10` | Books to scan per NYT batch |
| `VITE_BUDGET_DEALS_MAX` | `3` | Max budget deals per category |
| `VITE_PREMIUM_DEALS_MAX` | `3` | Max premium deals per category |
| `VITE_FREE_SHIPPING_ONLY` | `false` | Pass `freeShipping=true` to worker |
| `VITE_MIN_SELLER_RATING` | `98` | Minimum seller feedback percentage |
| `VITE_MIN_SELLER_COUNT` | `0` | Minimum seller feedback score (0 = disabled) |

## Credentials

API keys are set as Cloudflare Worker secrets (never in code). The EPN Campaign ID is either set via `VITE_EPN_CAMPID` at build time or shown as a warning in the UI.

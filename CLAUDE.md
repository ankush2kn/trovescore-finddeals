# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An eBay affiliate tool that scouts children's/YA book deals and generates ready-to-post tweets with EPN affiliate links. It targets NYT Bestseller books sold cheaply on eBay, generating 3 tweet variants per deal and exporting a 60-day Buffer schedule.

## No Build System

This is a **single-file React component** (`epn-book-deal-scout.jsx`) designed to run in a Claude.ai artifact or sandboxed iframe. There is no `package.json`, no bundler, no TypeScript, no test runner, and no lint config. JSX with inline styles throughout.

## Architecture: Current State vs. Target State

**Current state** (`epn-book-deal-scout.jsx`): Uses Claude API (`claude-sonnet-4-20250514`) with `web_search_20250305` tool as a workaround. Two-phase: research call (web search enabled) followed by synthesis call (JSON extraction only). This is a stopgap — web search can't reliably retrieve the NYT paywall list, and synthesis intermittently produces empty output.

**Target state**: Replace `scoutCategory()` with direct calls to a Cloudflare Worker proxy that holds the API keys server-side:
- `GET /nyt?list=young-adult` → proxies NYT Books API
- `GET /ebay?q=Book+Title` → proxies eBay Finding API (category 267, FixedPrice, conditions 1000/2500/3000)

The full worker code and `wrangler.toml` are documented in `epn-book-scout-handoff.md`. Deploy steps: `wrangler init epn-book-scout` → paste worker code → `wrangler secret put NYT_API_KEY` + `wrangler secret put EBAY_APP_ID` → `wrangler deploy`.

After deploying, update the `WORKER` constant in the JSX and replace `scoutCategory()` with `fetchNYT()` + `fetchEbay()` calls as shown in the handoff doc.

## Key Data Flows

**EPN affiliate links**: Use direct URL parameter injection — never `rover.ebay.com` (returns a 1×1 pixel). Format: `https://www.ebay.com/itm/ITEM_ID?mkcid=1&mkrid=711-53200-19255-0&siteid=0&toolid=10001&mkevt=1&campid=CAMPID`

**Deal scoring**: `priceScore * 2 + condScore` where priceScore is based on price tiers (≤$8=5, ≤$12=4, ≤$18=3) and condScore maps eBay condition IDs (1000=New=5, 2500=Like New=4, 3000=Very Good=3, 4000=Good=2). Only scores ≥3 are shown.

**Tweet constraints**: Body line ≤100 characters, truncated with `.slice(0, 100)`. Three angles per deal: urgency/Price Drop, social/NYT List, gift/Gift Angle.

**Browser persistence**: `window.storage` (not `localStorage`) for `scout-campid` and `scout-history` (JSON array of posted deals). Next post date enforces 2-day interval.

**Buffer export**: 30 posts (5 MG + 5 YA deals × 3 angles), interleaved MG/YA, one post every other day.

## NYT List Names

| Category | List name |
|----------|-----------|
| Middle Grade | `middle-grade` (fallbacks: `childrens-middle-grade`, `chapter-books`) |
| Young Adult | `young-adult` |

## Credentials

Credentials are in `epn-book-scout-handoff.md`. The NYT API key and eBay App ID **must be rotated** before using in production — they were shared in chat and should be treated as compromised. The EPN Campaign ID is user-provided at runtime and stored in the browser.

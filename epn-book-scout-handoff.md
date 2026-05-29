# EPN Book Deal Scout — Project Handoff

## What This Is

A tool that finds popular children's/YA book deals on eBay, generates ready-to-post X.com tweets with eBay Partner Network affiliate links, and exports a bulk schedule for Buffer. The goal is to post every other day, drive clicks to eBay, and earn EPN commission (1–4% per sale).

---

## User's Credentials

> ⚠️ These were shared in chat — rotate them after setting up the new project.

| Key | Value |
|-----|-------|
| NYT Books API Key | *(set via `wrangler secret put NYT_API_KEY` — do not commit)* |
| eBay App ID (Client ID) | *(set via `wrangler secret put EBAY_APP_ID` — do not commit)* |
| EPN Campaign ID | *(user enters in app — stored in browser)* |

---

## Target Behaviour

1. Scout top 5 Middle Grade (ages 8–12) + top 5 Young Adult (ages 13–18) deals from eBay
2. Source book titles from NYT Bestseller lists (MG + YA)
3. Find real eBay Buy-It-Now listings — actual item URLs (`ebay.com/itm/...`), actual prices
4. Generate 3 tweet variants per deal (Price Drop / Social Proof / Gift Angle), body ≤100 chars
5. Auto-append EPN tracking to every link: `mkcid=1&mkrid=711-53200-19255-0&siteid=0&toolid=10001&mkevt=1&campid=CAMPAIGNID`
6. Post history persists; app shows next post date (every other day)
7. Export all 30 posts (10 deals × 3 angles) formatted for Buffer bulk scheduler

---

## Architecture Decisions Made

### Why Cloudflare Worker is needed

The frontend runs in a browser. Browsers block cross-origin requests to NYT API and eBay API (no CORS headers on those endpoints). The only URL a Claude.ai artifact can fetch is `api.anthropic.com`.

**The fix:** A Cloudflare Worker acts as a thin proxy. It holds the API keys server-side and exposes two endpoints the browser can call:

```
GET /nyt?list=young-adult          → proxies NYT Books API
GET /ebay?q=Percy+Jackson+book     → proxies eBay Finding API
```

### Why not Claude web search for data fetching

Tried it. Three problems:
1. NYT bestseller list is behind a paywall — web search can't retrieve ranked list data
2. Claude truncates before outputting JSON when doing multi-step research tasks
3. eBay prices found via web search don't reliably match the linked listings

### EPN Link Format

Use direct URL parameter injection (NOT the rover.ebay.com redirect — that serves a 1×1 pixel):

```
https://www.ebay.com/itm/123456789?mkcid=1&mkrid=711-53200-19255-0&siteid=0&toolid=10001&mkevt=1&campid=YOUR_CAMPID
```

---

## Cloudflare Worker — What to Build

### Worker file: `worker.js`

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for browser access
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };

    if (path === '/nyt') {
      const list = url.searchParams.get('list') || 'young-adult';
      const nytUrl = `https://api.nytimes.com/svc/books/v3/lists/current/${list}.json?api-key=${env.NYT_API_KEY}`;
      const res = await fetch(nytUrl);
      const data = await res.json();
      return new Response(JSON.stringify(data), { headers: cors });
    }

    if (path === '/ebay') {
      const q = url.searchParams.get('q') || '';
      const params = new URLSearchParams({
        'OPERATION-NAME': 'findItemsByKeywords',
        'SERVICE-VERSION': '1.0.0',
        'SECURITY-APPNAME': env.EBAY_APP_ID,
        'RESPONSE-DATA-FORMAT': 'JSON',
        'keywords': q,
        'categoryId': '267',
        'paginationInput.entriesPerPage': '8',
        'itemFilter(0).name': 'ListingType',
        'itemFilter(0).value': 'FixedPrice',
        'itemFilter(1).name': 'Condition',
        'itemFilter(1).value(0)': '1000',
        'itemFilter(1).value(1)': '2500',
        'itemFilter(1).value(2)': '3000',
        'sortOrder': 'BestMatch',
      });
      const ebayUrl = `https://svcs.ebay.com/services/search/FindingService/v1?${params}`;
      const res = await fetch(ebayUrl);
      const data = await res.json();
      return new Response(JSON.stringify(data), { headers: cors });
    }

    return new Response('Not found', { status: 404 });
  }
};
```

### wrangler.toml

```toml
name = "epn-book-scout"
main = "worker.js"
compatibility_date = "2024-01-01"

[vars]
# Set secrets via: wrangler secret put NYT_API_KEY

```

### Deploy steps

```bash
npm install -g wrangler
wrangler login
wrangler deploy

# Add secrets (never commit these)
wrangler secret put NYT_API_KEY
wrangler secret put EBAY_APP_ID
```

Your worker URL will be: `https://epn-book-scout.YOUR_SUBDOMAIN.workers.dev`

---

## Frontend — Current React Component

The current file is `epn-book-deal-scout.jsx`. Once the worker is deployed, replace the two fetch functions with direct calls to your worker:

```js
// Replace the claudeFetch / scoutCategory logic with:

const WORKER = 'https://epn-book-scout.YOUR_SUBDOMAIN.workers.dev';

async function fetchNYT(listName) {
  const res = await fetch(`${WORKER}/nyt?list=${listName}`);
  const data = await res.json();
  return data.results?.books?.slice(0, 10) || [];
}

async function fetchEbay(query) {
  const res = await fetch(`${WORKER}/ebay?q=${encodeURIComponent(query)}`);
  const data = await res.json();
  return data?.findItemsByKeywordsResponse?.[0]?.searchResult?.[0]?.item || [];
}
```

### NYT list names to use

| Category | List name |
|----------|-----------|
| Middle Grade | `middle-grade` (fallback: `childrens-middle-grade`, then `chapter-books`) |
| Young Adult | `young-adult` |

### eBay Finding API — item shape

```js
item = {
  itemId: ["123456789"],
  title: ["Percy Jackson Box Set"],
  viewItemURL: ["https://www.ebay.com/itm/123456789"],
  sellingStatus: [{ currentPrice: [{ "__value__": "12.99", "@currencyId": "USD" }] }],
  condition: [{ conditionDisplayName: ["Like New"], conditionId: ["2500"] }],
  listingInfo: [{ listingType: ["FixedPrice"] }],
}
```

### Deal scoring logic (already in component)

```js
const price = parseFloat(item.sellingStatus[0].currentPrice[0]["__value__"]);
const condId = item.condition[0].conditionId[0];
const condScore = { "1000":5, "2500":4, "3000":3, "4000":2 }[condId] || 1;
const priceScore = price<=8 ? 5 : price<=12 ? 4 : price<=18 ? 3 : 2;
const dealScore = priceScore * 2 + condScore;
```

---

## Current Frontend Code

```jsx
// epn-book-deal-scout.jsx
// Last working state — uses Claude API web search as data source (workaround)
// Replace scoutCategory() with worker-based fetchNYT + fetchEbay calls

import { useState, useEffect, useCallback } from "react";

const EPN_TRACKING = "mkcid=1&mkrid=711-53200-19255-0&siteid=0&toolid=10001&mkevt=1";
const CATS = [
  { id:"mg", label:"Middle Grade", age:"ages 8–12",  ageShort:"kids 8–12",  emoji:"🧩", accent:"#f0c040" },
  { id:"ya", label:"Young Adult",  age:"teens 13–18", ageShort:"teens 13–18", emoji:"⚡", accent:"#ff5f5f" },
];
const TAGS = {
  mg:"#BookDeals #MiddleGrade #KidsBooks #eBayFinds",
  ya:"#BookDeals #YABooks #TeenReads #eBayFinds",
};
const ANGLES = [
  { id:"urgency", label:"⚡ Price Drop",   color:"#f0c040" },
  { id:"social",  label:"📚 NYT List",     color:"#5fafff" },
  { id:"gift",    label:"🎁 Gift Angle",   color:"#ff8c42" },
];

const buildEpnLink = (campid, url) =>
  `${url}${url.includes("?")?"&":"?"}${EPN_TRACKING}&campid=${campid}`;

const fmtDate = d => d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});

const buildTweet = (deal, angleId, catId, campid) => {
  const link = campid && deal.ebayUrl ? buildEpnLink(campid, deal.ebayUrl) : (deal.ebayUrl || "");
  const tags  = TAGS[catId];
  const cat   = CATS.find(c=>c.id===catId);
  const rank  = deal.nytRank ? `#${deal.nytRank} NYT` : "NYT Bestseller";
  const bodies = {
    urgency: `⚡ "${deal.title}" — ${deal.price} on eBay (${deal.condition})`,
    social:  `📚 ${rank}: "${deal.title}" — only ${deal.price} on eBay`,
    gift:    `🎁 Perfect gift for ${cat.ageShort}: "${deal.title}" — ${deal.price}`,
  };
  const body = (bodies[angleId] || bodies.urgency).slice(0, 100);
  return `${body}\n${link}\n${tags}`;
};

// --- Data fetching (REPLACE with worker calls once deployed) ---

async function claudeFetch(userPrompt, systemPrompt, useTools) {
  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (systemPrompt) body.system = systemPrompt;
  if (useTools) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

function extractJSON(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function scoutCategory(catId) {
  const cat = CATS.find(c => c.id === catId);
  const research = await claudeFetch(
    `Search eBay right now for popular ${cat.label} books (${cat.age}).
Look for well-known titles — bestsellers, award winners, series kids love.
For each one, find a real cheap Buy It Now listing (ebay.com/itm/...) with an actual price under $20.
Find at least 6 books with real eBay listing URLs and prices.`,
    null, true
  );
  const researchDump = (research.content || [])
    .map(b => b.type === "text" ? b.text : b.type === "tool_result" ? JSON.stringify(b.content || "") : "")
    .filter(Boolean).join("\n\n").slice(0, 8000);
  if (!researchDump.trim()) throw new Error("Phase 1 returned no content from web search.");
  const synthesis = await claudeFetch(
    `Extract the best book deals from the research below and output ONLY this JSON object.
No prose. No markdown. No explanation. Start your response with { and end with }.
{"deals":[{"title":"Book Title","author":"Author Name","price":"$9.99","priceRaw":9.99,"condition":"Like New","ebayUrl":"https://www.ebay.com/itm/REAL_ITEM_ID","description":"One sentence about the book","dealScore":4}]}
dealScore 1–5. Only include score 3+. Up to 5 deals. Use ONLY real ebay.com/itm/ URLs from the research.
RESEARCH DATA:\n${researchDump}`,
    "Output only a raw JSON object. No markdown. No prose. Begin with { and end with }.",
    false
  );
  const synthText = (synthesis.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  const parsed = extractJSON(synthText);
  if (!parsed) throw new Error(`Synthesis failed.\nClaude said:\n${synthText.slice(0, 500)}`);
  const deals = Array.isArray(parsed) ? parsed : (parsed.deals || []);
  if (!deals.length) throw new Error("JSON parsed but contained no deals.");
  return deals
    .filter(d => d.ebayUrl?.includes("ebay.com"))
    .sort((a, b) => (b.dealScore || 0) - (a.dealScore || 0))
    .slice(0, 5);
}

// (UI components and App() continue — see epn-book-deal-scout.jsx for full file)
```

---

## Known Issues / What Didn't Work

| Approach | Problem |
|----------|---------|
| Direct fetch to NYT API from browser | CORS blocked |
| Direct fetch to eBay Finding API from browser | CORS blocked |
| eBay Finding API via JSONP `<script>` tag | Inconsistent; couldn't confirm it works from sandboxed iframe |
| corsproxy.io as CORS proxy | Blocked — Claude.ai artifact CSP only allows `api.anthropic.com` |
| Claude web search → single prompt → JSON | NYT is paywalled; Claude truncates before writing JSON |
| Claude two-phase (research + synthesis) | Synthesis produces empty output intermittently |

---

## Recommended Next Steps in Cursor

1. `wrangler init epn-book-scout` — scaffold the worker
2. Paste the worker code above into `worker.js`
3. `wrangler secret put NYT_API_KEY` → paste the NYT key
4. `wrangler secret put EBAY_APP_ID` → paste the eBay App ID
5. `wrangler deploy` → get your worker URL
6. In `epn-book-deal-scout.jsx`, replace `scoutCategory()` with `fetchNYT()` + `fetchEbay()` calls to your worker URL
7. Test: does `/nyt?list=young-adult` return books? Does `/ebay?q=Hunger+Games+book` return listings?
8. Wire up the full flow and test end-to-end

---

## Tweet Format Reference

```
⚡ "Hunger Games Box Set" — $9.99 on eBay (Like New)
https://www.ebay.com/itm/123456789?mkcid=1&mkrid=711-53200-19255-0&siteid=0&toolid=10001&mkevt=1&campid=YOUR_CAMPID
#BookDeals #YABooks #TeenReads #eBayFinds
```

- Body line: max 100 characters
- 3 angles per deal: Price Drop / NYT List / Gift Angle
- 10 deals total (5 MG + 5 YA) × 3 angles = 30 posts
- Post every other day = 60 days of content per scout run
- Interleave MG and YA in the schedule

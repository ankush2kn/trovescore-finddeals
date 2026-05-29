const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// Module-level token cache (lives for the duration of the isolate)
let ebayToken = { value: null, expiresAt: 0 };

async function getEbayToken(env) {
  if (ebayToken.value && Date.now() < ebayToken.expiresAt) return ebayToken.value;
  const credentials = btoa(`${env.EBAY_APP_ID}:${env.EBAY_APP_SECRET}`);
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`eBay auth ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  ebayToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return ebayToken.value;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const url = new URL(request.url);

    if (url.pathname === '/nyt') {
      const category = url.searchParams.get('category') || 'ya';
      const nytUrl = `https://api.nytimes.com/svc/books/v3/lists/overview.json?api-key=${env.NYT_API_KEY}`;
      try {
        const res = await fetch(nytUrl);
        if (!res.ok) {
          const body = await res.text();
          return new Response(
            JSON.stringify({ error: `NYT API ${res.status}`, detail: body.slice(0, 200) }),
            { status: res.status, headers: CORS }
          );
        }
        const data = await res.json();
        const keywords = category === 'ya'
          ? ['young adult']
          : ['middle grade', 'children'];
        const seen = new Set();
        const books = [];
        for (const list of (data.results?.lists || [])) {
          const name = (list.display_name || '').toLowerCase();
          if (keywords.some(kw => name.includes(kw))) {
            for (const book of (list.books || [])) {
              if (!seen.has(book.title)) {
                seen.add(book.title);
                books.push(book);
              }
            }
          }
        }
        return new Response(JSON.stringify({ results: { books } }), { headers: CORS });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
      }
    }

    if (url.pathname === '/ebay') {
      const q = url.searchParams.get('q') || '';
      if (!q) {
        return new Response(JSON.stringify({ error: 'Missing q parameter' }), { status: 400, headers: CORS });
      }
      try {
        const token = await getEbayToken(env);
        const params = new URLSearchParams({
          q,
          category_ids: '267',
          filter: 'buyingOptions:{FIXED_PRICE},price:[1..20],priceCurrency:USD',
          limit: '8',
          sort: 'bestMatch',
        });
        const res = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) {
          const body = await res.text();
          return new Response(
            JSON.stringify({ error: `eBay API ${res.status}`, detail: body.slice(0, 200) }),
            { status: res.status, headers: CORS }
          );
        }
        const data = await res.json();
        return new Response(JSON.stringify(data), { headers: CORS });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
      }
    }

    if (url.pathname === '/debug') {
      return new Response(JSON.stringify({
        hasNyt: !!env.NYT_API_KEY,
        nytLen: (env.NYT_API_KEY || '').length,
        hasEbay: !!env.EBAY_APP_ID,
        hasEbaySecret: !!env.EBAY_APP_SECRET,
      }), { headers: CORS });
    }

    return new Response(
      JSON.stringify({ status: 'ok', endpoints: ['/nyt', '/ebay', '/debug'] }),
      { headers: CORS }
    );
  },
};

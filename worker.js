const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

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
      try {
        const res = await fetch(ebayUrl);
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
        ebayLen: (env.EBAY_APP_ID || '').length,
      }), { headers: CORS });
    }

    return new Response(
      JSON.stringify({ status: 'ok', endpoints: ['/nyt', '/ebay', '/debug'] }),
      { headers: CORS }
    );
  },
};

import { useState, useEffect, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
const EPN_TRACKING = "mkcid=1&mkrid=711-53200-19255-0&siteid=0&toolid=10001&mkevt=1";
const CATS = [
  { id:"mg", label:"Middle Grade",   age:"ages 8–12",  ageShort:"kids 8–12", emoji:"🧩", accent:"#f0c040" },
  { id:"ya", label:"Adult Fiction",  age:"fiction",    ageShort:"readers",   emoji:"📖", accent:"#ff5f5f" },
];
const TAGS = {
  mg:"#BookDeals #MiddleGrade #KidsBooks #eBayFinds",
  ya:"#BookDeals #FictionDeals #Bookstagram #eBayFinds",
};
const ANGLES = [
  { id:"urgency", label:"⚡ Price Drop",   color:"#f0c040" },
  { id:"social",  label:"📚 NYT List",     color:"#5fafff" },
  { id:"gift",    label:"🎁 Gift Angle",   color:"#ff8c42" },
];
const WORKER             = import.meta.env.DEV ? "" : "https://finddeals.trovescore.com";
const NYT_SCAN_LIMIT     = parseInt(import.meta.env.VITE_NYT_SCAN_LIMIT     || "10");
const BUDGET_DEALS_MAX   = parseInt(import.meta.env.VITE_BUDGET_DEALS_MAX   || "3");
const PREMIUM_DEALS_MAX  = parseInt(import.meta.env.VITE_PREMIUM_DEALS_MAX  || "3");
const FREE_SHIPPING_ONLY = import.meta.env.VITE_FREE_SHIPPING_ONLY === "true";
const MIN_SELLER_RATING  = parseFloat(import.meta.env.VITE_MIN_SELLER_RATING || "98");
const MIN_SELLER_COUNT   = parseInt(import.meta.env.VITE_MIN_SELLER_COUNT   || "0");

// ─── Helpers ──────────────────────────────────────────────────────────────────
const buildEpnLink = (campid, url) =>
  `${url}${url.includes("?")?"&":"?"}${EPN_TRACKING}&campid=${campid}`;

const fmtDate = d => d.toLocaleDateString("en-US",{weekday:"short",month:"short",day:"numeric"});

const buildTweet = (deal, angleId, catId, campid) => {
  const link = campid && deal.ebayUrl ? buildEpnLink(campid, deal.ebayUrl) : (deal.ebayUrl || "");
  const tags  = TAGS[catId];
  const cat   = CATS.find(c=>c.id===catId);
  const rank  = deal.nytRank ? `#${deal.nytRank} NYT` : "NYT Bestseller";
  const bodies = {
    urgency: deal.savingsVsNew && deal.newRefPrice
      ? `⚡ "${deal.title}" Like New $${deal.priceRaw.toFixed(2)} — new $${deal.newRefPrice.toFixed(2)}! Save ${deal.savingsVsNew}%`
      : `⚡ "${deal.title}" — ${deal.price} on eBay (${deal.condition})`,
    social:  `📚 ${rank}: "${deal.title}" — only ${deal.price} on eBay`,
    gift:    `🎁 Perfect gift for ${cat.ageShort}: "${deal.title}" — ${deal.price}`,
  };
  const body = (bodies[angleId] || bodies.urgency).slice(0, 100);
  return `${body}\n${link}\n${tags}`;
};

// ─── Worker fetch helpers ─────────────────────────────────────────────────────
const toTitleCase = s => s.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());

const NYT_LIST = { mg: "middle-grade", ya: "hardcover-fiction" };

async function fetchNYT(catId) {
  const base = WORKER.replace(/\/$/, "");
  const list = NYT_LIST[catId] || "hardcover-fiction";
  let res;
  try { res = await fetch(`${base}/nyt?list=${list}`); }
  catch { throw new Error("Cannot reach worker. Check the WORKER URL."); }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`NYT API key rejected (${res.status}). Set NYT_API_KEY in Cloudflare Worker secrets.`);
  }
  if (!res.ok) throw new Error(`NYT API error ${res.status}.`);
  const data = await res.json();
  const books = data.results?.books;
  if (!books?.length) throw new Error("No books found on NYT list.");
  return books;
}

async function fetchEbay(query) {
  let res;
  const qs = new URLSearchParams({ q: query, ...(FREE_SHIPPING_ONLY ? { freeShipping: "true" } : {}) });
  try { res = await fetch(`${WORKER.replace(/\/$/, "")}/ebay?${qs}`); }
  catch { return { items: [], tokensIn: 0, tokensOut: 0 }; }
  if (res.status === 401 || res.status === 403) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`eBay API key rejected (${res.status}). ${err.detail || "Check EBAY_APP_ID secret."}`);
  }
  if (!res.ok) return { items: [], tokensIn: 0, tokensOut: 0 };
  const data = await res.json();
  return {
    items:    data?.itemSummaries || [],
    tokensIn:  data?.usage?.input_tokens  || 0,
    tokensOut: data?.usage?.output_tokens || 0,
  };
}

// ─── Scout: NYT list → eBay prices → two-tier deals ─────────────────────────
async function scoutCategory(catId, excludeTitles = new Set()) {
  const nytBooks = await fetchNYT(catId);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Filter out titles already claimed by the other category
  const eligible = nytBooks.filter(b => !excludeTitles.has(toTitleCase(b.title).toLowerCase()));

  const budgetCandidates  = [];
  const premiumCandidates = [];
  let totalTokensIn = 0, totalTokensOut = 0;
  let callCount = 0;

  const dedupe = arr => {
    const seen = new Map();
    for (const d of arr)
      if (!seen.has(d.title) || d.dealScore > seen.get(d.title).dealScore) seen.set(d.title, d);
    return [...seen.values()];
  };

  const enoughDeals = () => {
    const bd = dedupe(budgetCandidates).filter(d => d.dealScore >= 7).slice(0, BUDGET_DEALS_MAX);
    const pd = dedupe(premiumCandidates).slice(0, PREMIUM_DEALS_MAX);
    return bd.length + pd.length >= BUDGET_DEALS_MAX + PREMIUM_DEALS_MAX;
  };

  // Scan eligible books in batches of NYT_SCAN_LIMIT; expand to next batch if needed
  for (let batchStart = 0; batchStart < eligible.length; batchStart += NYT_SCAN_LIMIT) {
    const batch = eligible.slice(batchStart, batchStart + NYT_SCAN_LIMIT);

    for (const book of batch) {
      if (callCount++ > 0) await sleep(400);
      const { items, tokensIn, tokensOut } = await fetchEbay(book.title);
      totalTokensIn  += tokensIn;
      totalTokensOut += tokensOut;

      const newItems    = items.filter(it => it.conditionId === "1000");
      const usedItems   = items.filter(it => ["2500","3000","4000","5000"].includes(it.conditionId));
      // Require ≥2 new listings so a single outlier seller can't skew the reference price
      const newPrices   = newItems.map(it => parseFloat(it.price?.value || "0")).filter(p => p > 0);
      const minNewPrice = newPrices.length >= 2 ? Math.min(...newPrices) : null;

      for (const item of usedItems) {
        const priceStr = item.price?.value;
        if (!priceStr) continue;
        const price = parseFloat(priceStr);
        if (price > 200 || !item.itemWebUrl?.includes("ebay.com")) continue;

        const feedbackPct   = parseFloat(item.seller?.feedbackPercentage);
        const feedbackScore = parseInt(item.seller?.feedbackScore || "0");
        if (!isNaN(feedbackPct) && feedbackPct < MIN_SELLER_RATING) continue;
        if (MIN_SELLER_COUNT > 0 && feedbackScore < MIN_SELLER_COUNT) continue;

        const condId    = item.conditionId || "4000";
        const condScore = { "2500": 5, "3000": 4, "4000": 3, "5000": 2 }[condId] || 1;
        const savingsVsNew = (minNewPrice && price < minNewPrice)
          ? Math.round(((minNewPrice - price) / minNewPrice) * 100) : null;

        const deal = {
          title: toTitleCase(book.title),
          author: book.author,
          price: `$${price.toFixed(2)}`,
          priceRaw: price,
          condition: item.condition || "Used",
          ebayUrl: item.itemWebUrl,
          description: book.description || "",
          nytRank: book.rank,
          nytWeeks: book.weeks_on_list,
          savingsVsNew,
          newRefPrice: minNewPrice,
        };

        if (price <= 20) {
          const priceScore = price <= 5 ? 5 : price <= 10 ? 4 : price <= 15 ? 3 : 2;
          const gapBonus   = (savingsVsNew || 0) >= 50 ? 2 : (savingsVsNew || 0) >= 30 ? 1 : 0;
          budgetCandidates.push({ ...deal, dealScore: priceScore * 2 + condScore + gapBonus });
        }

        if (price > 20 && price <= 200 && (savingsVsNew || 0) >= 20) {
          const priceScore = price <= 30 ? 5 : price <= 60 ? 4 : price <= 100 ? 3 : 2;
          const gapBonus   = (savingsVsNew || 0) >= 50 ? 3 : (savingsVsNew || 0) >= 30 ? 2 : 1;
          premiumCandidates.push({ ...deal, dealScore: priceScore + condScore + gapBonus });
        }
      }
    }

    if (enoughDeals()) break; // got what we need — don't scan further
  }

  const budgetDeals  = dedupe(budgetCandidates)
    .filter(d => d.dealScore >= 7)
    .sort((a, b) => b.dealScore - a.dealScore)
    .slice(0, BUDGET_DEALS_MAX);

  const premiumDeals = dedupe(premiumCandidates)
    .sort((a, b) => b.dealScore - a.dealScore)
    .slice(0, PREMIUM_DEALS_MAX);

  if (!budgetDeals.length && !premiumDeals.length)
    throw new Error("No deals found. Try again or check eBay inventory.");

  return { budgetDeals, premiumDeals, tokensIn: totalTokensIn, tokensOut: totalTokensOut };
}

// ─── Sub-components ───────────────────────────────────────────────────────────
const Badge = ({ children, color = "#f0c040" }) => (
  <span style={{ background:color, color:"#0d0d0d", fontSize:"0.6rem", fontFamily:"monospace",
    fontWeight:800, padding:"2px 6px", borderRadius:"2px", letterSpacing:"0.07em", textTransform:"uppercase" }}>
    {children}
  </span>
);

const CopyBtn = ({ text }) => {
  const [ok, setOk] = useState(false);
  const go = async () => { try { await navigator.clipboard.writeText(text); } catch {} setOk(true); setTimeout(()=>setOk(false),2000); };
  return (
    <button onClick={go} style={{ background:ok?"#2a9d5c":"#f0c040", color:"#0d0d0d", border:"none",
      borderRadius:"3px", padding:"7px 14px", fontFamily:"monospace", fontWeight:800,
      fontSize:"0.72rem", cursor:"pointer", whiteSpace:"nowrap" }}>
      {ok ? "✓ COPIED" : "📋 COPY"}
    </button>
  );
};

const DealCard = ({ deal, campid, catId, idx, onPost, schedDate }) => {
  const [angle, setAngle] = useState("urgency");
  const tweet = buildTweet(deal, angle, catId, campid);
  const body  = tweet.split("\n").slice(0, -2).join("\n");
  const link  = campid && deal.ebayUrl ? buildEpnLink(campid, deal.ebayUrl) : deal.ebayUrl;

  return (
    <div style={{ background:"#141414", border:`1px solid ${idx===0?"#f0c04033":"#1e1e1e"}`,
      borderRadius:"6px", padding:"16px", display:"flex", flexDirection:"column", gap:11,
      animation:`fadeUp 0.3s ease ${idx*0.05}s both` }}>

      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
        <div style={{ flex:1 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:3 }}>
            <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900,
              fontSize:"1.2rem", color:idx===0?"#f0c040":"#333", lineHeight:1 }}>#{idx+1}</span>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:"0.95rem",
              fontWeight:800, color:"#fff", textTransform:"uppercase", lineHeight:1.2 }}>
              {deal.title}
            </div>
          </div>
          <div style={{ fontFamily:"monospace", fontSize:"0.67rem", color:"#555" }}>
            {deal.author} · {deal.condition}
            {deal.nytRank && <span style={{ color:"#5fafff" }}> · NYT #{deal.nytRank}{deal.nytWeeks>1?` (${deal.nytWeeks}wk)`:""}</span>}
          </div>
        </div>
        <div style={{ textAlign:"right", flexShrink:0 }}>
          <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:"1.5rem", fontWeight:900,
            color:deal.priceRaw<=10?"#2a9d5c":deal.priceRaw<=20?"#f0c040":"#fff", lineHeight:1 }}>
            {deal.price}
          </div>
          {deal.newRefPrice && (
            <div style={{ fontFamily:"monospace", fontSize:"0.58rem", marginTop:2, lineHeight:1.6, textAlign:"right" }}>
              <span style={{ color:"#444" }}>New: ${deal.newRefPrice.toFixed(2)}</span>
              {deal.savingsVsNew && (
                <span style={{ color:"#2a9d5c", marginLeft:5 }}>{deal.savingsVsNew}% off</span>
              )}
            </div>
          )}
          {!deal.newRefPrice && <div style={{ fontFamily:"monospace", fontSize:"0.58rem", color:"#333", marginTop:1 }}>LIVE PRICE</div>}
        </div>
      </div>

      {/* Badges */}
      <div style={{ display:"flex", gap:5, flexWrap:"wrap", alignItems:"center" }}>
        {deal.savingsVsNew >= 50 && <Badge color="#2a9d5c">🔥 SAVE {deal.savingsVsNew}%</Badge>}
        {deal.savingsVsNew >= 20 && deal.savingsVsNew < 50 && <Badge color="#f0c040">SAVE {deal.savingsVsNew}%</Badge>}
        {!deal.savingsVsNew && deal.priceRaw <= 10 && <Badge color="#2a9d5c">🔥 UNDER $10</Badge>}
        {deal.condition==="Like New" && <Badge color="#5fafff">LIKE NEW</Badge>}
        {deal.priceRaw > 20 && <Badge color="#9b6dff">PREMIUM</Badge>}
        {deal.nytWeeks >= 4 && <Badge color="#ff8c42">{deal.nytWeeks}WK ON LIST</Badge>}
        {schedDate && <span style={{ marginLeft:"auto", fontFamily:"monospace", fontSize:"0.62rem", color:"#3a3a3a" }}>📅 {fmtDate(schedDate)}</span>}
      </div>

      {/* Description */}
      {deal.description && (
        <div style={{ fontFamily:"Georgia,serif", fontSize:"0.76rem", color:"#555",
          fontStyle:"italic", lineHeight:1.4, borderLeft:"2px solid #2a2a2a", paddingLeft:8 }}>
          {deal.description}
        </div>
      )}

      {/* Angle tabs */}
      <div style={{ display:"flex", gap:5 }}>
        {ANGLES.map(a => (
          <button key={a.id} onClick={()=>setAngle(a.id)} style={{ flex:1, padding:"6px 3px",
            fontFamily:"monospace", fontSize:"0.63rem", fontWeight:800, letterSpacing:"0.03em",
            border:"1px solid", borderColor:angle===a.id?a.color:"#1e1e1e",
            background:angle===a.id?a.color+"22":"transparent",
            color:angle===a.id?a.color:"#333", borderRadius:"3px", cursor:"pointer" }}>
            {a.label}
          </button>
        ))}
      </div>

      {/* Tweet preview */}
      <div style={{ background:"#0d0d0d", borderRadius:"4px", border:"1px solid #1a1a1a", padding:"11px 12px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", marginBottom:5 }}>
          <span style={{ fontFamily:"monospace", fontSize:"0.58rem", color:"#3a3a3a", letterSpacing:"0.07em" }}>POST PREVIEW</span>
          <span style={{ fontFamily:"monospace", fontSize:"0.58rem", color:body.length>100?"#ff5f5f":"#3a3a3a" }}>
            body {body.length}/100
          </span>
        </div>
        <pre style={{ margin:0, fontFamily:"monospace", fontSize:"0.73rem", color:"#bbb",
          lineHeight:1.6, whiteSpace:"pre-wrap", wordBreak:"break-word" }}>{tweet}</pre>
      </div>

      {/* Actions */}
      <div style={{ display:"flex", gap:6, flexWrap:"wrap", alignItems:"center" }}>
        <CopyBtn text={tweet} />
        {link && (
          <a href={link} target="_blank" rel="noopener noreferrer" style={{ color:"#444",
            border:"1px solid #222", borderRadius:"3px", padding:"7px 12px",
            fontFamily:"monospace", fontSize:"0.67rem", textDecoration:"none" }}>
            🔗 Verify on eBay
          </a>
        )}
        <button onClick={()=>onPost(deal)} style={{ marginLeft:"auto", background:"transparent",
          color:"#333", border:"1px solid #1e1e1e", borderRadius:"3px", padding:"7px 12px",
          fontFamily:"monospace", fontSize:"0.67rem", cursor:"pointer" }}>
          ✓ Mark Posted
        </button>
      </div>
    </div>
  );
};

// ─── Export panel ─────────────────────────────────────────────────────────────
const ExportPanel = ({ mgDeals, yaDeals, campid, onClose }) => {
  const [copied, setCopied] = useState(false);
  const today = new Date();
  let n = 1;
  const lines = [];
  const max = Math.max(mgDeals.length, yaDeals.length);
  ANGLES.forEach(ang => {
    for (let i = 0; i < max; i++) {
      if (mgDeals[i]) {
        const d = new Date(today); d.setDate(d.getDate()+(n-1)*2);
        lines.push(`=== POST ${n++} · MG · ${ang.label} · ${fmtDate(d)} ===\n${buildTweet(mgDeals[i],ang.id,"mg",campid)}\n`);
      }
      if (yaDeals[i]) {
        const d = new Date(today); d.setDate(d.getDate()+(n-1)*2);
        lines.push(`=== POST ${n++} · YA · ${ang.label} · ${fmtDate(d)} ===\n${buildTweet(yaDeals[i],ang.id,"ya",campid)}\n`);
      }
    }
  });
  const all  = lines.join("\n");
  const copy = async () => { try { await navigator.clipboard.writeText(all); } catch {} setCopied(true); setTimeout(()=>setCopied(false),2500); };

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.92)", zIndex:999,
      display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
      <div style={{ background:"#111", border:"1px solid #2a2a2a", borderRadius:"8px",
        width:"100%", maxWidth:660, maxHeight:"88vh", display:"flex", flexDirection:"column" }}>
        <div style={{ padding:"14px 18px", borderBottom:"1px solid #1e1e1e",
          display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:"1rem",
              textTransform:"uppercase", letterSpacing:"0.06em", color:"#f0c040" }}>
              {lines.length} Posts · Buffer Export
            </div>
            <div style={{ fontFamily:"monospace", fontSize:"0.62rem", color:"#444", marginTop:2 }}>
              NYT-sourced · Real eBay prices · EPN tracked · Every other day
            </div>
          </div>
          <button onClick={onClose} style={{ background:"#1e1e1e", color:"#666", border:"none",
            borderRadius:"3px", padding:"5px 10px", fontFamily:"monospace", fontSize:"0.75rem", cursor:"pointer" }}>✕</button>
        </div>
        <div style={{ overflowY:"auto", padding:"14px 18px", flex:1 }}>
          <pre style={{ margin:0, fontFamily:"monospace", fontSize:"0.67rem", color:"#666",
            lineHeight:1.7, whiteSpace:"pre-wrap", wordBreak:"break-word" }}>{all}</pre>
        </div>
        <div style={{ padding:"12px 18px", borderTop:"1px solid #1e1e1e", display:"flex", gap:10, alignItems:"center" }}>
          <button onClick={copy} style={{ background:copied?"#2a9d5c":"#f0c040", color:"#0d0d0d",
            border:"none", borderRadius:"3px", padding:"9px 18px", fontFamily:"monospace",
            fontWeight:800, fontSize:"0.75rem", cursor:"pointer", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>
            {copied ? `✓ COPIED ALL ${lines.length}` : `📋 COPY ALL ${lines.length} POSTS`}
          </button>
          <span style={{ fontFamily:"monospace", fontSize:"0.62rem", color:"#333" }}>
            Buffer → Content → Queue → Paste
          </span>
        </div>
      </div>
    </div>
  );
};

// ─── History page ─────────────────────────────────────────────────────────────
const HistoryPage = ({ runs, onDelete, onBack, campid, onPost }) => {
  const [expanded, setExpanded] = useState(null);
  const cutoff = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
  const recent = runs
    .filter(r => new Date(r.date) > cutoff)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  return (
    <div style={{ minHeight:"100vh", background:"#0d0d0d", color:"#fff", fontFamily:"Georgia,serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&display=swap');
        @keyframes fadeUp { from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none} }
        * { box-sizing:border-box; }
        button:hover{filter:brightness(1.1)}
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-thumb{background:#2a2a2a}
      `}</style>

      <div style={{ background:"linear-gradient(135deg,#111,#1a1200)", borderBottom:"2px solid #f0c040", padding:"14px 18px" }}>
        <div style={{ maxWidth:1100, margin:"0 auto", display:"flex", alignItems:"center", gap:14 }}>
          <button onClick={onBack} style={{ background:"transparent", color:"#f0c040",
            border:"1px solid #f0c04033", borderRadius:"3px", padding:"6px 12px",
            fontFamily:"monospace", fontSize:"0.72rem", fontWeight:800, cursor:"pointer", whiteSpace:"nowrap" }}>
            ← BACK
          </button>
          <div>
            <h1 style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:"clamp(1.2rem,3vw,1.7rem)",
              fontWeight:900, margin:0, textTransform:"uppercase", letterSpacing:"0.05em" }}>
              <span style={{ color:"#f0c040" }}>📋</span> Scout History
            </h1>
            <p style={{ margin:"2px 0 0", fontFamily:"monospace", fontSize:"0.62rem", color:"#555", letterSpacing:"0.07em" }}>
              {recent.length} RUN{recent.length !== 1 ? "S" : ""} IN THE PAST 4 WEEKS
            </p>
          </div>
        </div>
      </div>

      <div style={{ maxWidth:1100, margin:"0 auto", padding:"16px 14px 60px" }}>
        {recent.length === 0 ? (
          <div style={{ padding:"56px 0", textAlign:"center", fontFamily:"monospace", fontSize:"0.75rem", color:"#333" }}>
            No scout runs in the past 4 weeks.
          </div>
        ) : recent.map(run => {
          const isOpen = expanded === run.id;
          const d = new Date(run.date);
          return (
            <div key={run.id} style={{ background:"#111", border:"1px solid #1e1e1e",
              borderRadius:"6px", marginBottom:10, overflow:"hidden", animation:"fadeUp 0.2s ease both" }}>

              <div style={{ padding:"12px 16px", display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
                <div>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800,
                    fontSize:"0.95rem", color:"#fff", textTransform:"uppercase" }}>
                    {d.toLocaleDateString("en-US", { weekday:"short", month:"short", day:"numeric", year:"numeric" })}
                    <span style={{ marginLeft:8, fontFamily:"monospace", fontSize:"0.6rem",
                      color:"#444", fontWeight:400, textTransform:"none" }}>
                      {d.toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit" })}
                    </span>
                  </div>
                  <div style={{ fontFamily:"monospace", fontSize:"0.65rem", color:"#555", marginTop:3 }}>
                    🧩 {run.mgDeals.length} MG
                    <span style={{ margin:"0 8px", color:"#2a2a2a" }}>·</span>
                    ⚡ {run.yaDeals.length} YA
                    <span style={{ margin:"0 8px", color:"#2a2a2a" }}>·</span>
                    {run.mgDeals.length + run.yaDeals.length} total deals
                    {(run.tokensIn > 0 || run.tokensOut > 0) && (<>
                      <span style={{ margin:"0 8px", color:"#2a2a2a" }}>·</span>
                      <span title="LLM tokens used">
                        {(run.tokensIn || 0).toLocaleString()} in / {(run.tokensOut || 0).toLocaleString()} out tokens
                      </span>
                    </>)}
                  </div>
                </div>
                <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                  <button onClick={() => setExpanded(isOpen ? null : run.id)} style={{
                    background: isOpen ? "#f0c04022" : "#1a1a1a",
                    color: isOpen ? "#f0c040" : "#777",
                    border: `1px solid ${isOpen ? "#f0c04044" : "#2a2a2a"}`,
                    borderRadius:"3px", padding:"6px 12px",
                    fontFamily:"monospace", fontSize:"0.67rem", fontWeight:800, cursor:"pointer" }}>
                    {isOpen ? "▲ HIDE" : "▼ VIEW"}
                  </button>
                  <button onClick={() => onDelete(run.id)} style={{
                    background:"transparent", color:"#3a3a3a",
                    border:"1px solid #2a2a2a", borderRadius:"3px",
                    padding:"6px 10px", fontSize:"0.8rem", cursor:"pointer" }}>
                    🗑
                  </button>
                </div>
              </div>

              {isOpen && (
                <div style={{ borderTop:"1px solid #1a1a1a", padding:"16px",
                  display:"flex", gap:18, flexWrap:"wrap", alignItems:"flex-start" }}>
                  {[{catId:"mg", deals:run.mgDeals, label:"Middle Grade", accent:"#f0c040", emoji:"🧩"},
                    {catId:"ya", deals:run.yaDeals, label:"Young Adult",  accent:"#ff5f5f", emoji:"⚡"}
                  ].map(({ catId, deals, label, accent, emoji }) => deals.length > 0 && (
                    <div key={catId} style={{ flex:"1 1 340px", minWidth:0 }}>
                      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900,
                        fontSize:"0.85rem", textTransform:"uppercase", letterSpacing:"0.05em",
                        color:accent, marginBottom:10, paddingBottom:6, borderBottom:`2px solid ${accent}22` }}>
                        {emoji} {label} · {deals.length} deals
                      </div>
                      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                        {deals.map((deal, i) => (
                          <DealCard key={i} deal={deal} campid={campid}
                            catId={catId} idx={i} onPost={onPost} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function App() {
  const campid = import.meta.env.VITE_EPN_CAMPID ?? "";
  const [mgBudget,   setMgBudget]   = useState([]);
  const [mgPremium,  setMgPremium]  = useState([]);
  const [yaBudget,   setYaBudget]   = useState([]);
  const [yaPremium,  setYaPremium]  = useState([]);
  const [mgStatus,   setMgStatus]   = useState("idle");
  const [yaStatus,   setYaStatus]   = useState("idle");
  const [mgError,    setMgError]    = useState("");
  const [yaError,    setYaError]    = useState("");
  const [postHist,   setPostHist]   = useState([]);
  const [nextPost,   setNextPost]   = useState(null);
  const [toast,      setToast]      = useState("");
  const [showExport, setShowExport] = useState(false);
  const [runs,       setRuns]       = useState([]);
  const [view,       setView]       = useState("main");

  useEffect(() => {
    try {
      const h = localStorage.getItem("scout-history");
      if (h) { const v = JSON.parse(h); setPostHist(v); calcNext(v); }
      const r = localStorage.getItem("scout-runs");
      if (r) setRuns(JSON.parse(r));
    } catch {}
  }, []);

  const calcNext = (h) => {
    if (!h?.length) { setNextPost(null); return; }
    const d = new Date(h[h.length-1].date);
    d.setDate(d.getDate()+2);
    setNextPost(d);
  };

  const flash = msg => { setToast(msg); setTimeout(()=>setToast(""),3500); };

  const markPosted = async (deal) => {
    const entry = { title:deal.title, price:deal.price, date:new Date().toISOString() };
    const updated = [...postHist, entry];
    setPostHist(updated); calcNext(updated);
    try { localStorage.setItem("scout-history", JSON.stringify(updated)); } catch {}
    flash(`✓ "${deal.title}" logged`);
  };

  const runScout = useCallback(async () => {
    setMgBudget([]); setMgPremium([]); setYaBudget([]); setYaPremium([]);
    setMgError(""); setYaError("");
    setMgStatus("loading"); setYaStatus("loading");

    // ── Step 1: scout MG ──────────────────────────────────────────────────────
    let mgBudgetDeals = [], mgPremiumDeals = [], mgTokIn = 0, mgTokOut = 0;
    try {
      const r = await scoutCategory("mg");
      mgBudgetDeals = r.budgetDeals; mgPremiumDeals = r.premiumDeals;
      mgTokIn = r.tokensIn; mgTokOut = r.tokensOut;
      setMgBudget(mgBudgetDeals); setMgPremium(mgPremiumDeals);
      setMgStatus("done");
    } catch(e) {
      setMgError(e.message); setMgStatus("error");
    }

    // ── Step 2: scout YA, excluding MG-selected titles ────────────────────────
    const mgSelectedTitles = new Set([
      ...mgBudgetDeals.map(d => d.title.toLowerCase()),
      ...mgPremiumDeals.map(d => d.title.toLowerCase()),
    ]);

    let yaBudgetDeals = [], yaPremiumDeals = [], yaTokIn = 0, yaTokOut = 0;
    try {
      const r = await scoutCategory("ya", mgSelectedTitles);
      yaBudgetDeals = r.budgetDeals; yaPremiumDeals = r.premiumDeals;
      yaTokIn = r.tokensIn; yaTokOut = r.tokensOut;
      setYaBudget(yaBudgetDeals); setYaPremium(yaPremiumDeals);
      setYaStatus("done");
    } catch(e) {
      setYaError(e.message); setYaStatus("error");
    }

    // ── Step 3: save run history ──────────────────────────────────────────────
    const allDeals = [...mgBudgetDeals, ...mgPremiumDeals, ...yaBudgetDeals, ...yaPremiumDeals];
    if (allDeals.length) {
      const run = {
        id: Date.now(), date: new Date().toISOString(),
        mgDeals: [...mgBudgetDeals, ...mgPremiumDeals],
        yaDeals: [...yaBudgetDeals, ...yaPremiumDeals],
        tokensIn:  mgTokIn + yaTokIn,
        tokensOut: mgTokOut + yaTokOut,
      };
      setRuns(prev => {
        const updated = [run, ...prev].slice(0, 100);
        try { localStorage.setItem("scout-runs", JSON.stringify(updated)); } catch {}
        return updated;
      });
    }
  }, []);

  const deleteRun = (id) => {
    setRuns(prev => {
      const updated = prev.filter(r => r.id !== id);
      try { localStorage.setItem("scout-runs", JSON.stringify(updated)); } catch {}
      return updated;
    });
  };

  const today      = new Date();
  const canPost    = !nextPost || today >= nextPost;
  const daysUntil  = nextPost ? Math.max(0, Math.ceil((nextPost-today)/86400000)) : 0;
  const allDeals   = [...mgBudget, ...mgPremium, ...yaBudget, ...yaPremium];
  const hasResults = allDeals.length > 0;
  const loading    = mgStatus==="loading" || yaStatus==="loading";
  const totalPosts = allDeals.length * 3;

  const Section = ({ catId, budgetDeals, premiumDeals, status, error }) => {
    const cat = CATS.find(c=>c.id===catId);
    const total = budgetDeals.length + premiumDeals.length;
    return (
      <div style={{ flex:"1 1 340px", minWidth:0 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12,
          paddingBottom:8, borderBottom:`2px solid ${cat.accent}22` }}>
          <span>{cat.emoji}</span>
          <div style={{ flex:1 }}>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900,
              fontSize:"0.95rem", textTransform:"uppercase", letterSpacing:"0.05em", color:cat.accent }}>
              {cat.label}
            </div>
            <div style={{ fontFamily:"monospace", fontSize:"0.6rem", color:"#444" }}>
              {cat.age} · NYT Bestsellers · Live eBay
            </div>
          </div>
          {status==="loading" && (
            <div style={{ width:14, height:14, border:"2px solid #2a2a2a",
              borderTop:`2px solid ${cat.accent}`, borderRadius:"50%",
              animation:"spin 0.7s linear infinite", flexShrink:0 }} />
          )}
          {status==="done" && (
            <span style={{ fontFamily:"monospace", fontSize:"0.6rem", color:"#2a9d5c" }}>
              {total} deals
            </span>
          )}
        </div>

        {error && (
          <div style={{ background:"#1a0808", border:"1px solid #ff5f5f22",
            borderRadius:"4px", padding:"12px 14px", marginBottom:10 }}>
            <pre style={{ margin:0, color:"#ff5f5f", fontFamily:"monospace",
              fontSize:"0.7rem", whiteSpace:"pre-wrap", wordBreak:"break-word", lineHeight:1.6 }}>
              {error}
            </pre>
          </div>
        )}

        {status==="loading" && !total && (
          <div style={{ padding:"28px 0", textAlign:"center" }}>
            <div style={{ fontFamily:"monospace", fontSize:"0.7rem", color:"#333", marginBottom:4 }}>
              Searching NYT list + eBay prices…
            </div>
            <div style={{ fontFamily:"monospace", fontSize:"0.62rem", color:"#222" }}>
              This takes ~15–20 seconds
            </div>
          </div>
        )}

        {budgetDeals.length > 0 && (
          <div style={{ marginBottom:18 }}>
            <div style={{ fontFamily:"monospace", fontSize:"0.6rem", color:"#555",
              letterSpacing:"0.1em", marginBottom:8, textTransform:"uppercase" }}>
              💰 Budget Finds · Under $20
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              {budgetDeals.map((deal,i) => (
                <DealCard key={i} deal={deal} campid={campid} catId={catId}
                  idx={i} onPost={markPosted} />
              ))}
            </div>
          </div>
        )}

        {premiumDeals.length > 0 && (
          <div>
            <div style={{ fontFamily:"monospace", fontSize:"0.6rem", color:"#555",
              letterSpacing:"0.1em", marginBottom:8, textTransform:"uppercase" }}>
              ✨ Premium Picks · Under $200
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              {premiumDeals.map((deal,i) => (
                <DealCard key={i} deal={deal} campid={campid} catId={catId}
                  idx={i} onPost={markPosted} />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  if (view === "history") return (
    <HistoryPage runs={runs} onDelete={deleteRun}
      onBack={() => setView("main")} campid={campid} onPost={markPosted} />
  );

  return (
    <div style={{ minHeight:"100vh", background:"#0d0d0d", color:"#fff", fontFamily:"Georgia,serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&display=swap');
        @keyframes fadeUp { from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none} }
        @keyframes spin   { to{transform:rotate(360deg)} }
        * { box-sizing:border-box; }
        ::-webkit-scrollbar{width:4px} ::-webkit-scrollbar-thumb{background:#2a2a2a}
        button:hover{filter:brightness(1.1)}
      `}</style>

      {/* Header */}
      <div style={{ background:"linear-gradient(135deg,#111,#1a1200)", borderBottom:"2px solid #f0c040", padding:"14px 18px" }}>
        <div style={{ maxWidth:1100, margin:"0 auto", display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:10 }}>
          <div>
            <h1 style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:"clamp(1.2rem,3vw,1.7rem)",
              fontWeight:900, margin:0, textTransform:"uppercase", letterSpacing:"0.05em" }}>
              <span style={{ color:"#f0c040" }}>⚡</span> EPN Book Deal Scout
            </h1>
            <p style={{ margin:"2px 0 0", fontFamily:"monospace", fontSize:"0.62rem", color:"#555", letterSpacing:"0.07em" }}>
              NYT BESTSELLERS → LIVE EBAY PRICES → EPN LINKS → BUFFER
            </p>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <button onClick={() => setView("history")} style={{
              background:"transparent", color:"#555", border:"1px solid #2a2a2a",
              borderRadius:"3px", padding:"7px 12px", fontFamily:"monospace",
              fontSize:"0.67rem", fontWeight:800, cursor:"pointer", whiteSpace:"nowrap" }}>
              📋 HISTORY {runs.length > 0 && <span style={{ color:"#f0c040" }}>({runs.length})</span>}
            </button>
            <div style={{ background:canPost?"#0a1f12":"#1a1500",
              border:`1px solid ${canPost?"#2a9d5c33":"#f0c04033"}`,
              borderRadius:"5px", padding:"7px 12px", textAlign:"center" }}>
              <div style={{ fontFamily:"monospace", fontSize:"0.58rem", color:"#555", letterSpacing:"0.1em" }}>NEXT POST</div>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900,
                fontSize:"0.9rem", color:canPost?"#2a9d5c":"#f0c040" }}>
                {canPost ? "● TODAY" : `IN ${daysUntil}d`}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ maxWidth:1100, margin:"0 auto", padding:"16px 14px 60px" }}>

        {toast && (
          <div style={{ background:"#0a1f12", border:"1px solid #2a9d5c22", borderRadius:"4px",
            padding:"8px 14px", marginBottom:12, fontFamily:"monospace", fontSize:"0.75rem", color:"#2a9d5c" }}>
            {toast}
          </div>
        )}

        {/* EPN ID indicator */}
        <div style={{ fontFamily:"monospace", fontSize:"0.67rem", color:"#444",
          marginBottom:10, letterSpacing:"0.08em" }}>
          EPN CAMPAIGN ID:&nbsp;
          {campid
            ? <span style={{ color:"#2a9d5c" }}>{campid}</span>
            : <span style={{ color:"#ff5f5f" }}>⚠ NOT SET — affiliate links disabled</span>}
        </div>

        {/* Scout button */}
        <button onClick={runScout} disabled={loading} style={{
          padding:"8px 18px", marginBottom:14,
          fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:"0.82rem",
          textTransform:"uppercase", letterSpacing:"0.08em",
          background:loading?"#1a1a1a":"linear-gradient(90deg,#f0c040,#ff5f5f)",
          color:loading?"#2a2a2a":"#0d0d0d", border:"none", borderRadius:"4px",
          cursor:loading?"not-allowed":"pointer",
          display:"flex", alignItems:"center", justifyContent:"center", gap:8,
        }}>
          {loading
            ? <><div style={{ width:13, height:13, border:"2px solid #2a2a2a",
                borderTop:"2px solid #666", borderRadius:"50%", animation:"spin 0.7s linear infinite" }} />
                SEARCHING NYT + EBAY (~20 SECONDS)…</>
            : "⚡ SCOUT: NYT BESTSELLERS → LIVE EBAY DEALS"}
        </button>

        {/* Export bar */}
        {hasResults && (
          <div style={{ background:"#111", border:"1px solid #1e1e1e", borderRadius:"5px",
            padding:"10px 14px", marginBottom:14,
            display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:8 }}>
            <div style={{ fontFamily:"monospace", fontSize:"0.67rem", color:"#555" }}>
              {allDeals.length} DEALS · 3 ANGLES ·{" "}
              <span style={{ color:"#f0c040" }}>{totalPosts} POSTS</span> · ~{totalPosts*2} DAYS
            </div>
            <button onClick={()=>setShowExport(true)} style={{ background:"#1e1e1e", color:"#f0c040",
              border:"1px solid #f0c04022", borderRadius:"3px", padding:"6px 14px",
              fontFamily:"monospace", fontWeight:800, fontSize:"0.68rem", cursor:"pointer", whiteSpace:"nowrap" }}>
              📤 EXPORT {totalPosts} POSTS FOR BUFFER
            </button>
          </div>
        )}

        {/* Results */}
        <div style={{ display:"flex", gap:18, flexWrap:"wrap", alignItems:"flex-start" }}>
          <Section catId="mg" budgetDeals={mgBudget} premiumDeals={mgPremium} status={mgStatus} error={mgError} />
          <Section catId="ya" budgetDeals={yaBudget} premiumDeals={yaPremium} status={yaStatus} error={yaError} />
        </div>

        {/* History */}
        {postHist.length > 0 && (
          <div style={{ marginTop:24, background:"#111", border:"1px solid #1a1a1a",
            borderRadius:"5px", padding:"12px 14px" }}>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontWeight:800, fontSize:"0.78rem",
              textTransform:"uppercase", letterSpacing:"0.08em", color:"#333", marginBottom:8 }}>
              POST HISTORY
            </div>
            {[...postHist].reverse().slice(0,8).map((p,i) => (
              <div key={i} style={{ display:"flex", gap:8, fontFamily:"monospace", fontSize:"0.67rem",
                color:"#333", borderBottom:"1px solid #141414", paddingBottom:3, marginBottom:3 }}>
                <span style={{ flex:1, color:"#555", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.title}</span>
                <span style={{ color:"#f0c040", flexShrink:0 }}>{p.price}</span>
                <span style={{ flexShrink:0 }}>{new Date(p.date).toLocaleDateString("en-US",{month:"short",day:"numeric"})}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {showExport && (
        <ExportPanel mgDeals={[...mgBudget,...mgPremium]} yaDeals={[...yaBudget,...yaPremium]} campid={campid} onClose={()=>setShowExport(false)} />
      )}
    </div>
  );
}

import { useState, useEffect, useCallback } from "react";

// ─── Constants ────────────────────────────────────────────────────────────────
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
const WORKER = "https://finddeals.trovescore.com/";

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
    urgency: `⚡ "${deal.title}" — ${deal.price} on eBay (${deal.condition})`,
    social:  `📚 ${rank}: "${deal.title}" — only ${deal.price} on eBay`,
    gift:    `🎁 Perfect gift for ${cat.ageShort}: "${deal.title}" — ${deal.price}`,
  };
  const body = (bodies[angleId] || bodies.urgency).slice(0, 100);
  return `${body}\n${link}\n${tags}`;
};

// ─── Worker fetch helpers ─────────────────────────────────────────────────────
const toTitleCase = s => s.toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());

async function fetchNYT(listNames) {
  for (const list of listNames) {
    let res;
    try { res = await fetch(`${WORKER.replace(/\/$/, "")}/nyt?list=${encodeURIComponent(list)}`); }
    catch { throw new Error("Cannot reach worker. Check the WORKER URL."); }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`NYT API key rejected (${res.status}). Go to Cloudflare Worker → Settings → Variables and set NYT_API_KEY as an encrypted secret.`);
    }
    if (!res.ok) continue;
    const data = await res.json();
    const books = data.results?.books;
    if (books?.length) return books;
  }
  throw new Error("No books found on any NYT list. The list names may have changed — check the NYT Books API docs.");
}

async function fetchEbay(query) {
  let res;
  try { res = await fetch(`${WORKER.replace(/\/$/, "")}/ebay?q=${encodeURIComponent(query)}`); }
  catch { return []; }
  if (res.status === 401 || res.status === 403) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`eBay API key rejected (${res.status}). ${err.detail || "Check EBAY_APP_ID secret."}`);
  }
  if (!res.ok) return [];
  const data = await res.json();
  return data?.findItemsByKeywordsResponse?.[0]?.searchResult?.[0]?.item || [];
}

// ─── Scout: NYT list → eBay prices → scored deals ────────────────────────────
async function scoutCategory(catId) {
  const listNames = catId === "mg"
    ? ["middle-grade", "childrens-middle-grade", "chapter-books"]
    : ["young-adult"];

  const nytBooks = await fetchNYT(listNames);

  const results = await Promise.all(
    nytBooks.slice(0, 10).map(async (book) => {
      const items = await fetchEbay(book.title);
      const scored = items
        .map(item => {
          const priceStr = item.sellingStatus?.[0]?.currentPrice?.[0]?.["__value__"];
          if (!priceStr) return null;
          const price = parseFloat(priceStr);
          if (price > 20) return null;
          const condId = item.condition?.[0]?.conditionId?.[0] || "4000";
          const condScore = { "1000": 5, "2500": 4, "3000": 3, "4000": 2 }[condId] || 1;
          const priceScore = price <= 8 ? 5 : price <= 12 ? 4 : price <= 18 ? 3 : 2;
          return {
            title: toTitleCase(book.title),
            author: book.author,
            price: `$${price.toFixed(2)}`,
            priceRaw: price,
            condition: item.condition?.[0]?.conditionDisplayName?.[0] || "Used",
            ebayUrl: item.viewItemURL?.[0] || "",
            description: book.description || "",
            dealScore: priceScore * 2 + condScore,
            nytRank: book.rank,
            nytWeeks: book.weeks_on_list,
          };
        })
        .filter(Boolean);

      if (!scored.length) return null;
      return scored.sort((a, b) => b.dealScore - a.dealScore)[0];
    })
  );

  const deals = results
    .filter(d => d && d.dealScore >= 3 && d.ebayUrl.includes("ebay.com"))
    .sort((a, b) => b.dealScore - a.dealScore)
    .slice(0, 5);

  if (!deals.length) throw new Error("No deals found scoring 3+. Try again or check eBay inventory.");
  return deals;
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
            color:deal.priceRaw<=10?"#2a9d5c":deal.priceRaw<=15?"#f0c040":"#fff", lineHeight:1 }}>
            {deal.price}
          </div>
          <div style={{ fontFamily:"monospace", fontSize:"0.58rem", color:"#444", marginTop:1 }}>LIVE PRICE</div>
        </div>
      </div>

      {/* Badges */}
      <div style={{ display:"flex", gap:5, flexWrap:"wrap", alignItems:"center" }}>
        {deal.priceRaw <= 10 && <Badge color="#2a9d5c">🔥 UNDER $10</Badge>}
        {deal.priceRaw > 10 && deal.priceRaw <= 15 && <Badge color="#f0c040">GOOD PRICE</Badge>}
        {deal.condition==="New" && <Badge color="#5fafff">NEW</Badge>}
        {deal.condition==="Like New" && <Badge color="#5fafff">LIKE NEW</Badge>}
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

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [campid,     setCampid]     = useState("");
  const [campSaved,  setCampSaved]  = useState(false);
  const [mgDeals,    setMgDeals]    = useState([]);
  const [yaDeals,    setYaDeals]    = useState([]);
  const [mgStatus,   setMgStatus]   = useState("idle");
  const [yaStatus,   setYaStatus]   = useState("idle");
  const [mgError,    setMgError]    = useState("");
  const [yaError,    setYaError]    = useState("");
  const [postHist,   setPostHist]   = useState([]);
  const [nextPost,   setNextPost]   = useState(null);
  const [toast,      setToast]      = useState("");
  const [showExport, setShowExport] = useState(false);

  useEffect(() => {
    try {
      const k = localStorage.getItem("scout-campid");
      if (k) { setCampid(k); setCampSaved(true); }
      const h = localStorage.getItem("scout-history");
      if (h) { const v = JSON.parse(h); setPostHist(v); calcNext(v); }
    } catch {}
  }, []);

  const calcNext = (h) => {
    if (!h?.length) { setNextPost(null); return; }
    const d = new Date(h[h.length-1].date);
    d.setDate(d.getDate()+2);
    setNextPost(d);
  };

  const flash = msg => { setToast(msg); setTimeout(()=>setToast(""),3500); };

  const saveCampid = async () => {
    if (!campid.trim()) return;
    try { localStorage.setItem("scout-campid", campid.trim()); } catch {}
    setCampSaved(true); flash("EPN Campaign ID saved ✓");
  };

  const markPosted = async (deal) => {
    const entry = { title:deal.title, price:deal.price, date:new Date().toISOString() };
    const updated = [...postHist, entry];
    setPostHist(updated); calcNext(updated);
    try { localStorage.setItem("scout-history", JSON.stringify(updated)); } catch {}
    flash(`✓ "${deal.title}" logged`);
  };

  const runScout = useCallback(async () => {
    setMgDeals([]); setYaDeals([]);
    setMgError(""); setYaError("");
    setMgStatus("loading"); setYaStatus("loading");

    const runCat = async (catId) => {
      const setDeals  = catId==="mg" ? setMgDeals : setYaDeals;
      const setStatus = catId==="mg" ? setMgStatus : setYaStatus;
      const setError  = catId==="mg" ? setMgError  : setYaError;
      try {
        const deals = await scoutCategory(catId);
        if (!deals.length) throw new Error("No deals returned — Claude may not have found eBay listings. Try again.");
        setDeals(deals);
        setStatus("done");
      } catch(e) {
        setError(e.message);
        setStatus("error");
      }
    };

    await Promise.all([runCat("mg"), runCat("ya")]);
  }, []);

  const today      = new Date();
  const canPost    = !nextPost || today >= nextPost;
  const daysUntil  = nextPost ? Math.max(0, Math.ceil((nextPost-today)/86400000)) : 0;
  const hasResults = mgDeals.length > 0 || yaDeals.length > 0;
  const loading    = mgStatus==="loading" || yaStatus==="loading";
  const totalPosts = (mgDeals.length + yaDeals.length) * 3;
  const mgDates    = [0,2,4,6,8].map(n=>{const d=new Date(today);d.setDate(d.getDate()+n);return d;});
  const yaDates    = [1,3,5,7,9].map(n=>{const d=new Date(today);d.setDate(d.getDate()+n);return d;});

  const Section = ({ catId, deals, status, error, schedDates }) => {
    const cat = CATS.find(c=>c.id===catId);
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
              {deals.length} deals
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

        {status==="loading" && !deals.length && (
          <div style={{ padding:"28px 0", textAlign:"center" }}>
            <div style={{ fontFamily:"monospace", fontSize:"0.7rem", color:"#333", marginBottom:4 }}>
              Searching NYT list + eBay prices…
            </div>
            <div style={{ fontFamily:"monospace", fontSize:"0.62rem", color:"#222" }}>
              This takes ~5–10 seconds
            </div>
          </div>
        )}

        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {deals.map((deal,i) => (
            <DealCard key={i} deal={deal} campid={campid} catId={catId}
              idx={i} onPost={markPosted} schedDate={schedDates[i]} />
          ))}
        </div>
      </div>
    );
  };

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

      <div style={{ maxWidth:1100, margin:"0 auto", padding:"16px 14px 60px" }}>

        {toast && (
          <div style={{ background:"#0a1f12", border:"1px solid #2a9d5c22", borderRadius:"4px",
            padding:"8px 14px", marginBottom:12, fontFamily:"monospace", fontSize:"0.75rem", color:"#2a9d5c" }}>
            {toast}
          </div>
        )}

        {/* EPN Campaign ID */}
        <div style={{ background:"#111", border:`1px solid ${campSaved?"#1e1e1e":"#f0c04033"}`,
          borderRadius:"6px", padding:"12px 16px", marginBottom:14,
          display:"flex", gap:10, alignItems:"flex-end", flexWrap:"wrap" }}>
          <div style={{ flex:1, minWidth:200 }}>
            <label style={{ display:"block", fontFamily:"monospace", fontSize:"0.62rem",
              color:"#555", letterSpacing:"0.1em", marginBottom:4 }}>
              EPN CAMPAIGN ID {campSaved && <span style={{ color:"#2a9d5c" }}>✓ SAVED</span>}
            </label>
            <input value={campid} onChange={e=>{setCampid(e.target.value);setCampSaved(false);}}
              placeholder="5338XXXXXXXXXX"
              style={{ width:"100%", background:"#0d0d0d", border:"1px solid #2a2a2a",
                color:"#fff", padding:"7px 11px", borderRadius:"3px",
                fontFamily:"monospace", fontSize:"0.82rem" }} />
          </div>
          <button onClick={saveCampid} style={{ background:"#f0c040", color:"#0d0d0d", border:"none",
            borderRadius:"3px", padding:"7px 14px", fontFamily:"monospace", fontWeight:800,
            fontSize:"0.72rem", cursor:"pointer", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>
            SAVE
          </button>
          {!campSaved && (
            <span style={{ fontFamily:"monospace", fontSize:"0.62rem", color:"#ff5f5f", alignSelf:"center" }}>
              ⚠ Add your EPN ID for affiliate links
            </span>
          )}
        </div>

        {/* Scout button */}
        <button onClick={runScout} disabled={loading} style={{
          width:"100%", padding:"13px", marginBottom:14,
          fontFamily:"'Barlow Condensed',sans-serif", fontWeight:900, fontSize:"1rem",
          textTransform:"uppercase", letterSpacing:"0.08em",
          background:loading?"#1a1a1a":"linear-gradient(90deg,#f0c040,#ff5f5f)",
          color:loading?"#2a2a2a":"#0d0d0d", border:"none", borderRadius:"4px",
          cursor:loading?"not-allowed":"pointer",
          display:"flex", alignItems:"center", justifyContent:"center", gap:8,
        }}>
          {loading
            ? <><div style={{ width:13, height:13, border:"2px solid #2a2a2a",
                borderTop:"2px solid #666", borderRadius:"50%", animation:"spin 0.7s linear infinite" }} />
                SEARCHING NYT + EBAY (~10 SECONDS)…</>
            : "⚡ SCOUT: NYT BESTSELLERS → LIVE EBAY DEALS"}
        </button>

        {/* Export bar */}
        {hasResults && (
          <div style={{ background:"#111", border:"1px solid #1e1e1e", borderRadius:"5px",
            padding:"10px 14px", marginBottom:14,
            display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:8 }}>
            <div style={{ fontFamily:"monospace", fontSize:"0.67rem", color:"#555" }}>
              {mgDeals.length+yaDeals.length} DEALS · 3 ANGLES ·{" "}
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
          <Section catId="mg" deals={mgDeals} status={mgStatus} error={mgError} schedDates={mgDates} />
          <Section catId="ya" deals={yaDeals} status={yaStatus} error={yaError} schedDates={yaDates} />
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
        <ExportPanel mgDeals={mgDeals} yaDeals={yaDeals} campid={campid} onClose={()=>setShowExport(false)} />
      )}
    </div>
  );
}

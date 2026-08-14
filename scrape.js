/**
 * Shopping App — nightly price scraper (v0.03)
 * -------------------------------------------------------------
 * Builds the price-feed JSON the PWA reads (pwa/data/prices.json).
 * Runs in GitHub Actions (see .github/workflows/update-prices.yml)
 * and writes scraper/prices.json + pwa/data/prices.json.
 *
 * STORES
 *   Aldi        — LIVE, no auth. Special Buys are server-rendered on
 *                 https://www.aldi.com.au/special-buys/{YYYY-MM-DD};
 *                 we extract the product tiles (name, price, size) and
 *                 fuzzy-match them to our catalogue.
 *   Woolworths  — POST https://www.woolworths.com.au/apis/ui/Search/products
 *                 (confirmed endpoint). Blocked by Akamai for datacenter IPs
 *                 (HTTP 403) unless a session cookie is provided via the
 *                 WOOL_COOKIE repo secret. See AGENT_HANDOFF_INSTRUCTIONS.
 *   Coles       — Next.js site behind Imperva Incapsula. Data route:
 *                 /_next/data/{buildId}/search/products.json?q={query},
 *                 requires a browser session cookie via COLES_COOKIE.
 *
 * FAILURE HANDLING: each store is fetched independently. On any failure the
 * last-known-good prices for that store are kept and flagged "stale"; the app
 * keeps working. Personal-use only — do not redistribute scraped data.
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOGUE = JSON.parse(readFileSync(join(__dirname, "catalogue.json"), "utf8"));
const OUT_FEED = join(__dirname, "prices.json");
const PWA_FEED = join(__dirname, "..", "pwa", "data", "prices.json");
const CURRENCY = "AUD";

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const HTTP_TIMEOUT = Number(process.env.HTTP_TIMEOUT || 20000);

class Blocked extends Error {}

async function fetchTO(url, opts = {}, ms = HTTP_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

function num(v) {
  if (v === undefined || v === null) return null;
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.]/g, "")) : v;
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

/* ------------------------------------------------------------------ */
/* Text helpers for fuzzy-matching catalogue items                     */
/* ------------------------------------------------------------------ */
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim().split(" ");

/* Qualifier words that may appear around a matched item in an Aldi tile
   name ("Italian Style Pork & Beef Sausages 1kg"). Deliberately excludes
   nouns like "gift"/"box"/"bar" so false matches don't slip through. */
const ALLOW = new Set(["pack","family","share","bag","block","blocks","strips","strip","premium","original","classic","italian","style","sweet","salted","extra","light","lite","full","cream","free","range","dried","tinned","canned","frozen","wild","instant","quick","long","grain","baby","whole","washed","loose","brown","red","white","green","yellow","black","blue","purple","pink","orange","sliced","diced","chopped","ground","grated","shredded","selection","quality","mix","bites","pieces","fillets","fillet","breast","breasts","thigh","thighs","mince","minced","lean","star","beef","pork","chicken","lamb","eggs","dozen","fresh","raw","cooked","large","small","medium","with","of","a","an","the","and"]);

const aliasesByItem = new Map();
for (const c of CATALOGUE) {
  const set = new Set([c.name.toLowerCase(), ...(c.aliases || []).map(a => a.toLowerCase())]);
  aliasesByItem.set(c.id, set);
}

function matchCatalogue(tileName) {
  const nw = norm(tileName);
  if (!nw.length) return null;
  let best = null, bestLen = 0;
  for (const [id, aliases] of aliasesByItem) {
    for (const alias of aliases) {
      const aw = norm(alias);
      if (!aw.length) continue;
      if (aw.every(t => nw.includes(t))) {
        const leftover = nw.filter(t => !aw.includes(t));
        const ok = leftover.every(t => /^\d/.test(t) || t === "g" || t === "kg" || t === "ml" || t === "l" || t === "pack" || ALLOW.has(t));
        if (ok && aw.length > bestLen) { best = id; bestLen = aw.length; }
      }
    }
  }
  return best;
}

/* Parse a pack size out of a tile name, e.g. "1kg", "300g", "2L", "5 Pack". */
function parseSize(name) {
  const m = (name || "").match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/i);
  if (m) {
    const v = parseFloat(m[1]);
    const u = m[2].toLowerCase();
    if (u === "g") return { q: v / 1000, u: "kg" };
    if (u === "ml") return { q: v / 1000, u: "L" };
    return { q: v, u };
  }
  const p = (name || "").match(/(\d+)\s*pack\b/i);
  if (p) return { q: parseInt(p[1], 10), u: "each" };
  return { q: 1, u: "each" };
}

/* ------------------------------------------------------------------ */
/* ALDI — live Special Buys (no auth)                                  */
/* ------------------------------------------------------------------ */
async function fetchText(url) {
  const res = await fetchTO(url, { headers: { "user-agent": UA, "accept": "text/html,application/json" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}

function extractAldiTiles(htmlText) {
  const out = [];
  const parts = htmlText.split('product-tile__name');
  for (let i = 1; i < parts.length; i++) {
    const t = parts[i];
    const nm = t.match(/<p aria-label="([^"]*),?"/);
    const name = nm ? nm[1].replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").trim().replace(/,$/, "") : null;
    const pr = t.match(/base-price__regular"><span>\$([\d.]+)/);
    const price = pr ? parseFloat(pr[1]) : null;
    if (name && price !== null) out.push({ name, price });
  }
  return out;
}

async function scrapeAldi() {
  const landing = await fetchText("https://www.aldi.com.au/special-buys");
  const dates = [...new Set([...landing.matchAll(/\/special-buys\/(\d{4}-\d{2}-\d{2})/g)].map(m => m[1]))].sort();
  if (dates.length === 0) throw new Error("aldi: no special-buys dates found on landing page");
  const waves = dates.slice(0, 3); // current + next two waves
  const byId = new Map();          // catalogue id -> special (earliest wave wins)
  for (const d of waves) {
    let htmlText;
    try { htmlText = await fetchText(`https://www.aldi.com.au/special-buys/${d}`); }
    catch (e) { console.warn("aldi: wave", d, "failed —", e.message); continue; }
    const tiles = extractAldiTiles(htmlText);
    for (const tile of tiles) {
      const id = matchCatalogue(tile.name);
      if (!id) continue;
      if (!byId.has(id)) {
        const { q, u } = parseSize(tile.name);
        byId.set(id, { id, name: tile.name, price: tile.price, q, u, note: "Special Buy", until: d });
      }
    }
    await sleep(300);
  }
  const specials = [...byId.values()];
  if (specials.length === 0) throw new Error("aldi: no specials matched the catalogue this week");
  return specials;
}

/* ------------------------------------------------------------------ */
/* WOOLWORTHS — full-line prices (needs WOOL_COOKIE)                   */
/* ------------------------------------------------------------------ */
async function scrapeWoolworths(items, cookie) {
  const url = "https://www.woolworths.com.au/apis/ui/Search/products";
  const results = [];
  for (const item of items) {
    try {
      const body = JSON.stringify({
        Filters: [],
        IsSpecial: false,
        Location: `/shop/search/products?searchTerm=${encodeURIComponent(item.search)}`,
        PageNumber: 1,
        PageSize: 36,
        SearchTerm: item.search,
        SortType: "TraderRelevance",
        IsHideUnavailableProducts: false
      });
      const headers = {
        "content-type": "application/json",
        "accept": "application/json",
        "origin": "https://www.woolworths.com.au",
        "referer": "https://www.woolworths.com.au/",
        "user-agent": UA
      };
      if (cookie) headers.cookie = cookie;
      const res = await fetchTO(url, { method: "POST", headers, body });
      if (res.status === 403) throw new Blocked("Akamai blocked (403) — add the WOOL_COOKIE repo secret");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const products = data.Products || data.SearchResults || (data.searchResults && data.searchResults.Results) || [];
      const best = products.find(p => ((p.Name || p.DisplayName || "").toLowerCase()).includes(item.search.toLowerCase())) || products[0];
      if (best) {
        results.push({
          id: item.id,
          name: best.Name || best.DisplayName || item.name,
          price: num(best.Price),
          wasPrice: num(best.WasPrice),
          onSpecial: !!(best.IsSpecial || (best.WasPrice && best.WasPrice > best.Price))
        });
      }
      await sleep(250 + Math.random() * 250);
    } catch (err) {
      if (err instanceof Blocked || err.name === "AbortError") throw new Blocked("request timed out / blocked — add the WOOL_COOKIE repo secret");
      console.warn("woolworths: failed for", item.id, "-", err.message);
    }
  }
  if (results.length === 0) throw new Error("woolworths: no results — blocked or endpoint changed");
  return results;
}

/* ------------------------------------------------------------------ */
/* COLES — full-line prices (needs COLES_COOKIE)                       */
/* ------------------------------------------------------------------ */
async function scrapeColes(items, cookie) {
  const home = await fetchText("https://www.coles.com.au/");
  const bm = home.match(/"buildId":"([^"]+)"/);
  if (!bm) throw new Error("coles: could not read Next.js buildId (bot challenge?)");
  const buildId = bm[1];
  const results = [];
  for (const item of items) {
    try {
      const dataUrl = `https://www.coles.com.au/_next/data/${buildId}/search/products.json?q=${encodeURIComponent(item.search)}`;
      const headers = { "user-agent": UA, "accept": "application/json" };
      if (cookie) headers.cookie = cookie;
      const res = await fetchTO(dataUrl, { headers });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      if (/Incapsula|main-iframe|Access Denied/i.test(text)) throw new Blocked("bot challenge — add the COLES_COOKIE repo secret");
      const data = JSON.parse(text);
      const pp = data.pageProps || {};
      const products = pp.searchResults && pp.searchResults.products ||
        pp.products || pp.searchProducts || pp.items || [];
      const best = products.find(p => ((p.name || p.productName || "").toLowerCase()).includes(item.search.toLowerCase())) || products[0];
      if (best) {
        results.push({
          id: item.id,
          name: best.name || best.productName || item.name,
          price: num(best.price ?? best.nowPrice ?? (best.pricing && best.pricing.now)),
          wasPrice: num(best.wasPrice ?? (best.pricing && best.pricing.was)),
          onSpecial: !!(best.onSpecial || (best.wasPrice && best.wasPrice > best.price))
        });
      }
      await sleep(250 + Math.random() * 250);
    } catch (err) {
      if (err instanceof Blocked || err.name === "AbortError") throw new Blocked("request timed out / blocked — add the COLES_COOKIE repo secret");
      console.warn("coles: failed for", item.id, "-", err.message);
    }
  }
  if (results.length === 0) throw new Error("coles: no results — blocked or endpoint changed");
  return results;
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */
function loadLastGood() {
  for (const p of [PWA_FEED, OUT_FEED]) {
    try { if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")); } catch (e) {}
  }
  return { stores: {} };
}

async function main() {
  const lastGood = loadLastGood();
  const feed = {
    generatedAt: nowIso(),
    status: "ok",
    currency: CURRENCY,
    stores: {
      coles: lastGood.stores.coles || {},
      woolworths: lastGood.stores.woolworths || {},
      aldi: lastGood.stores.aldi || {}
    }
  };
  let okCount = 0;

  // Aldi (live)
  try {
    const specials = await scrapeAldi();
    feed.stores.aldi = { source: "specials-catalogue", asOf: nowIso(), specials };
    okCount++;
    console.log("aldi: ok —", specials.length, "specials:", specials.map(s => `${s.id} @ $${s.price}`).join(", "));
  } catch (err) {
    console.warn("aldi: stale —", err.message);
    if (feed.stores.aldi && feed.stores.aldi.asOf) feed.stores.aldi.stale = true;
    else feed.stores.aldi = { source: "unavailable", stale: true, specials: [] };
  }

  // Woolworths
  try {
    const items = await scrapeWoolworths(CATALOGUE, process.env.WOOL_COOKIE || "");
    feed.stores.woolworths = { source: "scraped", asOf: nowIso(), items };
    okCount++;
    console.log("woolworths: ok —", items.length, "items");
  } catch (err) {
    console.warn("woolworths: stale —", err.message);
    if (feed.stores.woolworths && feed.stores.woolworths.asOf) feed.stores.woolworths.stale = true;
    else feed.stores.woolworths = { source: "unavailable", stale: true, items: [] };
  }

  // Coles
  try {
    const items = await scrapeColes(CATALOGUE, process.env.COLES_COOKIE || "");
    feed.stores.coles = { source: "scraped", asOf: nowIso(), items };
    okCount++;
    console.log("coles: ok —", items.length, "items");
  } catch (err) {
    console.warn("coles: stale —", err.message);
    if (feed.stores.coles && feed.stores.coles.asOf) feed.stores.coles.stale = true;
    else feed.stores.coles = { source: "unavailable", stale: true, items: [] };
  }

  feed.status = okCount > 0 ? "ok" : "stale";

  writeFileSync(OUT_FEED, JSON.stringify(feed, null, 2));
  writeFileSync(PWA_FEED, JSON.stringify(feed, null, 2));
  console.log("feed written. status:", feed.status, "| fresh stores:", Object.keys(feed.stores).filter(s => !feed.stores[s].stale));
}

main().catch(err => { console.error("scraper crashed:", err); process.exit(1); });

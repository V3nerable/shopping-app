/**
 * Shopping App — nightly price scraper (v0.01)
 * -------------------------------------------------------------
 * Fetches Coles + Woolworths full-line prices and the Aldi weekly
 * Special Buys catalogue, normalises them into the price-feed JSON
 * that the PWA reads (pwa/data/prices.json), and writes the result
 * to scraper/prices.json. The GitHub workflow commits that file to
 * the repo, which triggers a Netlify redeploy.
 *
 * DESIGN: "targeted" scraping — we only refresh prices for the
 * curated catalogue (scraper/catalogue.json), not the whole store.
 *
 * HONESTY NOTE: Coles/Woolworths/Aldi have no official public API.
 * This script uses the same JSON endpoints their websites call.
 * These endpoints change and are bot-protected — the functions below
 * are a working skeleton with the current known request shapes; each
 * store fetcher is defensive and marks that store "stale" (keeping
 * the last good prices) on any failure. See AGENT_HANDOFF_INSTRUCTIONS.md.
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

/* ------------------------------------------------------------------ */
/* COLES                                                               */
/* Endpoint: website search API. VERIFY against a live session; if the */
/* shape changed, update the path/headers/body here.                   */
/* ------------------------------------------------------------------ */
async function scrapeColes(items, cookie) {
  const url = "https://www.coles.com.au/api/products/search";
  const headers = {
    "content-type": "application/json",
    "accept": "application/json",
    "origin": "https://www.coles.com.au",
    "referer": "https://www.coles.com.au/",
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
  };
  if (cookie) headers.cookie = cookie;

  const results = [];
  for (const item of items) {
    try {
      const body = JSON.stringify({
        query: item.search,
        pageSize: 24,
        includeProductDetails: true
      });
      const res = await fetch(url, { method: "POST", headers, body });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      // Coles response shapes vary by endpoint revision; try common ones.
      const products =
        (data.products) ||
        (data.results && data.results.products) ||
        (data.searchResults && data.searchResults.results) ||
        (data.productsPayload && data.productsPayload.products) ||
        [];
      const best = products.find(p => {
        const n = (p.name || p.brand || "").toLowerCase();
        return n.includes(item.search.toLowerCase());
      }) || products[0];
      if (best) {
        results.push({
          id: item.id,
          name: best.name || item.name,
          price: num(best.price || best.nowPrice || best.pricing && best.pricing.now),
          wasPrice: num(best.wasPrice || best.pricing && best.pricing.was),
          onSpecial: !!(best.badges && best.badges.find(b => /special|down/i.test(b))),
          promo: (best.badges && best.badges.join(", ")) || null
        });
      }
      await sleep(400 + Math.random() * 400);
    } catch (err) {
      console.warn("coles: failed for", item.id, "-", err.message);
    }
  }
  if (results.length === 0) throw new Error("coles: no results — endpoint likely changed or blocked");
  return results;
}

/* ------------------------------------------------------------------ */
/* WOOLWORTHS                                                          */
/* ------------------------------------------------------------------ */
async function scrapeWoolworths(items, cookie) {
  const url = "https://www.woolworths.com.au/apis/ui/Search/products";
  const headers = {
    "content-type": "application/json",
    "accept": "application/json",
    "origin": "https://www.woolworths.com.au",
    "referer": "https://www.woolworths.com.au/",
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
  };
  if (cookie) headers.cookie = cookie;

  const results = [];
  for (const item of items) {
    try {
      const body = JSON.stringify({
        searchTerm: item.search,
        pageNumber: 1,
        pageSize: 36,
        isSpecial: false,
        sortType: "TraderRelevance"
      });
      const res = await fetch(url, { method: "POST", headers, body });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const products =
        (data.Products) ||
        (data.SearchResults) ||
        (data.searchResults && data.searchResults.Results) ||
        [];
      const best = products.find(p => {
        const n = (p.Name || p.DisplayName || "").toLowerCase();
        return n.includes(item.search.toLowerCase());
      }) || products[0];
      if (best) {
        results.push({
          id: item.id,
          name: best.Name || best.DisplayName || item.name,
          price: num(best.Price),
          wasPrice: num(best.WasPrice),
          onSpecial: !!(best.IsSpecial || best.WasPrice && best.WasPrice > best.Price)
        });
      }
      await sleep(400 + Math.random() * 400);
    } catch (err) {
      console.warn("woolworths: failed for", item.id, "-", err.message);
    }
  }
  if (results.length === 0) throw new Error("woolworths: no results — endpoint likely changed or blocked");
  return results;
}

/* ------------------------------------------------------------------ */
/* ALDI — weekly Special Buys only (no full-line e-commerce in AU)     */
/* ------------------------------------------------------------------ */
async function scrapeAldi() {
  // Aldi Special Buys rotate Wed/Sat. The public special-buys JSON feed
  // is the target; it changes frequently and may need a session token.
  const url = "https://www.aldi.com.au/api/specialbuys/current";
  try {
    const res = await fetch(url, {
      headers: { "accept": "application/json", "user-agent": "Mozilla/5.0" }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const deals = data.specialBuys || data.items || data.products || [];
    const out = [];
    for (const d of deals) {
      const name = (d.name || d.title || "").toLowerCase();
      const hit = CATALOGUE.find(c => c.aliases.some(a => name.includes(a)) || name.includes(c.search.toLowerCase()));
      if (hit) {
        out.push({
          id: hit.id,
          name: hit.name,
          price: num(d.price),
          size: d.size || d.unit || "",
          until: d.endDate || d.until || null,
          note: "Special Buy"
        });
      }
    }
    if (out.length === 0) throw new Error("aldi: no matching specials parsed");
    return out;
  } catch (err) {
    console.warn("aldi:", err.message, "— Aldi specials will be marked stale.");
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* Normalisation + persistence                                        */
/* ------------------------------------------------------------------ */
function num(v) {
  if (v === undefined || v === null) return null;
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.]/g, "")) : v;
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

function loadLastGood() {
  for (const p of [PWA_FEED, OUT_FEED]) {
    try { if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")); } catch (e) {}
  }
  return { stores: {} };
}

async function main() {
  const lastGood = loadLastGood();
  const colesCookie = process.env.COLES_COOKIE || "";
  const woolCookie = process.env.WOOL_COOKIE || "";

  const feed = {
    generatedAt: nowIso(),
    status: "ok",
    currency: CURRENCY,
    stores: { coles: lastGood.stores.coles || {}, woolworths: lastGood.stores.woolworths || {}, aldi: lastGood.stores.aldi || {} }
  };

  let okCount = 0;

  // Coles
  try {
    const items = await scrapeColes(CATALOGUE, colesCookie);
    feed.stores.coles = { source: "scraped", asOf: nowIso(), items };
    okCount++;
    console.log("coles: ok —", items.length, "items");
  } catch (err) {
    console.warn("coles: stale —", err.message);
    if (feed.stores.coles && feed.stores.coles.asOf) feed.stores.coles.stale = true;
    else feed.stores.coles = { source: "unavailable", stale: true, items: [] };
  }

  // Woolworths
  try {
    const items = await scrapeWoolworths(CATALOGUE, woolCookie);
    feed.stores.woolworths = { source: "scraped", asOf: nowIso(), items };
    okCount++;
    console.log("woolworths: ok —", items.length, "items");
  } catch (err) {
    console.warn("woolworths: stale —", err.message);
    if (feed.stores.woolworths && feed.stores.woolworths.asOf) feed.stores.woolworths.stale = true;
    else feed.stores.woolworths = { source: "unavailable", stale: true, items: [] };
  }

  // Aldi
  try {
    const specials = await scrapeAldi();
    feed.stores.aldi = { source: "specials-catalogue", asOf: nowIso(), specials };
    okCount++;
    console.log("aldi: ok —", specials.length, "specials");
  } catch (err) {
    console.warn("aldi: stale —", err.message);
    if (feed.stores.aldi && feed.stores.aldi.asOf) feed.stores.aldi.stale = true;
    else feed.stores.aldi = { source: "unavailable", stale: true, specials: [] };
  }

  feed.status = okCount > 0 ? "ok" : "stale";

  writeFileSync(OUT_FEED, JSON.stringify(feed, null, 2));
  writeFileSync(PWA_FEED, JSON.stringify(feed, null, 2));
  console.log("feed written:", JSON.stringify({ status: feed.status, stores: Object.keys(feed.stores).filter(s => !feed.stores[s].stale) }));
}

main().catch(err => { console.error("scraper crashed:", err); process.exit(1); });

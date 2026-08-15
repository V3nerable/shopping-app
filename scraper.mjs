/**
 * Shopping App — home-device price feeder (v0.25)
 * ================================================================
 * Runs on an always-on device on your RESIDENTIAL IP, so it sails past the
 * bot walls (Akamai / Incapsula) that block datacenter IPs. A real Chromium
 * browser (Playwright) with a PERSISTENT PROFILE keeps the session warm —
 * no cookie copying, ever.
 *
 * What it does (nightly):
 *   1. Opens the browser, warms the session (visits each store's home page).
 *   2. Coles   — searches the catalogue; intercepts the page's own API/JSON
 *      responses AND falls back to a classless DOM walk (name + $price).
 *   3. Woolworths — same, with a dedicated parser for /apis/ui/Search/products.
 *   4. Aldi    — plain HTTP fetch of Special Buys pages (no browser needed).
 *   5. Normalises to pwa/data/prices.json (same schema the app reads).
 *   6. git commit + push → Netlify auto-publishes → the app picks it up.
 *
 * Failure handling: per-store try/catch keeps last-known-good prices and
 * flags that store "stale". The app never breaks; it just shows "last known".
 * Fail-fast: if the first 3 searches extract zero tiles, the store aborts
 * (~30s) instead of grinding through all 207 items.
 *
 * Env:
 *   GH_TOKEN / GH_REPO   required for push
 *   CRON_FULL / CRON_SPECIALS  cron overrides (UTC)
 *   QUICK=1              scrape only 3 items per store (1-minute verification)
 *   NATIVE_CHROME=1      use the system-installed Google Chrome (channel "chrome")
 *                        instead of the bundled Chromium — the most human-like
 *                        fingerprint; use this when running natively on Windows
 *                        to get past Incapsula/Akamai (Coles attempt).
 *   PROBE=1              inspect grocery-aggregator sites (ausgroceryprices)
 *                        for a usable API — logs every JSON/API request. No
 *                        scraping or pushing; just diagnostics.
 *   HEADLESS=1           force headless (default is headed)
 *   DELAY_MS             polite per-item delay (default 1200)
 *   HTTP_TIMEOUT         ms (default 20000)
 * `node scraper.mjs --once` runs a single scrape and exits.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, readlinkSync, lstatSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import cron from "node-cron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ONCE = process.argv.includes("--once");

const CATALOGUE_PATH = process.env.CATALOGUE_PATH || path.join(__dirname, "..", "scraper", "catalogue.json");
const PROFILE_DIR = process.env.PROFILE_DIR || path.join(__dirname, "profile");
const REPO_DIR = process.env.REPO_DIR || path.join(__dirname, "repo");
const CURRENCY = "AUD";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const DELAY_MS = Number(process.env.DELAY_MS || 1200);
const HTTP_TIMEOUT = Number(process.env.HTTP_TIMEOUT || 20000);
const QUICK = process.env.QUICK === "1" || process.env.QUICK === "true";
const NATIVE = process.env.NATIVE_CHROME === "1" || process.env.NATIVE_CHROME === "true";
const PROBE = process.env.PROBE === "1" || process.env.PROBE === "true";
const IS_WIN = process.platform === "win32";

const log = (...a) => console.log(new Date().toISOString(), ...a);
const num = (v) => {
  if (v === undefined || v === null) return null;
  const n = typeof v === "string" ? parseFloat(v.replace(/[^0-9.]/g, "")) : v;
  return isNaN(n) ? null : Math.round(n * 100) / 100;
};

/* Scrub credentials out of anything before it hits the logs. */
function redact(s) {
  return String(s)
    .replace(/x-access-token:[A-Za-z0-9_-]+@/g, "x-access-token:***@")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "github_pat_***");
}
/* execSync wrapper that pipes output, redacts the error message, and times
   out (default 120s) so a hung git command fails fast instead of sitting
   silently forever. */
function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: "pipe", timeout: 120000, ...opts });
  } catch (e) {
    if (e.signal === "SIGTERM" || e.code === "ETIMEDOUT" || /ETIMEDOUT|killed/i.test(e.message || "")) {
      const err = new Error("command timed out after 120s: " + redact(cmd));
      err.status = e.status;
      throw err;
    }
    const err = new Error(redact(e.message || String(e)));
    err.status = e.status;
    throw err;
  }
}

/* Empty a directory's CONTENTS without deleting the directory itself. This is
   what makes /repo safe to clean: /repo is a Docker mount point, so deleting
   the folder fails with "Device or resource busy" — deleting its children is
   fine and leaves a clean, empty target for git clone. */
function clearDir(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

/* Chromium leaves SingletonLock/SingletonCookie/SingletonSocket in the profile
   dir. After a crash or power cut they survive and block the next launch with
   "profile appears to be in use". Delete them when the lock's PID is not alive.
   NOTE: stop the main container before one-off `docker compose run` quick tests
   — two containers sharing this profile volume will always conflict. */
function cleanStaleProfileLocks() {
  for (const f of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    const p = path.join(PROFILE_DIR, f);
    if (!existsSync(p)) continue;
    let alive = false;
    if (process.platform !== "win32") {
      try {
        const st = lstatSync(p);
        if (st.isSymbolicLink()) {
          const target = readlinkSync(p);
          const m = String(target).match(/-(\d+)$/);
          if (m) alive = existsSync("/proc/" + m[1]);
        }
      } catch (e) {}
    }
    if (!alive) {
      try { rmSync(p, { force: true }); log("removed stale profile lock:", f); } catch (e) { log("could not remove lock", f, "—", e.message); }
    } else {
      log("profile lock still held by a live process — is another container running? Leaving", f);
    }
  }
}

/* ---------------- catalogue + matching (shared with scraper/scrape.js) ---- */
const CATALOGUE = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8"));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim().split(" ");
const ALLOW = new Set(["pack","family","share","bag","block","blocks","strips","strip","premium","original","classic","italian","style","sweet","salted","extra","light","lite","full","cream","free","range","dried","tinned","canned","frozen","wild","instant","quick","long","grain","baby","whole","washed","loose","brown","red","white","green","yellow","black","blue","purple","pink","orange","sliced","diced","chopped","ground","grated","shredded","selection","quality","mix","bites","pieces","fillets","fillet","breast","breasts","thigh","thighs","mince","minced","lean","star","beef","pork","chicken","lamb","eggs","dozen","fresh","raw","cooked","large","small","medium","with","of","a","an","the","and","woolworths","coles","aldi","brand","branded","homebrand","rspca","approved","free-range","freerange","salted","unsalted","washed","loose"]);
const aliasesByItem = new Map();
for (const c of CATALOGUE) aliasesByItem.set(c.id, new Set([c.name.toLowerCase(), ...(c.aliases || []).map(a => a.toLowerCase())]));

/* Words that change what a product IS (prepared/cooked) vs a raw ingredient,
   and species words. Used by matchScore to stop e.g. "Shredded Chicken Breast"
   standing in for chicken-breast, or "Pork & Beef Mince" for beef-mince. */
const NEG_WORDS = new Set(["shredded","crumbed","marinated","cooked","roast","roasted","smoked","grilled","precooked","prepared","deli","nuggets","nugget","patty","patties","meatball","meatballs","kebab","kebabs","schnitzel","schnitzels","ready","diced","chopped","sliced","strips","strip","minced","coated","battered","seasoned","flavoured","flavored","crumb","crumbs"]);
const SPECIES = new Set(["pork","beef","chicken","lamb","turkey","duck","fish","salmon","tuna","prawn","prawns","shrimp","bacon","ham","veal","kangaroo","barramundi","basa"]);
function matchCatalogue(name) {
  const nw = norm(name);
  if (!nw.length) return null;
  let best = null, bestLen = 0;
  for (const [id, aliases] of aliasesByItem) {
    for (const alias of aliases) {
      const aw = norm(alias);
      if (!aw.length) continue;
      if (aw.every(t => nw.includes(t))) {
        const leftover = nw.filter(t => !aw.includes(t));
        const ok = leftover.every(t => /^\d/.test(t) || ["g","kg","ml","l","pack"].includes(t) || ALLOW.has(t));
        if (ok && aw.length > bestLen) { best = id; bestLen = aw.length; }
      }
    }
  }
  return best;
}

/* ---------------- Aldi (HTTP — works from any IP) ------------------------ */
async function fetchTO(url, opts = {}, ms = HTTP_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
async function fetchText(url) {
  const res = await fetchTO(url, { headers: { "user-agent": UA, "accept": "text/html,application/json" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}
function parseSize(name) {
  const m = (name || "").match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/i);
  if (m) {
    const v = parseFloat(m[1]), u = m[2].toLowerCase();
    if (u === "g") return { q: v / 1000, u: "kg" };
    if (u === "ml") return { q: v / 1000, u: "L" };
    return { q: v, u };
  }
  const p = (name || "").match(/(\d+)\s*pack\b/i);
  if (p) return { q: parseInt(p[1], 10), u: "each" };
  return { q: 1, u: "each" };
}
async function scrapeAldi() {
  const landing = await fetchText("https://www.aldi.com.au/special-buys");
  const dates = [...new Set([...landing.matchAll(/\/special-buys\/(\d{4}-\d{2}-\d{2})/g)].map(m => m[1]))].sort();
  if (!dates.length) throw new Error("aldi: no special-buys dates found");
  const byId = new Map();
  for (const d of dates.slice(0, 3)) {
    let html;
    try { html = await fetchText(`https://www.aldi.com.au/special-buys/${d}`); }
    catch (e) { log("aldi wave", d, "failed:", e.message); continue; }
    for (const part of html.split('product-tile__name').slice(1)) {
      const nm = part.match(/<p aria-label="([^"]*),?"/);
      const name = nm ? nm[1].replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").trim().replace(/,$/, "") : null;
      const pr = part.match(/base-price__regular"><span>\$([\d.]+)/);
      if (!name || !pr) continue;
      const id = matchCatalogue(name);
      if (id && !byId.has(id)) {
        const { q, u } = parseSize(name);
        byId.set(id, { id, name, price: parseFloat(pr[1]), q, u, note: "Special Buy", until: d });
      }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  const specials = [...byId.values()];
  if (!specials.length) throw new Error("aldi: no specials matched the catalogue this week");
  return specials;
}

/* Aldi FULL-LINE prices (v0.24): aldi.com.au/products SSR's everyday products
   (name + $price in the rendered HTML, reachable from any IP — no bot wall).
   Extracts product tiles, matches them to the catalogue, keeps cheapest per
   item. These become "Everyday price" entries (the app compares them like a
   normal store rather than flagging them as specials). */
async function scrapeAldiFullLine() {
  const html = await fetchText("https://www.aldi.com.au/products");
  const tiles = [];
  for (const part of html.split('product-tile__name').slice(1)) {
    const nm = part.match(/<p aria-label="([^"]*),?"/);
    const name = nm ? nm[1].replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").trim().replace(/,$/, "") : null;
    const pr = part.match(/base-price__regular"><span>\$([\d.]+)/);
    if (!name || !pr) continue;
    tiles.push({ name, price: parseFloat(pr[1]) });
  }
  if (tiles.length === 0) throw new Error("aldi: /products yielded no tiles (structure changed?)");

  const seen = new Map();
  for (const t of tiles) {
    const id = matchCatalogue(t.name);
    if (!id) continue;
    const { q, u } = parseSize(t.name);
    const prev = seen.get(id);
    const entry = { id, name: t.name, price: t.price, q, u, note: "Everyday price", until: null };
    if (!prev || entry.price < prev.price) seen.set(id, entry);
  }
  const items = [...seen.values()];
  if (items.length === 0) throw new Error("aldi: /products matched nothing in the catalogue");
  log("aldi full-line: matched", items.length, "items:", items.slice(0, 15).map(i => `${i.id} @ $${i.price}`).join(", "), items.length > 15 ? "…" : "");
  return items;
}

/* ---------------- Coles & Woolworths (browser) -------------------------- */
async function warmUp(page) {
  for (const url of ["https://www.coles.com.au/", "https://www.woolworths.com.au/"]) {
    try { await page.goto(url, { waitUntil: "load", timeout: 60000 }); }
    catch (e) { log("warm-up visit failed:", url, e.message); }
    // Let any bot challenge (Akamai _abck / Incapsula) run and set its session
    // cookie, then nudge the page so the challenge completes. Incapsula can
    // take 5-10s, so settle longer here.
    await new Promise(r => setTimeout(r, 8000));
    try { await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {}); } catch (e) {}
    await new Promise(r => setTimeout(r, 2000));
    const t = await page.title().catch(() => "(no title)");
    log("warm-up:", url, "-> title:", JSON.stringify(t));
  }
}

/** Stealth browser launch. Headless Chromium is fingerprinted by Akamai /
    Incapsula, so run HEADED by default (full Chromium on a virtual display),
    strip automation markers, and present a realistic locale/viewport/profile.
    HEADLESS=1 forces headless (only useful for Aldi-only runs). */
async function launchBrowser() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  cleanStaleProfileLocks();
  const headless = process.env.HEADLESS === "1";
  // NATIVE_CHROME=1 → use the system-installed Google Chrome (the most
  // human-like fingerprint; needed for the Incapsula-gated Coles). Otherwise
  // the bundled Chromium (Docker container).
  const channel = NATIVE ? "chrome" : "chromium";
  log("launching browser — channel:", channel, "| headless:", headless, "| platform:", process.platform);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    channel,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage"
    ],
    viewport: { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    locale: "en-AU",
    timezoneId: "Australia/Perth"
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-AU", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  });
  return context;
}

/** Extract products. Strategy per store:
    1) Product-detail links (a[href*="/productdetails/"] for Woolworths,
       a[href*="/product/"] for Coles) — name from the link/heading, price from
       the tile text. Most reliable.
    2) Fallback: walk every "$X.XX" node and climb to a nearby name, excluding
       unit-price labels ("per kg", "per 100g") and action words. */
async function extractProducts(page, store) {
  return page.evaluate((store) => {
    const out = [];
    const seen = new Set();
    const linkSel = store === "woolworths" ? 'a[href*="/shop/productdetails/"]' : 'a[href*="/product/"]';
    const links = document.querySelectorAll(linkSel);
    for (const a of links) {
      // climb a few levels to a tile that has both name and price text
      let tile = a;
      for (let i = 0; i < 4 && tile; i++) {
        if ((tile.textContent || "").length > 60) break;
        tile = tile.parentElement;
      }
      const tileText = ((tile && tile.textContent) || a.textContent || "").trim();
      const nameEl = a.querySelector("h1,h2,h3,h4") || a;
      const name = (nameEl.textContent || "").trim().split("\n")[0].trim();
      const m = tileText.match(/\$\s?(\d+(?:\.\d{1,2})?)/);
      if (!name || name.length < 3 || !m) continue;
      const price = parseFloat(m[1]);
      if (!isFinite(price) || price <= 0 || price > 100000) continue;
      const key = name + "|" + price;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, price });
    }
    if (out.length === 0) {
      const all = document.querySelectorAll("body *");
      for (const el of all) {
        const t = (el.textContent || "").trim();
        if (!t || t.length > 60) continue;
        const m = t.match(/\$\s?(\d+(?:\.\d{1,2})?)/);
        if (!m) continue;
        const price = parseFloat(m[1]);
        if (!isFinite(price) || price <= 0 || price > 100000) continue;
        let node = el, name = null;
        for (let i = 0; i < 9 && node && !name; i++) {
          const parent = node.parentElement;
          if (!parent) break;
          const cands = parent.querySelectorAll("h1,h2,h3,h4,a,strong,[class*='title'],[class*='Title'],[class*='name'],[class*='Name']");
          for (const c of cands) {
            const ct = (c.textContent || "").trim();
            if (ct.length > 3 && ct.length < 140 && !/\$\s?\d/.test(ct) &&
                !/add|buy|basket|save|shop|view|wishlist|per kg|per 100g|per each|per\s?1/i.test(ct)) {
              name = ct.split("\n")[0].trim();
              break;
            }
          }
          node = parent;
        }
        if (name && price) {
          const key = name + "|" + price;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ name, price });
        }
      }
    }
    return out.slice(0, 100);
  }, store);
}

/** Parse the Woolworths search API response into {name, price, wasPrice}. */
function parseWoolApi(data) {
  const products = data && (data.Products || data.SearchResults || (data.searchResults && data.searchResults.Results) || []);
  if (!Array.isArray(products)) return [];
  return products.map(p => ({
    name: String(p.Name || p.DisplayName || "").trim(),
    price: num(p.Price),
    wasPrice: num(p.WasPrice),
    onSpecial: !!(p.IsSpecial || (p.WasPrice && p.WasPrice > p.Price))
  })).filter(t => t.name && t.price != null);
}

/* Dedicated Woolworths parser. The search API response is double-wrapped:
   {"Products":[{"Products":[{ …product objects… }]}]}. Walk EVERY object and
   keep any that carries an exact Name/DisplayName/Title PLUS a real pack price
   (Price → InstorePrice), skipping cup/unit/incremental prices so unit-price
   labels can never be mistaken for products. No structural assumptions. */
function parseWoolAny(data) {
  const tiles = [];
  const seen = new Set();
  const stack = [data];
  let visited = 0;
  while (stack.length && visited < 100000) {
    const node = stack.pop();
    visited++;
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) { for (const v of node) stack.push(v); continue; }
    const keys = Object.keys(node).filter(k => !k.startsWith("__"));
    let name = null;
    for (const k of ["Name", "DisplayName", "Title", "name", "displayName", "title"]) {
      const v = node[k];
      if (typeof v === "string" && v.trim().length > 2) { name = v.trim(); break; }
    }
    if (!name) {
      for (const k of keys) { const v = node[k]; if (v && typeof v === "object") stack.push(v); }
      continue;
    }
    const numOr = (v) => (typeof v === "number" || (typeof v === "string" && /\d/.test(v))) ? num(v) : null;
    let price = numOr(node["Price"]);
    if (price == null) price = numOr(node["InstorePrice"]);
    if (price == null) {
      const pk = keys.find(k => /price/i.test(k) && !/cup|unit|per|incremental|label/i.test(k) && numOr(node[k]) != null);
      if (pk) price = numOr(node[pk]);
    }
    const wasPrice = numOr(node["WasPrice"]) ?? numOr(node["InstoreWasPrice"]);
    if (price != null) {
      tiles.push({ name, price, wasPrice, onSpecial: !!(wasPrice != null && wasPrice > price), _keys: keys.slice(0, 14) });
    }
    for (const k of keys) { const v = node[k]; if (v && typeof v === "object") stack.push(v); }
  }
  return tiles;
}

/** Generic scanner: recursively walk an arbitrary JSON blob and harvest
    {name, price} objects (name-ish string + smallest price-ish number).
    Catches Coles' __NEXT_DATA__ / API payloads without knowing their shape. */
function scanProductsJson(data, cap = 400) {
  const out = [];
  const seen = new Set();
  const stack = [data];
  let visited = 0;
  while (stack.length && visited < 30000 && out.length < cap) {
    const node = stack.pop();
    visited++;
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) { for (const v of node) stack.push(v); continue; }
    const keys = Object.keys(node);
    let name = null, price = null;
    for (const k of keys) {
      const kl = k.toLowerCase();
      const v = node[k];
      if (name == null && typeof v === "string" && v.trim().length > 2 && v.trim().length < 160 &&
          /name|title|label|displayname|productname/.test(kl)) {
        name = v.trim();
      }
      if ((kl === "price" || kl.includes("price")) && price == null) {
        const n = num(v);
        if (n != null && n > 0 && n < 100000) price = n;
      }
    }
    if (name && price != null) out.push({ name, price, wasPrice: null, onSpecial: false });
    for (const k of keys) { const v = node[k]; if (v && typeof v === "object") stack.push(v); }
  }
  return out;
}

/* Fetch a URL FROM INSIDE the page (same-origin, session cookies attached).
   This is the deterministic path: it hits the store's own JSON endpoints with
   a warm residential session, no DOM guessing. */
async function fetchInPage(page, url, opts) {
  return page.evaluate(async ({ url, opts }) => {
    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      try { return { __httpStatus: res.status, data: JSON.parse(text) }; }
      catch (e) { return { __httpStatus: res.status, __text: text.slice(0, 300) }; }
    } catch (e) {
      return { __error: String(e && e.message || e) };
    }
  }, { url, opts });
}

/* Parse a Coles Next.js data payload into {name, price} tiles. */
function parseColesData(data) {
  if (!data) return [];
  const pp = data.pageProps || data.props || {};
  const prods = (pp.searchResults && pp.searchResults.products) || pp.products || pp.searchProducts || pp.items;
  if (!Array.isArray(prods)) return [];
  return prods.map(p => ({
    name: String(p.name || p.productName || p.title || "").trim(),
    price: num(p.price ?? p.nowPrice ?? (p.pricing && p.pricing.now)),
    wasPrice: num(p.wasPrice ?? (p.pricing && p.pricing.was)),
    onSpecial: false
  })).filter(t => t.name && t.price != null);
}

/* Parse a Coles category browse response (`/_next/data/{buildId}/en/browse/
   {slug}.json`). Structure: pageProps.searchResults.results[], keep entries
   with `_type === "PRODUCT"`, read name + pricing.now/was/onlineSpecial. */
function parseColesBrowse(data) {
  if (!data) return [];
  const results = (data.pageProps && data.pageProps.searchResults && data.pageProps.searchResults.results) || [];
  if (!Array.isArray(results)) return [];
  const out = [];
  for (const r of results) {
    if (!r || r._type !== "PRODUCT") continue;
    const name = String(r.name || r.description || "").trim();
    if (!name || !r.pricing) continue;
    const now = num(r.pricing.now);
    if (now == null) continue;
    const was = num(r.pricing.was);
    const wasOk = (was != null && was > 0) ? was : null;
    out.push({
      name,
      price: now,
      wasPrice: wasOk,
      onSpecial: !!(r.pricing.onlineSpecial || (wasOk != null && wasOk > now)),
      promo: r.pricing.promotionType || null,
      size: r.size || null
    });
  }
  return out;
}

/* Self-adapting product finder: walk any JSON blob and return the ARRAY whose
   elements look most like products (objects carrying BOTH a name-ish string
   field and a price-ish numeric field). No hardcoded key names — this adapts
   to Woolworths / Coles / Next.js shapes without guessing. */
function isProductLike(el) {
  if (!el || typeof el !== "object" || Array.isArray(el)) return false;
  const keys = Object.keys(el).filter(k => !k.startsWith("__"));
  const hasName = keys.some(k => /name|title|label|display/i.test(k) && typeof el[k] === "string" && el[k].trim().length > 2);
  const hasPrice = keys.some(k => /price/i.test(k) && (typeof el[k] === "number" || (typeof el[k] === "string" && /\d/.test(el[k]))));
  return hasName && hasPrice;
}

/* Find the product collection inside ANY JSON blob. Handles both:
   - ARRAYS of product objects (standard API responses)
   - DICTS whose values are product objects (Apollo/GraphQL __APOLLO_STATE__,
     Redux stores, etc. — keyed by "Product:123", not in an array)
   Picks the largest collection; the catalogue matcher filters noise later. */
function findProductArray(data) {
  let best = null;
  const stack = [data];
  const seen = new Set();
  let visited = 0;
  while (stack.length && visited < 100000) {
    const node = stack.pop();
    visited++;
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) {
      let score = 0;
      for (const el of node.slice(0, 300)) {
        if (isProductLike(el)) score++;
      }
      if (score >= 2 && (!best || score > best.score)) best = { score, array: node };
      for (const v of node) stack.push(v);
      continue;
    }
    // object/dict: its VALUES might be a collection of product objects
    const vals = [];
    let dictScore = 0;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") {
        if (!Array.isArray(v) && isProductLike(v)) { dictScore++; vals.push(v); }
        stack.push(v);
      }
    }
    if (dictScore >= 2 && (!best || dictScore > best.score)) best = { score: dictScore, array: vals };
  }
  return best ? best.array : null;
}

/* Parse the product array found by findProductArray into tiles, using flexible
   name/price/was key detection per element. */
function parseAnyProducts(data) {
  const arr = findProductArray(data);
  if (!arr) return [];
  return arr.map(p => {
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    const keys = Object.keys(p).filter(k => !k.startsWith("__"));
    const nameKey = keys.find(k => /name|title|label|display/i.test(k) && typeof p[k] === "string" && p[k].trim().length > 2);
    const priceKey = keys.find(k => /price/i.test(k) && (typeof p[k] === "number" || (typeof p[k] === "string" && /\d/.test(p[k]))));
    const wasKey = keys.find(k => /was/i.test(k) && k !== priceKey && (typeof p[k] === "number" || (typeof p[k] === "string" && /\d/.test(p[k]))));
    const name = nameKey ? String(p[nameKey]).trim() : "";
    const price = priceKey ? num(p[priceKey]) : null;
    if (!name || price == null) return null;
    return { name, price, wasPrice: wasKey ? num(p[wasKey]) : null, onSpecial: false, _keys: keys.slice(0, 12) };
  }).filter(Boolean);
}

/* Ground-truth dump: when tiles are empty or names look wrong, this shows the
   REAL page structure so the next fix can use exact selectors. */
async function dumpGroundTruth(page) {
  return page.evaluate(() => {
    const links = [];
    const anchors = document.querySelectorAll("a[href]");
    for (const a of anchors) {
      const h = a.getAttribute("href") || "";
      if (/product|search|browse/i.test(h)) {
        links.push({ href: h.slice(0, 120), text: (a.textContent || "").trim().slice(0, 60) });
        if (links.length >= 8) break;
      }
    }
    const prices = [];
    const all = document.querySelectorAll("body *");
    for (const el of all) {
      const t = (el.textContent || "").trim();
      if (t && t.length < 60 && /\$\s?\d/.test(t)) {
        prices.push({ tag: el.tagName.toLowerCase(), cls: (el.className && String(el.className).slice(0, 50)) || "", text: t.slice(0, 60) });
        if (prices.length >= 8) break;
      }
    }
    const globals = Object.keys(window).filter(k => /state|data|initial|__/i.test(k)).slice(0, 20);
    return {
      readyState: document.readyState,
      hasNextData: !!document.getElementById("__NEXT_DATA__"),
      hasMainIframe: !!document.getElementById("main-iframe"),
      bodyChildren: document.body ? document.body.children.length : -1,
      bodyText: document.body ? document.body.innerText.replace(/\s+/g, " ").slice(0, 200) : "(no body)",
      links,
      prices,
      globals
    };
  });
}

async function scrapeStore(page, store, label) {
  const results = [];
  const catalogue = QUICK ? CATALOGUE.slice(0, 3) : CATALOGUE;
  let tilesSeenTotal = 0;

  for (let i = 0; i < catalogue.length; i++) {
    const item = catalogue[i];
    let tiles = [];
    let lastApiResp = null;
    try {
      const url = store === "woolworths"
        ? `https://www.woolworths.com.au/shop/search/products?searchTerm=${encodeURIComponent(item.search)}`
        : `https://www.coles.com.au/search/products?q=${encodeURIComponent(item.search)}`;

      // Capture the page's own API/JSON responses while it loads (the browser
      // has a real session on a residential IP, so these succeed).
      let apiData = null;
      const onResponse = (resp) => {
        try {
          const u = resp.url();
          if (store === "woolworths" && u.includes("/apis/ui/Search/products") && resp.status() === 200) {
            resp.json().then(d => { if (!apiData) apiData = d; }).catch(() => {});
          } else if (store === "coles" && resp.status() === 200 && /json/i.test(resp.headers()["content-type"] || "")) {
            resp.json().then(d => { if (!apiData) apiData = d; }).catch(() => {});
          }
        } catch (e) {}
      };
      page.on("response", onResponse);
      try {
        // Coles (Incapsula) needs the homepage challenge cookie set first and a
        // longer hydration settle; Woolworths just needs a modest settle.
        await page.goto(url, { waitUntil: store === "coles" ? "networkidle" : "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(store === "coles" ? 6000 : 4000);
        for (let s = 0; s < (store === "coles" ? 6 : 4); s++) { await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {}); await page.waitForTimeout(600); }
      } finally {
        page.off("response", onResponse);
      }

      // Coles (Incapsula): after landing, poll up to ~20s for the challenge to
      // self-solve and the real content to hydrate. If still challenged, RELOAD
      // once — Incapsula often sets its session cookie on the first challenge
      // and lets the second request through.
      if (store === "coles") {
        const hasContent = () => page.evaluate(() =>
          !!document.getElementById("__NEXT_DATA__") ||
          (document.body && document.body.innerText.length > 120)
        ).catch(() => false);
        let ok = false;
        for (let p = 0; p < 20; p++) {
          ok = await hasContent();
          if (ok) break;
          await page.waitForTimeout(1000);
        }
        if (!ok) {
          log("coles: challenge detected — reloading once to complete the Incapsula cookie handshake");
          await page.reload({ waitUntil: "networkidle", timeout: 60000 }).catch(() => {});
          await page.waitForTimeout(5000);
          for (let p = 0; p < 10; p++) {
            ok = await hasContent();
            if (ok) break;
            await page.waitForTimeout(1000);
          }
        }
      }

      // 1) In-page same-origin API fetch (deterministic, warm session) —
      //    Woolworths: /apis/ui/Search/products  ·  Coles: /_next/data/{buildId}/search/products.json
      let apiNote = null;
      if (store === "woolworths") {
        const body = JSON.stringify({
          SearchTerm: item.search, PageNumber: 1, PageSize: 36, IsSpecial: false,
          SortType: "TraderRelevance", Filters: [],
          Location: `/shop/search/products?searchTerm=${encodeURIComponent(item.search)}`,
          IsHideUnavailableProducts: false
        });
        const r = await fetchInPage(page, "/apis/ui/Search/products", {
          method: "POST", headers: { "content-type": "application/json", "accept": "application/json" }, body
        });
        lastApiResp = r;
        if (r.data) {
          tiles = parseWoolAny(r.data);
          if (tiles.length === 0) tiles = parseWoolApi(r.data);
          if (tiles.length === 0) tiles = parseAnyProducts(r.data);
          apiNote = "status " + (r.__httpStatus ?? "ok") + ", tiles=" + tiles.length;
          if (tiles.length === 0) {
            log(label, "API keys:", JSON.stringify(Object.keys(r.data)), "| Products isArray:", Array.isArray(r.data.Products), "| Products.len:", r.data.Products && r.data.Products.length);
          }
        } else {
          apiNote = "status " + (r.__httpStatus || r.__error || "unknown");
        }
      } else {
        const bid = await page.evaluate(() => {
          const el = document.getElementById("__NEXT_DATA__");
          if (el) { try { return JSON.parse(el.textContent).buildId; } catch (e) { return null; } }
          return (window.__NEXT_DATA__ && window.__NEXT_DATA__.buildId) || null;
        }).catch(() => null);
        if (bid) {
          const r = await fetchInPage(page, `/_next/data/${bid}/search/products.json?q=${encodeURIComponent(item.search)}`, {
            headers: { accept: "application/json" }
          });
          lastApiResp = r;
          if (r.data) {
            tiles = parseColesData(r.data);
            if (tiles.length === 0) tiles = parseAnyProducts(r.data);
            apiNote = "status " + (r.__httpStatus ?? "ok") + ", tiles=" + tiles.length;
          } else {
            apiNote = "status " + (r.__httpStatus || r.__error || "unknown");
          }
        } else {
          apiNote = "no buildId";
          log(label, "no Coles buildId found on page");
        }
      }

      // 2) __NEXT_DATA__ scan (server-rendered JSON) — self-adapting now.
      if (tiles.length === 0) {
        const nd = await page.evaluate(() => { const el = document.getElementById("__NEXT_DATA__"); return el ? el.textContent : null; }).catch(() => null);
        if (nd) {
          try {
            const d = JSON.parse(nd);
            if (store === "woolworths") tiles = parseWoolAny(d);
            if (tiles.length === 0) tiles = parseWoolApi(d);
            if (tiles.length === 0) tiles = parseColesData(d);
            if (tiles.length === 0) tiles = parseAnyProducts(d);
          } catch (e) { /* malformed — fall through */ }
        }
      }

      // 3) fallbacks: intercepted responses, then DOM walk
      if (tiles.length === 0 && apiData) tiles = parseWoolApi(apiData);
      if (tiles.length === 0 && apiData) tiles = parseAnyProducts(apiData);
      if (tiles.length === 0) tiles = await extractProducts(page, store);
      tilesSeenTotal += tiles.length;

      // Score-based matching: reject prepared/wrong-species tiles, prefer exact
      // catalogue matches over substring matches, tie-break cheapest.
      const itemWords = new Set();
      norm(item.name).forEach(w => itemWords.add(w));
      (item.aliases || []).forEach(a => norm(a).forEach(w => itemWords.add(w)));
      const scored = tiles
        .map(t => {
          const low = (t.name || "").toLowerCase();
          const tw = norm(t.name);
          const bad = [...NEG_WORDS].some(w => tw.includes(w) && !itemWords.has(w)) ||
                      [...SPECIES].some(s => tw.includes(s) && !itemWords.has(s));
          if (bad) return null;
          const fid = matchCatalogue(t.name);
          let sc = 0;
          if (fid === item.id) sc = 3;
          else if (fid) sc = 0;
          else if (low.includes(item.search.toLowerCase())) sc = 2;
          else if (low.includes(item.name.toLowerCase())) sc = 1;
          return sc > 0 ? { ...t, sc } : null;
        })
        .filter(Boolean)
        .sort((a, b) => (b.sc - a.sc) || ((a.price || 1e9) - (b.price || 1e9)));
      let best = scored[0];

      if (best) {
        results.push({ id: item.id, name: best.name, price: num(best.price), wasPrice: best.wasPrice != null ? best.wasPrice : null, onSpecial: !!best.onSpecial });
        log(label, "ok:", item.id, "->", best.name, "$" + best.price);
      } else {
        log(label, "no match:", item.id, "(tiles:", tiles.length + ")");
      }

      if (i === 0) {
        const title = await page.title().catch(() => "(no title)");
        const finalUrl = page.url();
        const gt = await dumpGroundTruth(page).catch(() => null);
        log(label, "diagnostic — title:", JSON.stringify(title), "| url:", finalUrl, "| apiNote:", apiNote || "(none)", "| tiles:", tiles.length, "| sample:", tiles[0] ? JSON.stringify({ name: tiles[0].name, price: tiles[0].price, keys: tiles[0]._keys }) : "(none)");
        if (tiles.length === 0 && lastApiResp && lastApiResp.data) {
          log(label, "raw API sample:", JSON.stringify(lastApiResp.data).slice(0, 600));
        }
        if (gt) log(label, "ground-truth:", JSON.stringify(gt).slice(0, 900));
        if (/access denied|attention required|not a robot|just a moment|captcha|verify you are|incapsula|forbidden|challenge/i.test(title)) {
          log(label, "BOT-CHALLENGE detected — title:", title);
        }
      }
    } catch (e) {
      log(label, "failed for", item.id, "-", e.message);
    }

    if (i === 2 && tilesSeenTotal === 0) {
      throw new Error(label + ": zero tiles on first 3 items — blocked or page structure changed");
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  if (!results.length) throw new Error(label + ": no items matched the catalogue");
  log(label, "summary:", results.length, "matched of", catalogue.length, "items");
  return results;
}

/* Coles specials pass: the search route is Incapsula-gated, but /catalogues
   answered 200 with __NEXT_DATA__ + product-tile markers. Visit it once, scan
   the server-rendered JSON + DOM, and match any special-priced products to the
   catalogue. Returns items tagged onSpecial (specials-only Coles). */
/* AGGREGATOR harvester (v0.22+, expanded v0.23): ausgroceryprices.com exposes
   an OPEN JSON API (discovered by the v0.21 probe):
     GET https://ausgroceryprices.com/api/v1/products/discounts/{page}
   Response: { _id, sources: { woolies:[...], coles:[...], aldi:[...], ... } }
   Each product: { name, priceHistory: [{ availablePrice: cents, defaultPrice:
   cents, ... }], ... }. "NOW $6.75 WAS $13.50" → availablePrice=675,
   defaultPrice=1350 (both cents). Catalogue/specials data, refreshed weekly. */
const AGG_BASE = "https://ausgroceryprices.com";
const AGG_STORE_MAP = { woolies: "woolworths", coles: "coles", aldi: "aldi" };

function parseAggProducts(data, store) {
  const out = [];
  const push = (prod, s) => {
    if (!prod || typeof prod !== "object" || Array.isArray(prod)) return;
    if (store && s && s !== store) return;
    const name = prod.name || prod.title || prod.description || null;
    if (!name || typeof name !== "string") return;
    // price: prefer priceHistory (cents), then pricing.now, then price fields
    let price = null, was = null;
    const ph = Array.isArray(prod.priceHistory) && prod.priceHistory.length
      ? prod.priceHistory[prod.priceHistory.length - 1] : null;
    if (ph) {
      price = ph.availablePrice ?? ph.defaultPrice ?? ph.price;
      was = ph.defaultPrice ?? ph.wasPrice ?? ph.was;
    }
    if (price == null) price = (prod.pricing && prod.pricing.now) ?? prod.price ?? prod.availablePrice ?? prod.now;
    if (was == null) was = (prod.pricing && prod.pricing.was) ?? prod.wasPrice ?? prod.defaultPrice;
    if (price == null) return;
    price = num(price);
    was = was != null ? num(was) : null;
    if (price == null || price <= 0) return;
    // unit heuristic: prices over 200 are in CENTS (no single grocery item is $200+)
    if (price > 200) { price = price / 100; if (was != null && was > 200) was = was / 100; }
    if (was != null && was <= price) was = null;
    out.push({ store: s, name: String(name).trim(), price, wasPrice: was, onSpecial: !!was });
  };

  // shape 1: { sources: { woolies:[...], coles:[...], ... } }
  const sources = (data && data.sources) || {};
  if (typeof sources === "object" && Object.keys(sources).length) {
    for (const sk of Object.keys(sources)) {
      const s = AGG_STORE_MAP[sk];
      const arr = sources[sk];
      if (Array.isArray(arr)) arr.forEach(p => push(p, s));
    }
    if (out.length) return out;
  }
  // shape 2: { results: [...] }, { products: [...] }, or a bare array
  const arr = (data && data.results) || (data && data.products) || (Array.isArray(data) ? data : null);
  if (Array.isArray(arr)) arr.forEach(p => push(p, store || null));
  return out;
}

async function scrapeAggregator(page, storeFilter) {
  const maxPages = QUICK ? 2 : Number(process.env.AGG_PAGES || 60);
  const byCatId = new Map(CATALOGUE.map(c => [c.id, c]));
  log("aggregator: harvesting ALL discount pages (max", maxPages + ")…");
  await page.goto(AGG_BASE + "/discounts", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);

  const seen = new Map(); // "store:id" -> best (cheapest) entry
  let totalHits = 0, totalTiles = 0;
  for (let p = 0; p < maxPages; p++) {
    const r = await fetchInPage(page, `/api/v1/products/discounts/${p}`, { headers: { accept: "application/json" } });
    if (!r.data) { log("aggregator page", p, "failed:", r.__httpStatus || r.__error || "(unknown)"); break; }
    const tiles = parseAggProducts(r.data);
    totalTiles += tiles.length;
    let hits = 0;
    for (const t of tiles) {
      if (storeFilter && t.store !== storeFilter) continue;
      const id = matchCatalogue(t.name);
      if (!id) continue;
      const cat = byCatId.get(id);
      if (cat) {
        const tw = norm(t.name);
        const iw = new Set();
        norm(cat.name).forEach(w => iw.add(w));
        (cat.aliases || []).forEach(a => norm(a).forEach(w => iw.add(w)));
        const bad = [...NEG_WORDS].some(w => tw.includes(w) && !iw.has(w)) ||
                    [...SPECIES].some(s => tw.includes(s) && !iw.has(s));
        if (bad) continue;
      }
      hits++;
      const key = t.store + ":" + id;
      const prev = seen.get(key);
      const entry = { id, name: t.name, price: t.price, wasPrice: t.wasPrice, onSpecial: t.onSpecial };
      if (!prev || entry.price < prev.price) seen.set(key, entry);
    }
    totalHits += hits;
    log("aggregator page", p, "-> tiles:", tiles.length, "| stores:", JSON.stringify(Object.keys((r.data && r.data.sources) || {})), "| catalogue hits:", hits);
    if (tiles.length === 0) break;
    await new Promise(res => setTimeout(res, 400));
  }
  const items = [...seen.values()];
  log("aggregator: total catalogue matches:", items.length, "(" + totalHits + " raw hits, " + totalTiles + " tiles across pages)");
  return items;
}

/* Self-adapting per-item SEARCH: navigate to /products, trigger a search, and
   capture the /api/* request the page itself makes — then replay it for every
   catalogue item we don't already have. No endpoint guessing. */
async function scrapeAggregatorSearch(page, storeFilter, alreadyHave) {
  const byCatId = new Map(CATALOGUE.map(c => [c.id, c]));
  await page.goto(AGG_BASE + "/products", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(3000);

  const captured = [];
  const onReq = (req) => { const u = req.url(); if (/\/api\//i.test(u)) captured.push(u); };
  page.on("request", onReq);

  // Attempt 1: type into the search field (broad detection)
  const typed = await page.evaluate(() => {
    const els = document.querySelectorAll('input, textarea');
    for (const el of els) {
      const t = (el.getAttribute("type") || "").toLowerCase();
      const ph = (el.getAttribute("placeholder") || "").toLowerCase();
      const nm = (el.getAttribute("name") || el.getAttribute("aria-label") || "").toLowerCase();
      if (t === "search" || ph.includes("search") || ph.includes("name") || nm.includes("search")) {
        el.focus();
        el.value = "chicken";
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return "typed";
      }
    }
    return "no input";
  }).catch(() => "error");
  log("aggregator search: input attempt ->", typed);
  try { await page.keyboard.press("Enter"); } catch (e) {}
  await page.waitForTimeout(6000);

  // Attempt 2 (fallback): navigate with URL query params
  if (!captured.some(u => /products|search/i.test(u))) {
    for (const qs of ["?q=chicken", "?search=chicken", "?name=chicken"]) {
      try {
        await page.goto(AGG_BASE + "/products" + qs, { waitUntil: "networkidle", timeout: 30000 });
        await page.waitForTimeout(4000);
      } catch (e) {}
      if (captured.some(u => /products|search/i.test(u))) break;
    }
  }
  page.off("request", onReq);

  const seenUrls = [...new Set(captured)];
  log("aggregator search: captured", seenUrls.length, "api request(s):");
  seenUrls.slice(0, 20).forEach(u => log("   ", u));

  const template = seenUrls.find(u => u.toLowerCase().includes("chicken"));
  if (!template) {
    log("aggregator search: no search API captured — Coles stays discounts-only");
    return [];
  }
  log("aggregator search template:", template);

  const needed = CATALOGUE.filter(c => !alreadyHave.has(c.id));
  const seen = new Map();
  let checked = 0;
  for (const item of needed) {
    const url = template.replace(/chicken/gi, encodeURIComponent(item.search));
    const r = await fetchInPage(page, url, { headers: { accept: "application/json" } });
    if (r.data) {
      const tiles = parseAggProducts(r.data);
      for (const t of tiles) {
        if (storeFilter && t.store !== storeFilter) continue;
        const id = matchCatalogue(t.name);
        if (!id) continue;
        const cat = byCatId.get(id);
        if (cat) {
          const tw = norm(t.name);
          const iw = new Set();
          norm(cat.name).forEach(w => iw.add(w));
          (cat.aliases || []).forEach(a => norm(a).forEach(w => iw.add(w)));
          const bad = [...NEG_WORDS].some(w => tw.includes(w) && !iw.has(w)) ||
                      [...SPECIES].some(s => tw.includes(s) && !iw.has(s));
          if (bad) continue;
        }
        const key = (t.store || storeFilter) + ":" + id;
        const prev = seen.get(key);
        const entry = { id, name: t.name, price: t.price, wasPrice: t.wasPrice, onSpecial: t.onSpecial };
        if (!prev || entry.price < prev.price) seen.set(key, entry);
      }
    }
    checked++;
    if (checked === 1) log("aggregator search: first response sample:", r.data ? JSON.stringify(r.data).slice(0, 300) : "(none)");
    if (checked % 25 === 0) log("aggregator search: progress", checked, "of", needed.length, "| matched so far:", seen.size);
    await new Promise(res => setTimeout(res, 300));
  }
  const items = [...seen.values()];
  log("aggregator search: matched", items.length, "items of", needed.length, "queried");
  return items;
}

/* Coles browse scraper (v0.20): the CORRECT Coles data route, learned from the
   open-source project tjhowse/aus_grocery_price_database:
     GET /_next/data/{buildId}/en/browse/{slug}.json?slug={slug}&page=N
   (the /search/products route is Incapsula-gated; browse is what works).
   Fetches pages of the relevant top-level categories IN-PAGE (same-origin,
   warm session cookies attached) and matches products to the catalogue. */
const COLES_CATEGORIES = ["meat-seafood", "fruit-vegetables", "dairy-eggs-fridge", "bakery", "deli", "pantry", "drinks", "frozen", "household"];

async function scrapeColesBrowse(page) {
  const maxPages = QUICK ? 1 : Number(process.env.COLES_MAX_PAGES || 3);
  log("coles: browsing category pages (maxPages:", maxPages + ")…");
  await page.goto("https://www.coles.com.au/browse", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(4000);

  const buildId = await page.evaluate(() => {
    try {
      const el = document.getElementById("__NEXT_DATA__");
      if (el) return JSON.parse(el.textContent).buildId || null;
      return (window.__NEXT_DATA__ && window.__NEXT_DATA__.buildId) || null;
    } catch (e) { return null; }
  }).catch(() => null);
  if (!buildId) throw new Error("coles: no buildId on /browse (challenge?)");
  log("coles buildId:", buildId);

  const cats = QUICK ? ["meat-seafood", "fruit-vegetables"] : COLES_CATEGORIES;
  const allTiles = [];
  for (const slug of cats) {
    for (let pg = 1; pg <= maxPages; pg++) {
      const url = `/_next/data/${buildId}/en/browse/${slug}.json?slug=${slug}&page=${pg}`;
      const r = await fetchInPage(page, url, { headers: { accept: "application/json", "x-nextjs-data": "1" } });
      if (r.data) {
        const tiles = parseColesBrowse(r.data);
        allTiles.push(...tiles);
        log("coles category", slug, "page", pg, "->", tiles.length, "products");
        if (tiles.length === 0) break;
      } else {
        log("coles category", slug, "page", pg, "failed:", r.__httpStatus || r.__error || "(unknown)");
        break;
      }
      await new Promise(res => setTimeout(res, 400));
    }
  }

  if (allTiles.length === 0) throw new Error("coles: browse returned no products (blocked or schema changed)");
  log("coles: total browse tiles:", allTiles.length);

  // match to catalogue: guard prepared/species words, keep cheapest per item
  const seen = new Map();
  const byId = new Map(CATALOGUE.map(c => [c.id, c]));
  for (const t of allTiles) {
    const id = matchCatalogue(t.name);
    if (!id) continue;
    const item = byId.get(id);
    const tw = norm(t.name);
    const iw = new Set();
    norm(item.name).forEach(w => iw.add(w));
    (item.aliases || []).forEach(a => norm(a).forEach(w => iw.add(w)));
    const bad = [...NEG_WORDS].some(w => tw.includes(w) && !iw.has(w)) ||
                [...SPECIES].some(s => tw.includes(s) && !iw.has(s));
    if (bad) continue;
    const prev = seen.get(id);
    if (!prev || t.price < prev.price) {
      seen.set(id, { id, name: t.name, price: t.price, wasPrice: t.wasPrice, onSpecial: t.onSpecial, promo: t.promo });
    }
  }

  const items = [...seen.values()];
  if (items.length === 0) throw new Error("coles: browse tiles did not match the catalogue");
  log("coles browse matched:", items.length, "items:", items.slice(0, 12).map(i => `${i.id} @ $${i.price}`).join(", "), items.length > 12 ? "…" : "");
  return items;
}

async function scrapeColesSpecials(page) {
  log("coles: attempting /catalogues specials…");
  await page.goto("https://www.coles.com.au/catalogues", { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(6000);
  for (let s = 0; s < 6; s++) { await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {}); await page.waitForTimeout(600); }

  const title = await page.title().catch(() => "(no title)");
  log("coles specials page title:", JSON.stringify(title));

  let tiles = [];
  const nd = await page.evaluate(() => { const el = document.getElementById("__NEXT_DATA__"); return el ? el.textContent : null; }).catch(() => null);
  if (nd) {
    try { const d = JSON.parse(nd); tiles = parseColesData(d); if (tiles.length === 0) tiles = parseAnyProducts(d); } catch (e) {}
  }
  if (tiles.length === 0) tiles = await extractProducts(page, "coles");

  const out = [];
  const seen = new Map(); // id -> tile (cheapest wins)
  for (const t of tiles) {
    const id = matchCatalogue(t.name);
    if (!id) continue;
    const prev = seen.get(id);
    if (!prev || (t.price != null && t.price < prev.price)) {
      seen.set(id, { id, name: t.name, price: num(t.price), wasPrice: t.wasPrice != null ? t.wasPrice : null, onSpecial: true, promo: "Catalogue special" });
    }
  }
  const items = [...seen.values()];
  if (items.length === 0) throw new Error("coles: /catalogues yielded no catalogue matches (challenge or no specials found)");
  log("coles specials:", items.length, "matched:", items.map(i => `${i.id} @ $${i.price}`).join(", "));
  return items;
}

/* ---------------- aggregator probe ---------------------------------------- */
/* PROBE=1: load grocery-aggregator sites in the device's real browser and
   log every JSON/API request the page makes, so we can see whether they expose
   a clean internal API we could piggyback on for Coles. Also logs whether the
   site even loads for us (Cloudflare/block check). */
async function probeAggregator() {
  log("PROBE mode: deep inspection of ausgroceryprices.com (/products + /discounts)…");
  const ctx = await launchBrowser();
  const page = ctx.pages()[0] || await ctx.newPage();

  const targets = [
    { url: "https://ausgroceryprices.com/products", search: true },
    { url: "https://ausgroceryprices.com/discounts", search: false }
  ];

  for (const t of targets) {
    log("PROBE: visiting", t.url);
    const apiReqs = [];
    const apiRespSamples = [];
    const onReq = (req) => {
      const u = req.url();
      if (/\/api\//i.test(u)) {
        apiReqs.push(req.method() + " " + u.slice(0, 220));
      }
    };
    const onResp = (resp) => {
      const u = resp.url();
      if (/\/api\//i.test(u) && resp.status() < 500) {
        resp.text().then(body => {
          const entry = { status: resp.status(), url: u.slice(0, 220), sample: body.slice(0, 500).replace(/\s+/g, " ") };
          apiRespSamples.push(entry);
          log("PROBE API", resp.status(), u.slice(0, 180));
          if (body) log("PROBE API sample:", entry.sample);
        }).catch(() => {});
      }
    };
    page.on("request", onReq);
    page.on("response", onResp);
    try {
      await page.goto(t.url, { waitUntil: "networkidle", timeout: 60000 });
      await page.waitForTimeout(5000);
      for (let s = 0; s < 5; s++) { await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {}); await page.waitForTimeout(600); }

      if (t.search) {
        // Best-effort search interaction so the site makes its data calls.
        const interacted = await page.evaluate(() => {
          const input = document.querySelector('input[type="search"], input[type="text"], input[placeholder*="earch" i], textarea');
          if (!input) return "no search input found";
          const el = input;
          el.value = "chicken";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          return "typed 'chicken'";
        }).catch(e => "interaction error: " + e.message);
        log("PROBE search interaction:", interacted);
        try {
          await page.keyboard.press("Enter").catch(() => {});
        } catch (e) {}
        await page.waitForTimeout(6000);
        for (let s = 0; s < 5; s++) { await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {}); await page.waitForTimeout(600); }
      }

      const title = await page.title().catch(() => "(no title)");
      const finalUrl = page.url();
      const bodyText = await page.evaluate(() => document.body ? document.body.innerText.replace(/\s+/g, " ").slice(0, 400) : "(no body)").catch(() => "(no body)");
      log("PROBE result:", t.url, "| final url:", finalUrl, "| title:", JSON.stringify(title));
      log("PROBE body:", bodyText);

      const uniqReqs = [...new Set(apiReqs)];
      log("PROBE API requests seen (" + uniqReqs.length + "):");
      uniqReqs.slice(0, 40).forEach(r => log("   ", r));
      if (apiRespSamples.length === 0) {
        log("PROBE no /api/* responses captured — the data is server-rendered HTML (no easy API piggyback)");
      }
    } catch (e) {
      log("PROBE failed for", t.url, "-", e.message);
    } finally {
      page.off("request", onReq);
      page.off("response", onResp);
    }
  }
  await ctx.close();
  log("PROBE complete.");
}

/* ---------------- persistence + git push --------------------------------- */
function loadLastGood() {
  const p = path.join(REPO_DIR, "pwa", "data", "prices.json");
  try { if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")); } catch (e) {}
  return { stores: {} };
}

function ensureRepo() {
  const token = process.env.GH_TOKEN, repo = process.env.GH_REPO;
  if (!token || !repo) { log("GH_TOKEN / GH_REPO not set — feed will be written to disk only (no push)."); return false; }
  const name = process.env.GIT_NAME || "Shopping Price Feeder";
  const email = process.env.GIT_EMAIL || "price-feeder@local";
  const cloneUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
  if (existsSync(path.join(REPO_DIR, ".git"))) {
    try { run(`git -C ${REPO_DIR} pull --ff-only`); }
    catch (e) { log("git pull failed (continuing):", redact(e.message)); }
  } else {
    // Wipe any leftover non-git contents (e.g. a previous partial run) so the
    // clone has a clean, empty target. clearDir empties the mount point's
    // CONTENTS rather than deleting the mount point itself.
    if (existsSync(REPO_DIR)) { log("clearing stale /repo contents"); clearDir(REPO_DIR); }
    mkdirSync(REPO_DIR, { recursive: true });
    log("cloning repo…");
    run(`git clone --depth 1 ${cloneUrl} ${REPO_DIR}`);
  }
  run(`git -C ${REPO_DIR} config user.name "${name}"`);
  run(`git -C ${REPO_DIR} config user.email "${email}"`);
  return true;
}

function pushFeed() {
  run(`git -C ${REPO_DIR} add pwa/data/prices.json`);
  let hasChanges = true;
  try { run(`git -C ${REPO_DIR} diff --cached --quiet`); hasChanges = false; } catch (e) {}
  if (!hasChanges) { log("no price changes — nothing to push."); return; }
  run(`git -C ${REPO_DIR} commit -m "chore: refresh price feed (device)"`);
  const out = run(`git -C ${REPO_DIR} push origin HEAD`);
  log(redact(out.toString().trim()));
  log("pushed new price feed ✔");
}

/* ---------------- main --------------------------------------------------- */
async function runOnce() {
  // Clone/pull the repo BEFORE writing the feed, so the clone always has a
  // clean empty target and loadLastGood reads the freshest prices.
  if (QUICK) log("QUICK mode: scraping 3 items per store (verification run)");
  const canPush = ensureRepo();
  const lastGood = loadLastGood();
  const feed = {
    generatedAt: new Date().toISOString(),
    status: "ok",
    currency: CURRENCY,
    stores: {
      coles: lastGood.stores.coles || {},
      woolworths: lastGood.stores.woolworths || {},
      aldi: lastGood.stores.aldi || {}
    }
  };
  let okCount = 0;

  // Browser stores
  let ctx;
  try {
    ctx = await launchBrowser();
    const page = ctx.pages()[0] || await ctx.newPage();
    await warmUp(page);

    try {
      const items = await scrapeColesBrowse(page);
      feed.stores.coles = { source: "scraped", asOf: new Date().toISOString(), items };
      okCount++;
      log("coles: ok —", items.length, "items");
    } catch (e) {
      log("coles: browse stale —", e.message);
      // Fallback 1: the ausgroceryprices.com aggregator — FULL harvest:
      // all discount pages (every special) + per-item search for the rest.
      try {
        const agg = await scrapeAggregator(page, "coles");
        log("coles: aggregator discounts done —", agg.length, "items");
        const aggIds = new Set(agg.map(i => i.id));
        const search = await scrapeAggregatorSearch(page, "coles", aggIds);
        const merged = new Map(agg.map(i => [i.id, i]));
        for (const s of search) {
          const prev = merged.get(s.id);
          if (!prev || s.price < prev.price) merged.set(s.id, s);
        }
        const items = [...merged.values()];
        if (items.length === 0) throw new Error("aggregator returned no Coles matches");
        feed.stores.coles = { source: "specials-catalogue", asOf: new Date().toISOString(), items };
        okCount++;
        log("coles: aggregator ok —", items.length, "items (discounts", agg.length, "+ search", search.length + ")");
      } catch (e2) {
        log("coles: aggregator stale —", e2.message);
        // Fallback 2: direct /catalogues (also challenge-gated).
        try {
          const specials = await scrapeColesSpecials(page);
          feed.stores.coles = { source: "specials-catalogue", asOf: new Date().toISOString(), items: specials };
          okCount++;
          log("coles: direct specials ok —", specials.length, "items");
        } catch (e3) {
          log("coles: direct specials also stale —", e3.message);
          if (feed.stores.coles && feed.stores.coles.asOf) feed.stores.coles.stale = true;
          else feed.stores.coles = { source: "unavailable", stale: true, items: [] };
        }
      }
    }

    try {
      const items = await scrapeStore(page, "woolworths", "woolworths");
      feed.stores.woolworths = { source: "scraped", asOf: new Date().toISOString(), items };
      okCount++;
      log("woolworths: ok —", items.length, "items");
    } catch (e) {
      log("woolworths: stale —", e.message);
      if (feed.stores.woolworths && feed.stores.woolworths.asOf) feed.stores.woolworths.stale = true;
      else feed.stores.woolworths = { source: "unavailable", stale: true, items: [] };
    }
  } catch (e) {
    log("browser failed:", e.message);
  } finally {
    if (ctx) await ctx.close();
  }

  // Aldi (HTTP) — weekly specials + everyday full-line prices
  try {
    const specials = await scrapeAldi();
    let everyday = [];
    try { everyday = await scrapeAldiFullLine(); } catch (ee) { log("aldi full-line skipped —", ee.message); }
    // merge: specials win; everyday fills in items with no special this week
    const byId = new Map(specials.map(s => [s.id, s]));
    for (const ev of everyday) { if (!byId.has(ev.id)) byId.set(ev.id, ev); }
    const merged = [...byId.values()];
    feed.stores.aldi = { source: "specials-catalogue", asOf: new Date().toISOString(), specials: merged };
    okCount++;
    log("aldi: ok —", merged.length, "prices (", specials.length, "specials +", everyday.length, "everyday):", merged.slice(0, 10).map(s => `${s.id} @ $${s.price}`).join(", "), merged.length > 10 ? "…" : "");
  } catch (e) {
    log("aldi: stale —", e.message);
    if (feed.stores.aldi && feed.stores.aldi.asOf) feed.stores.aldi.stale = true;
    else feed.stores.aldi = { source: "unavailable", stale: true, specials: [] };
  }

  feed.status = okCount > 0 ? "ok" : "stale";

  const outDir = path.join(REPO_DIR, "pwa", "data");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "prices.json"), JSON.stringify(feed, null, 2));
  log("feed written. status:", feed.status, "| fresh stores:", Object.keys(feed.stores).filter(s => !feed.stores[s].stale));

  if (canPush) pushFeed();
}

function main() {
  const onErr = (e) => console.error(redact(e && e.stack ? e.stack : e));
  if (PROBE) { probeAggregator().then(() => process.exit(0)).catch(e => { onErr(e); process.exit(1); }); return; }
  if (ONCE) { runOnce().then(() => process.exit(0)).catch(e => { onErr(e); process.exit(1); }); return; }
  const CRON_FULL = process.env.CRON_FULL || "0 19 * * *";       // 03:00 AWST daily
  const CRON_SPECIALS = process.env.CRON_SPECIALS || "0 0 * * 3"; // 08:00 AWST Wednesday
  cron.schedule(CRON_FULL, () => runOnce().catch(onErr), { timezone: "UTC" });
  cron.schedule(CRON_SPECIALS, () => runOnce().catch(onErr), { timezone: "UTC" });
  log("scheduler running. full:", CRON_FULL, "UTC | specials:", CRON_SPECIALS, "UTC");
  // run immediately on start so there's always a fresh feed after a reboot
  runOnce().catch(onErr);
}

main();

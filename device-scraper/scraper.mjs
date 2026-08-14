/**
 * Shopping App — home-device price feeder (v0.10)
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
 *   DELAY_MS             polite per-item delay (default 1200)
 *   HTTP_TIMEOUT         ms (default 20000)
 * `node scraper.mjs --once` runs a single scrape and exits.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "fs";
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

/* ---------------- catalogue + matching (shared with scraper/scrape.js) ---- */
const CATALOGUE = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8"));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim().split(" ");
const ALLOW = new Set(["pack","family","share","bag","block","blocks","strips","strip","premium","original","classic","italian","style","sweet","salted","extra","light","lite","full","cream","free","range","dried","tinned","canned","frozen","wild","instant","quick","long","grain","baby","whole","washed","loose","brown","red","white","green","yellow","black","blue","purple","pink","orange","sliced","diced","chopped","ground","grated","shredded","selection","quality","mix","bites","pieces","fillets","fillet","breast","breasts","thigh","thighs","mince","minced","lean","star","beef","pork","chicken","lamb","eggs","dozen","fresh","raw","cooked","large","small","medium","with","of","a","an","the","and","woolworths","coles","aldi","brand","branded","homebrand","rspca","approved","free-range","freerange","salted","unsalted","washed","loose"]);
const aliasesByItem = new Map();
for (const c of CATALOGUE) aliasesByItem.set(c.id, new Set([c.name.toLowerCase(), ...(c.aliases || []).map(a => a.toLowerCase())]));
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

/* ---------------- Coles & Woolworths (browser) -------------------------- */
async function warmUp(page) {
  for (const url of ["https://www.coles.com.au/", "https://www.woolworths.com.au/"]) {
    try { await page.goto(url, { waitUntil: "load", timeout: 60000 }); }
    catch (e) { log("warm-up visit failed:", url, e.message); }
    // Let any bot challenge (Akamai _abck / Incapsula) run and set its session
    // cookie, then nudge the page so the challenge completes.
    await new Promise(r => setTimeout(r, 4000));
    try { await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {}); } catch (e) {}
    await new Promise(r => setTimeout(r, 1500));
  }
}

/** Stealth browser launch. Headless Chromium is fingerprinted by Akamai /
    Incapsula, so use full Chromium (new headless, channel "chromium"), strip
    automation markers, and present a realistic locale/viewport/profile.
    HEADED=1 forces a headed run (pair with `xvfb-run` in the container). */
async function launchBrowser() {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const headed = process.env.HEADED === "1";
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: !headed,
    channel: "chromium",
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

/** Classless DOM extraction: find every "$X.XX" price node, then climb to the
    nearest product name nearby. Deliberately loose — the catalogue matcher is
    the real filter, so junk simply never matches. */
async function extractProducts(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const all = document.querySelectorAll("body *");
    for (const el of all) {
      const t = (el.textContent || "").trim();
      if (!t || t.length > 60) continue;
      const m = t.match(/\$\s?(\d+(?:\.\d{1,2})?)/);
      if (!m) continue;
      const price = parseFloat(m[1]);
      if (!isFinite(price) || price <= 0 || price > 100000) continue;
      // climb ancestors looking for a card that also contains a name
      let node = el, name = null;
      for (let i = 0; i < 9 && node && !name; i++) {
        const parent = node.parentElement;
        if (!parent) break;
        const cands = parent.querySelectorAll("h1,h2,h3,h4,a,strong,[class*='title'],[class*='name'],[class*='Title'],[class*='Name']");
        for (const c of cands) {
          const ct = (c.textContent || "").trim();
          if (ct.length > 3 && ct.length < 140 && !/\$\s?\d/.test(ct) && !/add|buy|basket|save|shop|view|wishlist/i.test(ct)) {
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
    return out.slice(0, 100);
  });
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

async function scrapeStore(page, store, label) {
  const results = [];
  const catalogue = QUICK ? CATALOGUE.slice(0, 3) : CATALOGUE;
  let tilesSeenTotal = 0;

  for (let i = 0; i < catalogue.length; i++) {
    const item = catalogue[i];
    let tiles = [];
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
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(4000);
        for (let s = 0; s < 4; s++) { await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {}); await page.waitForTimeout(600); }
      } finally {
        page.off("response", onResponse);
      }

      // 1) API data first (most reliable), then generic JSON, then DOM, then __NEXT_DATA__
      if (store === "woolworths" && apiData) tiles = parseWoolApi(apiData);
      if (tiles.length === 0 && apiData) tiles = scanProductsJson(apiData);
      if (tiles.length === 0) tiles = await extractProducts(page);
      if (tiles.length === 0) {
        const nd = await page.evaluate(() => { const el = document.getElementById("__NEXT_DATA__"); return el ? el.textContent : null; }).catch(() => null);
        if (nd) { try { tiles = scanProductsJson(JSON.parse(nd)); } catch (e) {} }
      }
      tilesSeenTotal += tiles.length;

      // match against the catalogue (primary: fuzzy alias match; fallback: substring)
      const direct = tiles
        .map(t => ({ ...t, matchedId: matchCatalogue(t.name) }))
        .filter(t => t.matchedId === item.id)
        .sort((a, b) => (a.price || 1e9) - (b.price || 1e9));
      let best = direct[0];
      if (!best) best = tiles.find(t => (t.name || "").toLowerCase().includes(item.search.toLowerCase()));

      if (best) {
        results.push({ id: item.id, name: best.name, price: num(best.price), wasPrice: best.wasPrice != null ? best.wasPrice : null, onSpecial: !!best.onSpecial });
        log(label, "ok:", item.id, "->", best.name, "$" + best.price);
      } else {
        log(label, "no match:", item.id, "(tiles:", tiles.length + ")");
      }

      if (i === 0) {
        const title = await page.title().catch(() => "(no title)");
        const finalUrl = page.url();
        log(label, "diagnostic — title:", JSON.stringify(title), "| url:", finalUrl, "| tiles:", tiles.length, "| sample:", tiles[0] ? JSON.stringify(tiles[0]) : "(none)");
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
      const items = await scrapeStore(page, "coles", "coles");
      feed.stores.coles = { source: "scraped", asOf: new Date().toISOString(), items };
      okCount++;
      log("coles: ok —", items.length, "items");
    } catch (e) {
      log("coles: stale —", e.message);
      if (feed.stores.coles && feed.stores.coles.asOf) feed.stores.coles.stale = true;
      else feed.stores.coles = { source: "unavailable", stale: true, items: [] };
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

  // Aldi (HTTP)
  try {
    const specials = await scrapeAldi();
    feed.stores.aldi = { source: "specials-catalogue", asOf: new Date().toISOString(), specials };
    okCount++;
    log("aldi: ok —", specials.length, "specials:", specials.map(s => `${s.id} @ $${s.price}`).join(", "));
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

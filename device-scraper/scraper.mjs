/**
 * Shopping App — home-device price feeder (v0.04)
 * ================================================================
 * Runs on an always-on device on your RESIDENTIAL IP, so it sails past the
 * bot walls (Akamai / Incapsula) that block datacenter IPs. A real Chromium
 * browser (Playwright) with a PERSISTENT PROFILE keeps the session warm —
 * no cookie copying, ever.
 *
 * What it does (nightly):
 *   1. Opens the browser, warms the session (visits each store's home page).
 *   2. Coles   — searches the catalogue, extracts names + prices from the page.
 *   3. Woolworths — same.
 *   4. Aldi    — plain HTTP fetch of Special Buys pages (no browser needed).
 *   5. Normalises to pwa/data/prices.json (same schema the app reads).
 *   6. git commit + push → Netlify auto-publishes → the app picks it up.
 *
 * Failure handling: per-store try/catch keeps last-known-good prices and
 * flags that store "stale". The app never breaks; it just shows "last known".
 *
 * Scheduling: node-cron. Defaults (UTC): full scrape daily 19:00 (= 03:00 AWST),
 * specials sweep Wed 00:00 (= 08:00 AWST). Override via CRON_FULL / CRON_SPECIALS.
 * `node scraper.mjs --once` runs a single scrape and exits.
 *
 * Honest note: store pages change. The extraction is deliberately DOM-crawl
 * based (name + $price) so minor redesigns don't kill it; a real break simply
 * marks the store stale and I patch it in a version bump.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
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
/* execSync wrapper that pipes output and redacts the error message, so a
   failed git command can never print the token. */
function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: "pipe", ...opts });
  } catch (e) {
    const err = new Error(redact(e.message || String(e)));
    err.status = e.status;
    throw err;
  }
}

/* ---------------- catalogue + matching (shared with scraper/scrape.js) ---- */
const CATALOGUE = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8"));
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim().split(" ");
const ALLOW = new Set(["pack","family","share","bag","block","blocks","strips","strip","premium","original","classic","italian","style","sweet","salted","extra","light","lite","full","cream","free","range","dried","tinned","canned","frozen","wild","instant","quick","long","grain","baby","whole","washed","loose","brown","red","white","green","yellow","black","blue","purple","pink","orange","sliced","diced","chopped","ground","grated","shredded","selection","quality","mix","bites","pieces","fillets","fillet","breast","breasts","thigh","thighs","mince","minced","lean","star","beef","pork","chicken","lamb","eggs","dozen","fresh","raw","cooked","large","small","medium","with","of","a","an","the","and"]);
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
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }); }
    catch (e) { log("warm-up visit failed:", url, e.message); }
    await new Promise(r => setTimeout(r, 1500));
  }
}

/** DOM-crawl extraction: find product cards and pull a name + a $price. */
async function extractProducts(page) {
  return page.evaluate(() => {
    const items = [];
    const seen = new Set();
    const cards = document.querySelectorAll('[data-testid*="product"], [class*="product-card"], [class*="productCard"], [class*="product-tile"], [class*="ProductCard"], article');
    for (const card of cards) {
      const nameEl = card.querySelector('h2, h3, [class*="title"], [class*="name"], a');
      const name = (nameEl && nameEl.textContent || "").trim();
      if (!name || seen.has(name)) continue;
      const priceEl = card.querySelector('[class*="price"], [class*="Price"]');
      const text = (priceEl && priceEl.textContent || card.textContent || "");
      const m = text.match(/\$\s?(\d+(?:\.\d{1,2})?)/);
      if (!m) continue;
      seen.add(name);
      items.push({ name: name.split("\n")[0].trim(), price: parseFloat(m[1]) });
    }
    return items.slice(0, 40);
  });
}

async function scrapeStore(page, baseUrl, label) {
  const results = [];
  for (const item of CATALOGUE) {
    try {
      const q = encodeURIComponent(item.search);
      const url = `${baseUrl}${q}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(2500);
      // lazy-load a little
      for (let i = 0; i < 3; i++) { await page.evaluate(() => window.scrollBy(0, 800)); await page.waitForTimeout(400); }
      const tiles = await extractProducts(page);
      const best = tiles.find(t => (t.name || "").toLowerCase().includes(item.search.toLowerCase())) || tiles[0];
      if (best) {
        results.push({ id: item.id, name: best.name, price: num(best.price), wasPrice: null, onSpecial: false });
        log(label, "ok:", item.id, "->", best.name, "$" + best.price);
      }
    } catch (e) {
      log(label, "failed for", item.id, "-", e.message);
    }
    await new Promise(r => setTimeout(r, DELAY_MS));
  }
  if (!results.length) throw new Error(label + ": no results — page structure may have changed");
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
    // Wipe any leftover non-git directory (e.g. a previous partial run) so the
    // clone has a clean, empty target.
    if (existsSync(REPO_DIR)) { log("clearing stale", REPO_DIR); rmSync(REPO_DIR, { recursive: true, force: true }); }
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
    mkdirSync(PROFILE_DIR, { recursive: true });
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      viewport: { width: 1280, height: 900 },
      userAgent: UA
    });
    const page = ctx.pages()[0] || await ctx.newPage();
    await warmUp(page);

    try {
      const items = await scrapeStore(page, "https://www.coles.com.au/search/products?q=", "coles");
      feed.stores.coles = { source: "scraped", asOf: new Date().toISOString(), items };
      okCount++;
      log("coles: ok —", items.length, "items");
    } catch (e) {
      log("coles: stale —", e.message);
      if (feed.stores.coles && feed.stores.coles.asOf) feed.stores.coles.stale = true;
      else feed.stores.coles = { source: "unavailable", stale: true, items: [] };
    }

    try {
      const items = await scrapeStore(page, "https://www.woolworths.com.au/shop/search/products?searchTerm=", "woolworths");
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

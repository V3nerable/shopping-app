# AGENT HANDOFF INSTRUCTIONS — Shopping App

> **This file is the long-term source of truth for this project.** Any agent
> taking over should read this first. The user-facing changelog lives in the
> deployment report of each release; this file keeps the technical detail.

---

## 1. What this app is

A local-first Progressive Web App (PWA) that turns a weekly/fortnightly meal
plan into price-optimised shopping lists split across stores.

- **Stores:** Coles + Woolworths (full-line prices) and Aldi (weekly Special
  Buys only). IGA was dropped by request; Spudshed & Farmer Jacks are parked
  for a later version.
- **Input:** reusable recipes (structured builder + free-text paste parser).
- **Engine:** aggregate plan → ingredients; unit-price comparison ($/kg, $/L,
  $/each) with pack-size-aware costing; smart-threshold routing ("move an item
  to another store only if it saves more than the threshold, capped at max
  stores").
- **Data:** localStorage (recipes, plan, settings, ticked items). Optional
  nightly price feed fetched from `data/prices.json` (network-first, cached,
  offline-safe).

## 2. Repository layout (drop these onto the repo root)

```
.github/workflows/update-prices.yml   ← fallback scraper cron (Aldi-only when device absent)
pwa/
  index.html                          ← THE APP (self-contained: inline CSS+JS+catalogue)
  manifest.webmanifest
  sw.js                               ← service worker (cache-first; prices.json network-first)
  data/prices.json                    ← price feed (seed data until the device/action is live)
  icons/                              ← 192/512/maskable/apple-touch PNGs
  AGENT_HANDOFF_INSTRUCTIONS.md       ← this file
scraper/
  package.json
  catalogue.json                      ← curated item list (id, name, aliases) — 207 items
  scrape.js                           ← Coles/Woolies/Aldi fetchers + normaliser (datacenter fallback)
device-scraper/
  Dockerfile / docker-compose.yml / scraper.mjs / .env.example / README.md
                                      ← home-device feeder (residential IP → real prices)
README.md
```

## 3. How to run / deploy

- **Netlify:** repo root, build command *none*, publish directory **`pwa`**.
  Every push auto-publishes. The app is fully static — no server needed.
- **Local preview:** `cd pwa && python3 -m http.server 8080` (SW + fetch need
  http://, not file://). Note: the in-app preview iframe has no network, so it
  uses the embedded seed catalogue — that's expected and fine.

## 4. How the price feed works (and how to fix it)

- The GitHub Action (`update-prices.yml`) runs `scraper/scrape.js` at 03:00 AWST
  (cron `0 19 * * *` UTC) and on manual dispatch. It writes
  `pwa/data/prices.json` and commits it. Netlify redeploys on push.
- **Scraper design:** "targeted" scraping — only the ~70 curated items in
  `scraper/catalogue.json` are refreshed, not whole catalogues.
- **No official APIs exist.** `scrape.js` uses the stores' own website JSON
  endpoints. These change and are bot-protected. Each store fetch is wrapped in
  try/catch; on failure that store is marked `stale` and the last-known-good
  prices are kept (partial success is fine). If the app shows "prices are
  stale", check the Action logs and update the endpoint/path/headers in
  `scrape.js`. Optional secrets: `COLES_COOKIE`, `WOOL_COOKIE` (repo settings →
  Secrets) if the endpoints start requiring a session cookie.
- **60-day rule:** GitHub disables scheduled workflows after 60 days of no repo
  activity. The manual "Run workflow" button is the safety net.
- **Cookie secrets (Coles & Woolworths):** both sites block datacenter IPs
  (Akamai / Incapsula). To unlock real full-line prices, grab a session cookie
  from your own browser once and save it as a repo secret
  (*Settings → Secrets and variables → Actions*): `WOOL_COOKIE` and
  `COLES_COOKIE`. How: open the site in a normal desktop browser → do one
  product search so the session is "warmed" → DevTools (F12) → Network →
  reload → click any request to `woolworths.com.au` (or `coles.com.au`) →
  Headers → Request Headers → copy the full `cookie:` value → paste as the
  secret. Cookies expire (days–weeks), so refresh when a store shows "stale"
  again. Aldi needs no cookie.
- **Feed schema:** `{ generatedAt, status: "ok"|"stale", currency, stores:
  { coles: {asOf, items:[{id,price,wasPrice,onSpecial,promo}]}, woolworths:
  {...}, aldi: {asOf, specials:[{id,price,size,until,note}]} } }`.
- The PWA merges the feed onto its embedded catalogue by `id`. Unknown ids are
  ignored — the feed and the embedded catalogue share the same source items, so
  they stay consistent.

## 5. Core engine notes (for anyone editing the logic)

- **Catalogue** lives at the top of the inline script in `index.html`
  (`const CAT`). Each item: `id, name, kind ("weight"|"volume"|"count"),
  aliases[], coles{...}, wool{...}` with `q` (pack size in `u`), `u`
  (kg|L|each), `p` (price), `w` (wasPrice), `s` (onSpecial), `l` (loose/produce).
  Aldi specials are `const ALDI_SPECIALS` (id, price, q, u, note, until).
- **Unit normalisation:** parser → `toBase()` (g / mL / each) →
  `convertToKind()` maps count→weight via `EACH_G` and volume↔weight via
  `DENS_GML` (e.g. "2 cups rice" → grams). Extend those two tables when adding
  items that are commonly entered in a different unit than they're sold.
- **Routing** (`buildShoppingList`): base store = full-line store with lowest
  total basket cost; then items move to another store only when saving
  `> threshold`, where `threshold = minSaving * (1/splitPref - 1)` for
  0 < splitPref < 1 (0 = fewest trips = never split; 1 = cheapest = split for
  any saving). `maxStores` caps distinct stores.
- **State keys** (localStorage): `sa_recipes`, `sa_plan`, `sa_settings`,
  `sa_checked`. Export/import produce `shopping-app-backup.json`.

## 6. Versioning rule (STRICT)

On every deploy command, bump the version by **exactly 0.01** in ALL of:
1. The visible `v0.XX` tag in `index.html` (footer on the More screen + the
   `<title>`). Use `sed`/explicit edit so the on-screen tag matches.
2. `manifest.webmanifest` (`"version"`).
3. `sw.js` (`const VERSION`).
4. The master zip name: `Shopping-App-v0.XX.zip`.
5. `scraper/package.json` (`"version"`) and `device-scraper/package.json`
   (`"version"`) — keep them aligned as `0.X.0` matching the app's minor
   (e.g. app v0.08 → `"0.8.0"` in both).
Then rebuild the zip with the full `pwa/` directory (including this file).

## 7. Changelog (technical, per version)

### v0.08 — 2026-08-14 (version alignment)
- Aligned the two scraper package versions with the app release number:
  `scraper/package.json` 0.1.0 → 0.8.0 and `device-scraper/package.json`
  0.4.0 → 0.8.0, so every file in the project now carries the same version.
- Updated §6 (Versioning rule) to include both package.json files so future
  bumps touch everything in one pass.
- App version → v0.08 (no functional changes).

### v0.07 — 2026-08-14 (device-scraper: mount-safe repo clear)
- Fixed "Error: Device or resource busy '/repo'": `/repo` is a Docker named
  volume (a mount point), so `rmSync(REPO_DIR)` fails. Replaced with a
  `clearDir()` helper that empties the directory's CONTENTS (readdirSync +
  per-entry rmSync) without deleting the mount point itself, leaving a clean
  target for `git clone`. Added `readdirSync` import.
- Version → v0.07.

### v0.06 — 2026-08-14 (device-scraper bugfixes)
- Playwright pinned to 1.62.1 in BOTH `device-scraper/Dockerfile`
  (`mcr.microsoft.com/playwright:v1.62.1-jammy`) and `package.json`
  (`"playwright": "1.62.1"` exact, no caret), plus `npx playwright install
  chromium` at image build — fixes the browser-launch failure
  ("Executable doesn't exist at /ms-playwright/chromium_headless_shell-1234/…")
  caused by npm drifting from ^1.44.0 to 1.62.1 while the image stayed 1.44.
- Fixed git-clone failure ("/repo already exists and is not an empty
  directory"): the feed is now written AFTER the repo is cloned/pulled.
  `gitSync()` split into `ensureRepo()` (clone-or-pull, wipes a stale non-git
  /repo first) + `pushFeed()`; `runOnce()` calls `ensureRepo()` before
  `loadLastGood()` and writes, then `pushFeed()` at the end.
- SECURITY: added `redact()` (scrubs `github_pat_*` and `x-access-token:***`)
  and a `run()` execSync wrapper that pipes output and redacts error messages,
  so a failed git command can never print the token into logs. All git calls
  and the top-level error handler now go through them.
- Version → v0.06.

### v0.05 — 2026-08-14 (onboarding & security hardening)
- Sample recipes are now surfaced on the empty states: the onboarding home
  screen (no recipes) and the empty Recipes list both get a
  **"Load 10 sample recipes"** button (new `data-action="load-samples"` case in
  `onAction` → `loadSampleRecipes()` + toast + re-render), so testing is obvious
  from first open instead of hidden behind the Recipes-tab Samples button.
- `.gitignore` hardened: ignores `.env`, `.env.local`,
  `device-scraper/repo/`, `device-scraper/profile/` (secrets + runtime
  artifacts must never be committed).
- Docs: device-scraper README gains a "Keep your token secret" section;
  DEPLOY_GUIDE Step 3 now stresses pushing the WHOLE project (not just `pwa`)
  and adds a secrets warning.
- Version → v0.05.

### v0.04 — 2026-08-13 (home-device price feeder + expanded catalogue)
- NEW `device-scraper/` — a self-contained feeder for an always-on device on a
  residential IP (bypasses the Akamai/Incapsula datacenter blocks):
  - `Dockerfile` (Playwright browser image + git), `docker-compose.yml`
    (persistent `profile` volume = warm session, `repo` volume = git clone,
    catalogue mounted read-only), `scraper.mjs`, `.env.example`, README
    (Docker / plain-Linux systemd / Windows Task Scheduler).
  - `scraper.mjs`: Playwright persistent-context Chromium; warm-up visits;
    DOM-crawl extraction (name + `$price` per product card — resilient to
    minor redesigns); Coles `search/products?q=` + Woolworths
    `shop/search/products?searchTerm=`; Aldi via the HTTP special-buys
    extractor (same as `scraper/scrape.js`); per-store stale/keep-last-good;
    git clone/pull → write `pwa/data/prices.json` → commit → push (auth via
    scoped `GH_TOKEN`, repo via `GH_REPO`); node-cron schedule defaults
    `0 19 * * *` UTC (03:00 AWST daily) + `0 0 * * 3` (08:00 AWST Wed);
    `--once` test mode.
  - Netlify tokens NOT needed: device only `git push`es; Netlify auto-publishes.
- Catalogue expanded 70 → 207 items (produce, meat/poultry/seafood, dairy,
  pantry, frozen, bakery, drinks, household staples) via `const CAT_EXTRA`
  pushed onto `CAT` before `CAT_BY_ID` is built. `EACH_G` and `DENS_GML`
  extended for the new items. Regenerated `scraper/catalogue.json` (207) and
  the seed `pwa/data/prices.json` from the same source (still deterministic).
- GitHub Action kept as fallback (now covers the 207-item catalogue).
- Version → v0.04.

### v0.03 — 2026-08-13 (live scraper wiring)
- Scraper rewritten against live endpoints:
  - **Aldi (works, no auth):** Special Buys are SSR'd on
    `https://www.aldi.com.au/special-buys/{YYYY-MM-DD}` (product tiles:
    `product-tile__name` + `base-price__regular`). The landing page
    (`/special-buys`) lists wave dates; the scraper fetches the current +
    next 2 waves and fuzzy-matches tile names to the catalogue (guarded
    matcher with an ALLOW qualifier list). Pack size parsed from the tile
    name ("1kg", "300g", "5 Pack"). Verified live: 2026-08-19 wave →
    "Italian Style Pork & Beef Sausages 1kg" $13.99, "Jasmine Rice 5kg" $11.99.
  - **Woolworths:** `POST https://www.woolworths.com.au/apis/ui/Search/products`
    (confirmed body: Filters/IsSpecial/Location/PageNumber/PageSize/SearchTerm/
    SortType). Akamai blocks datacenter IPs (403 or silent connection drop) →
    needs the `WOOL_COOKIE` repo secret.
  - **Coles:** Next.js site behind Imperva Incapsula. BuildId read from the
    homepage; data route `/_next/data/{buildId}/search/products.json?q={query}`.
    Needs the `COLES_COOKIE` repo secret (Incapsula challenge otherwise).
- Added HTTP timeouts (AbortController, `HTTP_TIMEOUT` env) + a `Blocked`
  short-circuit so a blocked store fails fast instead of retrying all 70 items.
- FIXED a latent feed bug: Aldi specials now use numeric `{q,u}` in the feed;
  the app's `applyFeed` also parses the legacy `size` string ("1kg"/"300g"/…)
  so an old cached feed can't produce NaN unit prices.
- App: `applyFeed` now guards null prices and records per-store freshness
  (`FEED_META.stores`); the More screen shows "live" vs "last known" per store.
- Generated `pwa/data/prices.json` with live Aldi specials + seed Coles/
  Woolworths (marked stale). Version → v0.03.

### v0.02 — 2026-08-13
- Preloaded 10 sample meal-prep recipes (`SAMPLE_RECIPES`), auto-seeded on
  first-ever run (guarded by `sa_samples_seeded` so intentional deletes don't
  resurrect them) and re-addable via the "🧪 Samples" button on the Recipes
  screen (merge-by-name, no duplicates).
- Parser hardened for copy-pasted recipes: strips checkbox/check/bullet glyphs
  (☐ ☑ ☒ ▢ • ✓ …), typed bullets (- – — *), "Step N:", and numbered-list
  markers ("1.", "2)", "3:") — with a dot-guard so "1.5 cups" is never eaten.
- Added prep-modifier vocabulary (`PREP_MODIFIERS`): comma fragments that are
  pure instructions ("diced", "grated", "finely chopped", "to taste",
  "for garnish") are dropped instead of becoming manual items. Later comma
  fragments are only kept when they look like another ingredient (starts with
  a qty or matches the catalogue).
- Added heading/non-item line filtering (`isHeadingLine`) for "Ingredients:",
  "Method:", "For the sauce:", "Serves 4", etc.
- Added "salt and pepper" → two items splitting (`splitAnd`) only when both
  halves match the catalogue.
- Hardened `matchCanonical`: containment and token-overlap matches now require
  leftover words to be qualifiers only (`RESIDUAL_OK` = STOPWORDS + DESCRIPTORS,
  deliberately excluding instruction verbs), and no-quantity lines that are
  titles (>2 words) or start with an instruction verb (`VERBS`) are dropped —
  so "Chicken Stir Fry" and "Cook the rice." no longer become items.
- `parseLine` strips trailing serving notes ("to taste", "for garnish"…) from
  display names.
- Version bumped to v0.02 (index title/footer/APP_VERSION, manifest, sw.js,
  README, DEPLOY_GUIDE).

### v0.01 — 2026-08-13 (initial release)
- Self-contained PWA in `pwa/index.html` (inline CSS + JS + ~70-item seed
  catalogue with Coles/Woolworths prices + 10 Aldi Special Buys).
- Screens: Shop (home), Plan (7/14-day per-day planner), Recipes (paste parser
  + builder), Specials, More (stores/split/threshold/theme/data/version).
- Engine: unit-price + pack-aware costing; smart-threshold split with
  split-preference slider, min-saving $, max-stores cap; per-item "Save $X vs
  Store" reasons; Aldi specials-only routing.
- Free-text parser with qty/unit extraction, "2 x 400g" handling, fuzzy
  canonical matching, count/volume/weight conversions.
- Service worker (cache-first shell; network-first price feed) + manifest +
  generated icons (192/512/maskable/apple-touch).
- Seed `data/prices.json` generated from the embedded catalogue.
- Scraper skeleton (`scraper/`) + GitHub Actions nightly workflow
  (`update-prices.yml`) with stale/partial-failure handling.
- Local-first; no Firebase sync yet (flagged for a later version).

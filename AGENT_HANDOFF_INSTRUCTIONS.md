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
   (e.g. when the app is `v0.XX`, both packages read `"0.X.0"`).
Then rebuild the zip with the full `pwa/` directory (including this file).

## 7. Changelog (technical, per version)

### v0.26 — 2026-08-15 (Aldi full-site scrape + Specials columns/filters)
- Aldi full-line scrape expanded to the WHOLE catalogue: `extractAldiTiles()`
  shared helper (also used by the specials scraper), and `scrapeAldiFullLine()`
  now walks `aldi.com.au/products?page=1..N` (SSR'd, ~30 products/page, ~110
  pages) until empty — `ALDI_MAX_PAGES` env (default 250, QUICK=2). Verified:
  4 pages → 120 products → 9 catalogue matches (Jasmine Rice $2.99, Diced
  Tomatoes $0.95, Dark Chocolate $4.49, Smoked Salmon $9.99, Brown Rice $2.49…).
- Specials screen rebuilt:
  - `buildAllSpecials()` — unified list of every item on special at an enabled
    store (Coles/Woolworths was-price, Aldi Special Buy), with `savePct` and
    `saveDol` computed; each entry tagged `inList` if it's in the current plan.
  - Store filter chips (All/Coles/Woolworths/Aldi) + saving filter chips
    (Any/10%+/25%+/50%+), module state `specialStore` / `specialSave`, wired
    via `data-action="special-filter-store|save"`.
  - Column layout: `.sp-head`/`.sp-row` CSS grid (Item | Store | Now·Save),
    strikethrough was-price, -N% save badge (or "Special Buy"/"Special"),
    "in your list" tag.
- Version → v0.26 (scraper + device-scraper package.json → 0.26.0).

### v0.25 — 2026-08-15 (recipe picker layout fix)
- Fixed the "+ Add meal" recipe picker: the "Add" button used `.btn.primary`
  which is `width:100%`, so inside the horizontal flex row it squashed the
  recipe name/"serves" into a tight left clump and overlapped the row. Each
  recipe is now a `.picker-item` block: heading line (emoji + name + serves)
  with the full-width Add button underneath it. The sheet title now shows the
  day name too ("Add a meal — Day 1 (Mon)") plus a helper line.
- New CSS: `.picker-item` / `.picker-head` (flex column of heading + button).
- Version → v0.25 (scraper + device-scraper package.json → 0.25.0).

### v0.24 — 2026-08-15 (app fixes + Aldi full-line)
- App UI fixes:
  - Version pill in the TOP bar (`#verPill`, set from `APP_VERSION` at init) so
    the version is always visible; synced by sed on future bumps.
  - "+ Add ingredient" button fixed: now `data-action="add-ingredient"`
    (event delegation) → appends a fresh `ingRowHtml(1,"","")` row to `#ingRows`.
    Was completely unbound before.
  - "🧪 Samples" button added to the Home summary card (visible even when a
    plan exists), next to "Threshold".
  - NEW move-item override: every shop row has a "↻" button → `openMoveSheet()`
    lists the item's options across stores (cheapest first, with $, unit price,
    pack, special flag) → "Move" saves `STATE.overrides[id]` (localStorage
    `sa_overrides`) → "Reset to auto" clears it. `buildShoppingList()` applies
    overrides after auto-routing (sets `manual:true`); rows show "Moved by you".
    Negative savings now show "custom moves cost $X extra" instead of a bogus
    save note. Reset-all also clears `sa_overrides`.
  - Plan "+ Add meal" layout fixed: meals now render in a `.meals` column above
    a full-width dashed "+ Add meal" button (was a cramped left-stacked chip).
    Meal chips are now full-width rows (name left, ×servings + ✕ right).
  - Aldi badge now shows the price's own note ("Special Buy" / "Everyday
    price") instead of a hardcoded "Aldi Special Buy"; the Specials screen
    splits Aldi Special Buys vs "Aldi everyday prices".
- Aldi FULL-LINE scraper (`scrapeAldiFullLine()`): HTTP fetch of
  `aldi.com.au/products` (SSR'd everyday products, reachable from datacenter),
  extracts product tiles, matches the catalogue, returns "Everyday price"
  entries. `runOnce()` merges specials + everyday (specials win) into
  `feed.stores.aldi.specials`. The app treats note==="Everyday price" as
  non-special (routes to Aldi like a normal store, not flagged as a deal).
  Verified live: Jasmine Rice 1kg $2.99, Diced Tomatoes 400g $0.95, Sunflower
  Oil 1L $4.99, Basa Fillets 1kg $6.99 matched the catalogue from the real page.
- Version → v0.24 (scraper + device-scraper package.json → 0.24.0).

### v0.23 — 2026-08-15 (device-scraper: FULL aggregator harvest for Coles)
- `parseAggProducts(data, store)` replaces `parseAggDiscounts`: handles the
  discounts `{sources:{woolies/coles/aldi}}` shape (priceHistory in cents),
  flat arrays, and `{results:[…]}` shapes, with a unit heuristic (price > 200 →
  cents) and store filtering.
- `scrapeAggregator` now paginates the WHOLE discounts API until empty
  (`AGG_PAGES` default 60, QUICK=2) — captures every special across chains.
- NEW `scrapeAggregatorSearch(page, storeFilter, alreadyHave)`: self-adapting
  per-item search — navigates `/products`, triggers a search (broad input
  detection, then URL-param fallback), captures the `/api/*` request the page
  makes, and replays it for every catalogue item not already covered. Logs the
  template URL, first-response sample, and progress every 25 items.
- `runOnce()` Coles chain now merges discounts + search (cheapest per id):
  `coles: aggregator ok — N items (discounts X + search Y)`. Direct browse
  remains first choice; direct /catalogues remains last fallback.
- Removed the `AGG_DISCOVER` flag/hook (search discovery is now automatic).
- Verified parser against 3 shapes (cents sources, dollar flat array, cents
  results) + store filter.
- Version → v0.23 (scraper + device-scraper package.json → 0.23.0).

### v0.22 — 2026-08-15 (device-scraper: ausgroceryprices.com harvester)
- The v0.21 probe found the aggregator's OPEN JSON API:
  `GET https://ausgroceryprices.com/api/v1/products/discounts/{page}` → 200,
  no auth. Response `{_id, sources:{woolies:[],coles:[],aldi:[],...}}` with
  products carrying `name` + `priceHistory[{availablePrice,defaultPrice}]`
  (prices in CENTS; "NOW $6.75 WAS $13.50" = 675/1350).
- Added `parseAggDiscounts(data)` (cents→dollars, was = defaultPrice when
  higher, onSpecial flag; `AGG_STORE_MAP` = woolies→woolworths, coles→coles,
  aldi→aldi) and `scrapeAggregator(page, storeFilter)`: visits `/discounts`,
  in-page fetches up to `AGG_PAGES` (default 10, QUICK=2) pages, matches tiles
  to the catalogue with the prepared/species guard, cheapest per store:id.
- `runOnce()` Coles chain is now: direct browse → **aggregator (coles
  specials)** → direct /catalogues. So Coles finally gets live specials.
- Added `discoverAggregatorSearch(page)` — probes 4 candidate search endpoints
  in-page and logs status + sample, to find a full-search route for later.
- Verified `parseAggDiscounts` against the exact probe payload: 5/5 tiles
  parsed, cents converted, specials flagged, catalogue matches correct.
- Version → v0.22 (scraper + device-scraper package.json → 0.22.0).

### v0.21 — 2026-08-15 (device-scraper: deep aggregator probe)
- Upgraded `probeAggregator()`: instead of only loading the homepage, it now
  visits `https://ausgroceryprices.com/products` and `/discounts`, captures
  EVERY `/api/*` request (method + URL) and logs each `/api/*` response's
  status + a 500-char sample. On `/products` it also does a best-effort search
  interaction (finds an input, types "chicken", presses Enter) so the site
  makes its real data calls. Logs final URL, title, and 400 chars of body.
  First probe confirmed: the site loads on the residential device, and a live
  API exists (`/api/v1/auth/me` → 401), so the product endpoint should be under
  `/api/v1/*`. This version finds its exact name + shape.
- Version → v0.21 (scraper + device-scraper package.json → 0.21.0).

### v0.20 — 2026-08-15 (device-scraper: CORRECT Coles browse route)
- Found the real Coles data route via the open-source project
  tjhowse/aus_grocery_price_database (powering auscost.com.au). The search
  route we were hitting (`/search/products.json`) is Incapsula-gated; the
  WORKING route is browse-by-category:
  `GET /_next/data/{buildId}/en/browse/{slug}.json?slug={slug}&page=N` with
  header `x-nextjs-data: 1`. Response: `pageProps.searchResults.results[]`,
  keep `_type === "PRODUCT"`, read `name` + `pricing.now/was/onlineSpecial`.
- Added `parseColesBrowse()` (parses the above; treats was<=0 as no-prev-price)
  and `scrapeColesBrowse(page)`: visits `/browse`, reads `buildId` from
  `__NEXT_DATA__`, in-page fetches pages of `COLES_CATEGORIES`
  (meat-seafood, fruit-vegetables, dairy-eggs-fridge, bakery, deli, pantry,
  drinks, frozen, household), matches tiles to the catalogue with the
  prepared/species guard, cheapest per item. `COLES_MAX_PAGES` env (default 3,
  QUICK=1 page of 2 categories).
- `runOnce()` Coles now uses `scrapeColesBrowse` as PRIMARY (source "scraped"),
  with the /catalogues specials pass as fallback.
- VERIFIED against the repo's real `fruit-vegetables_1.json`: 47 products
  parsed, 20 matched our catalogue (Broccoli $1.19, Green Zucchini $1.18,
  Carrots Loose $0.42, Iceberg Lettuce $2.9, Strawberries $2.9 …).
- Version → v0.20 (scraper + device-scraper package.json → 0.20.0).

### v0.19 — 2026-08-15 (device-scraper: match guard expansion + aggregator probe)
- Match guard widened: `NEG_WORDS` now also rejects "diced/chopped/sliced/
  strips/minced/coated/battered/seasoned/flavoured/crumb(s)" (still allowed
  when the word is part of the item's own name/aliases, e.g. "diced tomatoes").
  FIXED a guard bug: the prepared/species check was substring-based, so
  `"strip"` matched inside `"strips"` and wrongly rejected "Beef Stir Fry
  Strips" for beef-strips. Now token-based (`norm(t.name)`), so only whole
  words trigger it. Verified 12/12 cases (rejects diced/sliced/strips/minced/
  shredded/mixed-species chicken+beef tiles; accepts fillet/fillets/beef mince/
  beef stir-fry strips/diced tomatoes/smoked salmon).
- New `PROBE=1` mode: `probeAggregator()` loads grocery-aggregator sites
  (ausgroceryprices.online / .com) in the device's real browser, logs page
  title + body (Cloudflare block check), and every JSON/API request the page
  makes (method, URL, status, content-type, truncated sample) — to judge
  whether an aggregator exposes an API we could piggyback on for Coles.
  No scraping or pushing in this mode. Runs before `--once` and exits.
- Version → v0.19 (scraper + device-scraper package.json → 0.19.0).

### v0.18 — 2026-08-15 (device-scraper: native Chrome + match accuracy)
- NATIVE_CHROME=1: `launchBrowser()` now uses `channel: "chrome"` (the
  system-installed Google Chrome) instead of the bundled Chromium, and logs the
  channel/headless/platform. For the Coles Incapsula wall — real Windows Chrome
  is the most human-like fingerprint available. Documented in README with full
  PowerShell steps (Node via winget, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, QUICK
  test run without a token, then full run with GH_TOKEN/GH_REPO).
- Coles reload-on-challenge: after the ~20s poll, if still challenged, does ONE
  `page.reload()` + 5s wait + 10s poll (Incapsula often sets its session cookie
  on the first challenge and lets the reload through).
- Match-accuracy fix: new `NEG_WORDS` + `SPECIES` sets and a score-based
  selection in `scrapeStore` — a tile is rejected if it mentions a
  prepared-word ("shredded"/"crumbed"/"cooked"/… ) or a species word
  ("pork"/"beef"/…) that isn't in the item's own name/aliases, so
  "Shredded Chicken Breast" can no longer stand in for chicken-breast and
  "Pork & Beef Mince" can't stand in for beef-mince. Prefers exact catalogue
  match (3) > substring (2) > name (1), tie-break cheapest. Verified: 8/8 cases
  (rejects the two wrong matches, accepts fillet/mince/rice/thigh/smoked-salmon).
- cleanStaleProfileLocks() skips the Linux-only /proc liveness check on win32.
- Version → v0.18 (scraper + device-scraper package.json → 0.18.0).

### v0.17 — 2026-08-14 (device-scraper: exact-key Woolworths parser)
- The raw API sample finally revealed the real Woolworths shape:
  `{"Products":[{"Products":[{…tiles…}]}]}` — double-wrapped. Rather than rely
  on the structural finder, added `parseWoolAny(data)`: walks every object and
  keeps any carrying an EXACT name key (`Name`/`DisplayName`/`Title`, any case)
  plus a real pack price (`Price` → `InstorePrice` → first non-cup/unit/
  incremental/label `*price*` key). Unit-price labels ("Price per Kg charged",
  CupPrice, IncrementalPrice) can no longer be mistaken for products.
- Woolworths extraction order is now `parseWoolAny` → `parseWoolApi` →
  `parseAnyProducts` (in-page API and `__NEXT_DATA__` paths both).
- New diagnostic when tiles===0: logs the top-level API keys and
  `Products` isArray/length, so the wrapper shape is visible next run.
- Verified against the exact real payload: 39/39 products extracted with real
  names and pack prices.
- Version → v0.17 (scraper + device-scraper package.json → 0.17.0).

### v0.16 — 2026-08-14 (device-scraper: dict/Apollo-state product finder)
- New clue from v0.15 log: `apiNote: data, tiles=0` — the in-page API returned
  JSON but no parser found a product array. `findProductArray()` only scanned
  ARRAYS; Woolworths stores results as a keyed DICTIONARY (Apollo
  `__APOLLO_STATE__` / Redux `byId`), which it now also detects:
  - `isProductLike()` shared helper (name-ish string + price-ish numeric,
    excluding dunder keys like `__typename`).
  - Object nodes are now scored by how many of their VALUES are product-like;
    a dict with ≥2 product values becomes the collection.
  - `parseAnyProducts()` name/price/was key detection now ignores `__`-prefixed
    keys (fixes "Product" being read as the name from `__typename`).
- Raw API sample: when tiles===0 but the in-page fetch returned data, the
  diagnostic now logs the first 600 chars of the raw JSON, so the exact shape
  is visible next run instead of another guess.
- apiNote now always includes the HTTP status ("status 200, tiles=0").
- Coles specials pass now uses `parseAnyProducts` too.
- Verified in a logic test: parses Apollo dicts, Redux byId stores, and plain
  arrays, all with real names/prices.
- Version → v0.16 (scraper + device-scraper package.json → 0.16.0).

### v0.15 — 2026-08-14 (device-scraper: self-adapting product parser)
- Root cause: `parseWoolApi` hardcoded the key `Products[].Name/Price`, but the
  live API response doesn't use that shape, so the generic scanner grabbed junk
  ("Price per Kg charged") objects. Added a structure-based parser:
  - `findProductArray(data)` — walks any JSON blob and returns the array whose
    elements look most like products (objects with BOTH a name-ish string field
    and a price-ish numeric field), scoring each array and picking the best
    (so a junk array never beats the real product list).
  - `parseAnyProducts(data)` — maps that array to tiles with flexible
    name/price/was key detection per element (case-insensitive), and carries
    `_keys` on each tile for diagnostics.
- Extraction order now: in-page API (parseWoolApi/parseColesData fast-path, then
  parseAnyProducts) → `__NEXT_DATA__` (same chain) → intercepted responses →
  DOM walk.
- Diagnostic on the first item now always logs `apiNote` (data/status) and the
  sample tile's `_keys`, so if it STILL misses, the next log shows the exact
  key names.
- Verified in a logic test: extracts real products from nested/camelCase/mixed
  shapes and correctly rejects the junk array.
- Version → v0.15 (scraper + device-scraper package.json → 0.15.0).

### v0.14 — 2026-08-14 (device-scraper: Woolies __NEXT_DATA__ + Coles specials)
- Woolworths fix: the page's server-rendered `__NEXT_DATA__` (confirmed present
  via ground-truth, `hasNextData: true`) is now scanned BEFORE the DOM walk,
  which was winning with junk unit-price labels ("Price per Kg charged"). New
  extraction order: in-page API → `__NEXT_DATA__` (parseWoolApi on the blob +
  props.pageProps, then parseColesData, then scanProductsJson) → intercepted
  responses → DOM walk. In-page API now logs "yielded no tiles — status/…" so a
  silent miss is visible.
- Coles: after landing on search, polls up to ~20s for `__NEXT_DATA__`/body
  text (Incapsula sometimes self-solves and reloads).
- Coles specials fallback: `scrapeColesSpecials()` visits `/catalogues` (which
  answered 200 with `__NEXT_DATA__` + `product-tile` markers from datacenter),
  scans its JSON + DOM, fuzzy-matches special-priced products to the catalogue
  (cheapest wins), and returns onSpecial items. `runOnce()` falls back to it
  when full-line Coles fails, emitting `source: "specials-catalogue"` for Coles.
- Version → v0.14 (scraper + device-scraper package.json → 0.14.0).

### v0.13 — 2026-08-14 (device-scraper: in-page API + self-heal + ground truth)
- Profile-lock self-heal: `cleanStaleProfileLocks()` deletes Chromium's
  `SingletonLock/SingletonCookie/SingletonSocket` when the lock's PID is no
  longer alive, so a crash/power-cut can't block the next launch ("profile
  appears to be in use"). Logs when a lock is still live. README now says to
  `docker compose stop` before one-off runs (shared profile volume).
- In-page same-origin API fetch (the deterministic path): `fetchInPage()` runs
  `fetch()` INSIDE the loaded page with session cookies attached.
  - Woolworths: POST `/apis/ui/Search/products` → `parseWoolApi()`.
  - Coles: reads `buildId` from `__NEXT_DATA__` then GETs
    `/_next/data/{buildId}/search/products.json?q=…` → `parseColesData()`.
  Fallbacks preserved: intercepted responses, DOM walk, `__NEXT_DATA__` scan.
- Ground-truth dump (`dumpGroundTruth()`): on the first item, logs readyState,
  hasNextData, hasMainIframe, bodyChildren, bodyText, first 8 product-ish
  links, first 8 `$` nodes (tag/class/text), and window state globals — so the
  next fix uses exact selectors instead of guesses.
- Version → v0.13 (scraper + device-scraper package.json → 0.13.0).

### v0.12 — 2026-08-14 (device-scraper: headed default + name extraction)
- BREAKTHROUGH (user's device): headed Chromium under a manually-started Xvfb
  cleared Akamai — Woolworths returned the real search page ("Chicken Breast -
  Woolworths Online", 36 tiles). Two bugs fixed on top:
  - Extraction was pairing prices with unit-price labels ("Price per Kg
    charged") instead of product names. `extractProducts(page, store)` now
    prefers product-detail links (`a[href*="/shop/productdetails/"]` for
    Woolworths, `a[href*="/product/"]` for Coles) — name from the link/heading,
    price from the tile — with the `$`-climb as fallback and "per kg/100g/each"
    labels excluded.
  - Coles still served an empty shell; now uses `waitUntil: "networkidle"` +
    6s settle + 6 scrolls per search, longer 8s homepage warm-up, warm-up
    title logging, and a `body snippet` diagnostic when tiles===0 so we can see
    exactly what Coles is serving.
- Headed is now the DEFAULT (`HEADLESS=1` to opt out). `launchBrowser()`:
  `headless = process.env.HEADLESS === "1"`.
- Entrypoint rewritten to use the proven manual Xvfb approach (start `Xvfb :99`
  + `DISPLAY=:99`) instead of `xvfb-run`, which hung.
- README + compose comments updated.
- Version → v0.12 (scraper + device-scraper package.json → 0.12.0).

### v0.11 — 2026-08-14 (device-scraper: entrypoint/xvfb fix)
- Fixed a Dockerfile bug: `ENTRYPOINT ["node", "scraper.mjs"]` swallowed any
  command passed to `docker compose run scraper <cmd>`, so the documented
  `xvfb-run node scraper.mjs --once` never actually ran xvfb and headed mode
  crashed with "Missing X server or $DISPLAY".
- Replaced it with `docker-entrypoint.sh` (wraps the command in
  `xvfb-run -a` when `HEADED=1`, else execs as-is) + `CMD ["node",
  "scraper.mjs"]`. Now `docker compose run scraper <cmd>` works as expected and
  headed mode needs no `--entrypoint` hack.
- Added `xvfb` to the image's apt packages (explicit, even though the Playwright
  base image usually ships it).
- README headed-mode instructions updated.
- Version → v0.11 (scraper + device-scraper package.json → 0.11.0).

### v0.10 — 2026-08-14 (device-scraper: anti-bot stealth)
- Root cause found via v0.09 diagnostics: Woolworths returned `title: "Access
  Denied"` (Akamai) and Coles an empty shell (Incapsula) — headless Chromium
  is fingerprinted even on a residential IP. Fixes in
  `device-scraper/scraper.mjs`:
  - New `launchBrowser()`: full Chromium via `channel: "chromium"` (new
    headless, not the detectable `chromium-headless-shell`), args
    `--disable-blink-features=AutomationControlled --no-sandbox
    --disable-dev-shm-usage`, realistic `viewport 1366x900`, `locale en-AU`,
    `timezoneId Australia/Perth`, and an `addInitScript` stripping
    `navigator.webdriver`, spoofing `languages`/`plugins`, adding `window.chrome`.
    No more forced `userAgent` (Playwright's default UA now matches the
    bundled Chromium, removing a fingerprint mismatch).
  - `HEADED=1` env forces a headed run (pair with `xvfb-run` inside the
    container) as the nuclear anti-bot option; documented in README + compose.
  - `warmUp()`: waits for `load`, settles 4s so the Akamai/Incapsula challenge
    can run and set its session cookie, then scrolls.
  - Scrape loop: 4s settle + 4 scrolls, 60s goto timeout, and on the first
    item logs title + final URL + tile count + a BOT-CHALLENGE warning when the
    title matches challenge patterns.
- Version → v0.10 (scraper + device-scraper package.json → 0.10.0).

### v0.09 — 2026-08-14 (device-scraper: resilient extraction)
- Rewrote the Coles/Woolworths extraction (`device-scraper/scraper.mjs`). The
  old CSS-class selectors matched nothing (both stores use obfuscated class
  names), so both stores came back "no results". New approach — extract
  loosely, match strictly:
  - `extractProducts()`: classless DOM walk — find every `$X.XX` text node,
    climb ancestors to the nearest product name. Junk is fine; the matcher
    filters it.
  - Woolworths: intercepts the page's own `/apis/ui/Search/products` JSON
    response (real browser + residential IP passes Akamai) and parses
    `Products[].Name/Price/WasPrice/IsSpecial` via `parseWoolApi()`.
  - Coles (and any Next.js store): `scanProductsJson()` recursively harvests
    {name, price} objects from any intercepted JSON response, then falls back
    to `window.__NEXT_DATA__`, then to the DOM walk.
  - Matching: `matchCatalogue()` fuzzy alias match per tile (ALLOW set extended
    with store brands: woolworths/coles/aldi/rspca/approved/free-range…), plus
    a substring fallback; picks the cheapest matching tile.
  - Fail-fast: zero tiles across the first 3 items aborts the store (~30s)
    instead of grinding 207 items.
  - Diagnostics: first-item log line with page title, tile count, and a sample
    tile; per-item `ok:` / `no match:` lines; end-of-store summary.
- `QUICK=1` env mode: scrapes only 3 items per store (verification in ~1 min);
  documented in the header + docker-compose comments.
- Git commands now time out (120s) via the `run()` wrapper so a hung clone
  fails fast with "command timed out" instead of hanging silently.
- Version → v0.09 (scraper + device-scraper package.json → 0.9.0).

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

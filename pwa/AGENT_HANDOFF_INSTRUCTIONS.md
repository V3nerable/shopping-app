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
.github/workflows/update-prices.yml   ← nightly scraper cron + manual dispatch
pwa/
  index.html                          ← THE APP (self-contained: inline CSS+JS+catalogue)
  manifest.webmanifest
  sw.js                               ← service worker (cache-first; prices.json network-first)
  data/prices.json                    ← price feed (seed data until scraper is live)
  icons/                              ← 192/512/maskable/apple-touch PNGs
  AGENT_HANDOFF_INSTRUCTIONS.md       ← this file
scraper/
  package.json
  catalogue.json                      ← curated item list (id, name, aliases)
  scrape.js                           ← Coles/Woolies/Aldi fetchers + normaliser
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
Then rebuild the zip with the full `pwa/` directory (including this file).

## 7. Changelog (technical, per version)

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

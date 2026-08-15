# Shopping App — v0.23

Meal prep → price-optimised shopping lists, split across **Coles, Woolworths
and Aldi** by cheapest unit price.

Local-first PWA. Enter your weekly/fortnightly meal prep; the app aggregates the
ingredients, compares **unit prices** ($/kg, $/L, $/each) across stores, and
routes each item to the cheapest store — only when the saving clears your
threshold and never beyond your store cap.

## Repo layout

| Path | Purpose |
| --- | --- |
| `pwa/` | The app (deploy target). `index.html` is fully self-contained. |
| `pwa/data/prices.json` | Price feed (seed data until the scraper is live). |
| `scraper/` | Nightly Coles/Woolies/Aldi price scraper. |
| `.github/workflows/update-prices.yml` | Scheduled scraper (03:00 AWST daily + manual). |
| `pwa/AGENT_HANDOFF_INSTRUCTIONS.md` | Long-term technical source of truth. |

## Deploy (Netlify)

1. Push this repo to GitHub (enable Actions under *Settings → Actions*).
2. On Netlify: **New site from Git** → pick the repo → publish directory **`pwa`** → deploy.
3. Every push auto-publishes; the price feed refreshes via the scheduled Action.

## Local

```bash
cd pwa && python3 -m http.server 8080   # open http://localhost:8080
```

> Prices are illustrative seed data. The GitHub Action replaces them with
> scraped store prices once live.

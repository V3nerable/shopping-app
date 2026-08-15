# Home-device price feeder

Runs on an always-on device **at your house** (Mini PC / Pi / NAS) so the
Shopping App gets real, automatically-refreshed Coles + Woolworths + Aldi
prices **without anyone ever touching a cookie again**.

## Why this works when GitHub Actions doesn't

The stores block **datacenter IPs** (Akamai / Incapsula). Your home device uses
your **residential IP** and a **real Chromium browser** with a **persistent
profile** — it looks like a normal shopper. Sessions stay warm across restarts,
so there's no manual cookie step, ever.

## How it connects

```
Mini PC ──scrapes──▶ prices.json ──git push──▶ your GitHub repo
                                                  │ (webhook)
                                                  ▼
                                    Netlify auto-publishes ──▶ mum's phone
```

- The device only needs a **GitHub PAT scoped to this one repo** (Contents → Read & Write).
- **No Netlify tokens, no open ports, no Tailscale.** The phone always loads
  from Netlify; your home network is never exposed.
- If the device is ever off, the app falls back to "last-known prices"
  (already built into the app).

---

## Option A — Docker (recommended)

**Prereqs:** Docker + Docker Compose on the device.

1. **Create a fine-grained PAT:** GitHub → *Settings → Developer settings →
   Personal access tokens → Fine-grained tokens* → give it access to **only**
   your `shopping-app` repo → permission **Contents: Read & Write**.

2. **Configure:**
   ```bash
   cd device-scraper
   cp .env.example .env
   # edit .env: paste GH_TOKEN and set GH_REPO=yourname/shopping-app
   ```

3. **Start:**
   ```bash
   docker compose up -d --build
   ```

4. **Verify:** `docker compose logs -f` — you should see it warm up, scrape,
   write the feed, and push. Then `git pull` on your machine and check the
   commit landed.

5. **Update later:** `docker compose build --pull && docker compose up -d`.

**Test a single run (no scheduler):**
```bash
docker compose run --rm -e RUN_ONCE=1 scraper node scraper.mjs --once
```

**Quick verification (only 3 items per store, ~1 minute):**
```bash
docker compose stop                    # stop the scheduler first — both share the profile volume
docker compose run --rm -e QUICK=1 -e RUN_ONCE=1 scraper node scraper.mjs --once
```
> The scheduler and a one-off run both mount the same `profile` volume, so
> always stop the scheduler first. Stale locks left by a crash are removed
> automatically at launch.

**Headed by default:** the stores block headless browsers, so the scraper now
runs **headed Chromium under a virtual display automatically** (the container
entrypoint starts Xvfb). No extra flags needed.

**Force truly headless** (only useful for Aldi-only runs):
```bash
docker compose run --rm -e QUICK=1 -e HEADLESS=1 -e RUN_ONCE=1 scraper node scraper.mjs --once
```

## Option B — Plain Linux (no Docker)

1. Install Node 18+ and Chromium:
   ```bash
   sudo apt update && sudo apt install -y nodejs npm chromium-browser
   # Playwright needs its own browser: npx playwright install chromium --with-deps
   ```
2. `cd device-scraper && npm install`
3. Copy `.env.example` → export the vars (GH_TOKEN, GH_REPO).
4. Test: `node scraper.mjs --once`
5. Schedule with systemd (the script also self-schedules via node-cron, so a
   plain `systemd` service that just runs `node scraper.mjs` and restarts on
   failure is enough).

Example unit (`/etc/systemd/system/shopping-feeder.service`):
```ini
[Unit]
Description=Shopping price feeder
After=network-online.target

[Service]
WorkingDirectory=/home/you/device-scraper
EnvironmentFile=/home/you/device-scraper/.env
ExecStart=/usr/bin/node scraper.mjs
Restart=always

[Install]
WantedBy=multi-user.target
```

## Option C — Windows

1. Install Node LTS + Google Chrome.
2. `cd device-scraper && npm install`
3. Set the env vars in a `set-env.bat`:
   ```bat
   set GH_TOKEN=github_pat_...
   set GH_REPO=yourname/shopping-app
   ```
4. Schedule with Task Scheduler → run `node scraper.mjs` at logon / daily
   (the script self-schedules the actual scrape times via node-cron).

---

## Keep your token secret

- The `GH_TOKEN` goes **only** into `.env` on this device. Never paste it into
  chat, an issue, a commit, or the zip — anything shared. If it ever leaks,
  revoke it immediately (GitHub → Settings → Developer settings → Personal
  access tokens) and generate a fresh one.
- `.env` is already listed in the repo's `.gitignore`, so a normal
  `git add .` won't commit it — but double-check with `git status` before
  pushing if you're unsure.

## Windows native run — real Chrome (the Coles attempt)

Coles is gated by Incapsula, which detects the *containerised* browser even on
a residential IP. The strongest counter is running the scraper **natively on
Windows with your real, installed Google Chrome** — the most human-like
fingerprint there is.

```powershell
# 1. Install Node if missing (then close & reopen PowerShell):
winget install OpenJS.NodeJS.LTS

# 2. Get the project files locally (zip or git clone) and enter the folder:
cd C:\Users\beaum\shopping-app\device-scraper

# 3. Install deps WITHOUT downloading Playwright browsers (we use system Chrome):
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1"
npm install

# 4. Quick Coles test (no git push — just watch the log):
$env:QUICK="1"
$env:NATIVE_CHROME="1"
node scraper.mjs --once

# 5. Full run + push (add your token + repo):
$env:GH_TOKEN="github_pat_...."
$env:GH_REPO="V3nerable/shopping-app"
$env:NATIVE_CHROME="1"
node scraper.mjs --once
```

Notes:
- Requires Google Chrome installed (it almost certainly is).
- The profile lives in `device-scraper/profile` — a fresh one each first run.
- If Coles still shows `hasMainIframe: true` after this, the challenge is
  tied to the profile age/behaviour — the next escalation is pointing
  `PROFILE_DIR` at your real Chrome user-data dir (Chrome must be closed).

### Probe an aggregator for a usable API (diagnostics only)

To see whether a grocery-aggregator site (e.g. ausgroceryprices) exposes an
internal JSON API we could piggyback on for Coles:

```powershell
cd C:\Users\beaum\shopping-app\device-scraper
$env:PROBE="1"; $env:NATIVE_CHROME="1"; node scraper.mjs --once
```

It loads the site in real Chrome, logs the page title/body (block check), and
lists every JSON/API request the page makes — paste that log back to decide.

## Schedule
| Task | Default (UTC) | Your time (AWST) |
|---|---|---|
| Full scrape (Coles + Woolworths + Aldi) | daily `0 19 * * *` | **03:00** |
| Specials sweep (catalogue rotation day) | Wed `0 0 * * 3` | **08:00** |

Override with `CRON_FULL` / `CRON_SPECIALS` in `.env`.

## Extending the catalogue

The item list lives in `scraper/catalogue.json` (one JSON object per item:
`id`, `name`, `search`, `aliases`). Add an item there and the feeder picks it
up on the next run — but also add it to the app's built-in catalogue in
`pwa/index.html` (`const CAT_EXTRA`) so the app can use it offline.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `coles: no results` / `woolworths: no results` | A store redesigned its page — the feed goes "stale" (app keeps working); ping the agent to update the selectors. |
| Nothing pushes | Check `GH_TOKEN` scope (Contents: Read & Write) and `GH_REPO` spelling. |
| Browser crashes | Rebuild the image (`docker compose build --pull`); Playwright needs its browsers. |
| Store shows a CAPTCHA | Rare on residential IPs; solve it once in a headed run (`headless: false` in `scraper.mjs`) and the profile remembers. |

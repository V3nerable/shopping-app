# Shopping App — Full Deploy Guide (from zero)

Follow these steps in order. You currently have nothing set up — no GitHub
account/repo, no Netlify. This takes you from zero to a live app on your phone.

**App version: v0.24 · Everything ships in `Shopping-App-v0.24.zip`**

---

## Step 0 — What you'll need

- A free **GitHub** account → https://github.com/signup
- A free **Netlify** account → https://app.netlify.com/signup (sign up with your GitHub account — it makes Step 5 one click)
- The file `Shopping-App-v0.24.zip` (download it from the workspace)

---

## Step 1 — Download & unzip the app

1. Download `Shopping-App-v0.24.zip` and unzip it.
2. You'll get a folder containing:
   - `pwa/` — the app itself
   - `scraper/` — the nightly price scraper
   - `.github/` — the scheduled workflow (⚠️ hidden on Mac — see below)
   - `README.md`
   - `.gitignore`

**On Mac:** `.github` and `.gitignore` are dot-prefixed, so Finder hides them.
Press **Cmd + Shift + .** (period) to reveal hidden files, or just use the git
method in Step 3 (Option B), which picks them up automatically.

---

## Step 2 — Create the GitHub repository

1. Log in to GitHub → click the **+** (top right) → **New repository**.
2. **Repository name:** e.g. `shopping-app`.
3. **Public or Private:** either works. Private keeps your meal plans private.
4. **Do NOT** tick "Add a README / .gitignore / license" (keeps the next step clean — you already have those files).
5. Click **Create repository**. You'll land on an empty-repo page — keep it open.

---

## Step 3 — Put the files into the repo

### Option A — Web upload (no terminal, simplest)

1. On the empty-repo page, click **uploading an existing file** (or **Add file → Upload files**).
2. Drag **everything from the unzipped folder** (the `pwa` folder, `scraper` folder, `device-scraper` folder, `.github` folder, `README.md`, `DEPLOY_GUIDE.md`, `.gitignore`) into the box. GitHub's uploader preserves folder structure.
   - ⚠️ **Push the whole project, not just `pwa`.** The repo holds the app, the scrapers, the catalogue, the docs and the workflows; Netlify publishes only `pwa/` out of it, and the device/Action read the rest. If the repo is incomplete (e.g. only `pwa`), the device scraper and fallback feed won't exist.
   - If your browser won't accept folders, upload file-by-file, recreating the folder names exactly (`pwa/`, `scraper/`, `device-scraper/`, `.github/workflows/`).
3. Click **Commit changes** (leave the default message).

### Option B — Git command line

```bash
# inside the unzipped folder (where pwa/, scraper/, .github/ live)
git init
git add .
git commit -m "Shopping App v0.24"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/shopping-app.git
git push -u origin main
```

> `git add .` automatically includes the hidden `.github` and `.gitignore` files.

---

## Step 4 — Turn on GitHub Actions (so prices can refresh)

1. In your repo: **Settings → Actions → General**.
2. Under **Actions permissions**: select **Allow all actions and reusable workflows** → **Save**.
   (If this stays on "Disable Actions", the price feed silently never runs.)
3. Optional but recommended — under **Workflow permissions**, choose **Read and write permissions** → **Save**. (The workflow already requests write access, but this avoids any override.)
4. Test it immediately: go to the **Actions** tab → click **Update prices** (left sidebar) → **Run workflow → Run workflow** (green button).
5. Watch the run. It should show `colours/woolworths` fetches being attempted. First run may partially fail ("stale") because the scraper endpoints are a skeleton until we verify them against live store sessions — **that's fine**, the app still works off its built-in prices. The important thing is the workflow *runs* and commits `pwa/data/prices.json`.

**Unlock real Coles & Woolworths prices (recommended):** both sites block automated
servers, so add a session cookie from your own browser once:
1. In a normal desktop browser, open `woolworths.com.au` and do one product search (same for `coles.com.au`).
2. Press **F12** → **Network** tab → reload the page.
3. Click any request going to `woolworths.com.au` (or `coles.com.au`) → **Headers** → **Request Headers** → copy the whole `cookie:` value.
4. Repo → **Settings → Secrets and variables → Actions → New repository secret**:
   - name `WOOL_COOKIE`, paste the Woolworths cookie
   - name `COLES_COOKIE`, paste the Coles cookie
5. Re-run **Update prices**. Cookies expire after a few days/weeks — redo this when a store shows "stale".
6. **Aldi needs no cookie** — its specials are scraped automatically and are live out of the box.

---

## Step 5 — Deploy on Netlify

1. Log in to **Netlify** (with GitHub) → **Add new site → Import an existing project** → **Deploy with GitHub** → authorize Netlify → pick `shopping-app`.
2. On the configure screen, set:
   | Setting | Value |
   | --- | --- |
   | Owner / Branch | your account / `main` |
   | **Base directory** | (leave **empty**) |
   | **Build command** | (leave **empty** — the app is static, no build step) |
   | **Publish directory** | `pwa` |
3. Click **Deploy shopping-app**.
4. Wait ~30 seconds. You'll get a live URL like `https://your-site.netlify.app`.

> Every `git push` (including the price feed's nightly commit) now triggers an
> automatic redeploy. You never redeploy manually.

---

## Step 6 — Test the live app

1. Open the Netlify URL on your phone.
2. Quick test loop:
   - **Recipes tab** → paste `500g chicken breast, 2 cups rice, 1 broccoli head` → **Parse** → **Save as recipe**.
   - **Plan tab** → assign the recipe to a couple of days.
   - **Shop tab** → you should see a grouped list with totals, per-store prices, and "Save $X vs Store" notes.
   - **More tab** → confirm **v0.24** is shown at the bottom.
3. If anything looks off, try a hard refresh (or incognito) — the service worker caches aggressively by design.

---

## Step 7 — Install it as a home-screen app

- **iPhone (Safari):** open the site → **Share** → **Add to Home Screen** → Add.
- **Android (Chrome):** open the site → menu **⋮** → **Add to Home screen / Install app**.

It now opens full-screen like a native app and works offline in-store.

---

## Step 8 — Ongoing

- **Price feed (recommended): the home device.** See `device-scraper/README.md` — run it on your always-on Mini PC and it scrapes real Coles + Woolworths + Aldi prices nightly and pushes them to the repo automatically. No cookies, no manual steps, ever.
- **Price feed (fallback):** the GitHub Action also runs at 03:00 AWST nightly (Aldi works out of the box; Coles/Woolworths need the cookie secrets above). Manual refresh anytime: **Actions → Update prices → Run workflow**.
- **GitHub's 60-day rule:** scheduled workflows are disabled if the repo has no activity for 60 days. The device's nightly commit keeps it alive automatically.
- **If prices show "stale":** either the device is off or a store redesigned its page — check the device logs, or open the Actions tab, and send the log to the agent to patch.
- **Backups:** the app has **More → Export** which downloads a JSON backup of your recipes/plan/settings.
- **Secrets:** the `GH_TOKEN` lives only in `device-scraper/.env` on the device. Never paste it into chat, an issue, or a commit — if it leaks, revoke it and make a new one.

---

## Quick troubleshooting

| Symptom | Fix |
| --- | --- |
| Site 404s / shows a directory listing | Netlify **Publish directory** must be exactly `pwa` (no build command) |
| Prices never change from seed | Actions not enabled (Step 4) — check the workflow ran and committed |
| Workflow greyed out / "disabled by owner" | Repo was inactive 60+ days → run it manually once, or push any commit |
| App shows old version after update | Hard refresh; on phone, delete the home-screen icon and reinstall |
| Blank screen in the preview here | Expected — the sandboxed preview has no network; it uses built-in data, which is fine |

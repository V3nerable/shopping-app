# Step 5 — Update the Mini PC & start the price feeder (v0.08)

Goal: get the **full** v0.08 project onto the Mini PC, configure one secret,
start the Docker container, and confirm it's pushing prices.

Do the checkpoints in order. Each has a "✓ looks like this worked" line.

---

## Pre-check (do on ANY computer, 5 min)

1. **Revoke the leaked token.** The token you pasted in chat earlier is
   compromised. GitHub → avatar → Settings → Developer settings → Personal
   access tokens → Fine-grained tokens → find `github_pat_11AK…` → **Revoke**.
2. **Create a fresh token.** Same page → **Generate new token**:
   - Repository access → **Only select repositories** → `shopping-app`
   - Permissions → **Contents → Read and write**
   - Generate → copy the `github_pat_…` value now (shown once).
3. Keep that token handy — you'll paste it into `.env` in checkpoint 4.

---

## Checkpoint 1 — Get the full v0.08 onto the PC

GitHub still holds the **incomplete** project (that's why `device-scraper`
was missing), so don't trust `git pull` yet — use the zip.

1. On the Mini PC, download **`Shopping-App-v0.08.zip`** from the workspace
   viewer (it lands in **Downloads**).
2. Open **PowerShell** and find where it went:
   ```powershell
   cd C:\Users\beaum
   Get-ChildItem -Path . -Recurse -Filter "Shopping-App-v0.08.zip" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
   ```
   ✓ It prints a path like `C:\Users\beaum\Downloads\Shopping-App-v0.08.zip`.
   If nothing prints, download the zip first.

3. Extract it straight into the repo folder:
   ```powershell
   Expand-Archive -Path "$env:USERPROFILE\Downloads\Shopping-App-v0.08.zip" -DestinationPath C:\Users\beaum\shopping-app -Force
   ```
   *(If the zip is on your Desktop, swap `Downloads` for `Desktop`.)*

4. Confirm the folders are now there:
   ```powershell
   dir C:\Users\beaum\shopping-app
   ```
   ✓ You should see: `device-scraper`, `pwa`, `scraper`, `.github` (hidden on
   Windows but present), `README.md`, `DEPLOY_GUIDE.md`, `DOCKER_SETUP.md`,
   `.gitignore`. **If `device-scraper` is missing, the extract didn't happen —
   redo steps 2–3.**

---

## Checkpoint 2 — Push the full project to GitHub (backup + clean repo)

```powershell
cd C:\Users\beaum\shopping-app
git config --global user.name "v3nerable"
git config --global user.email "your-github-email@example.com"
git add .
git commit -m "Shopping App v0.08 full project"
git push
```

- If it asks for credentials: username `v3nerable`, password = **your token**
  (not your GitHub password).
- ✓ In your browser: repo → you now see `device-scraper/` and the big
  `pwa/index.html` (~131 KB). Netlify also auto-redeploys from this push.

---

## Checkpoint 3 — Make sure Docker is ready

```powershell
docker --version
docker compose version
```
✓ Both print version numbers.

- If you get *"docker is not recognized"* → Docker Desktop isn't installed or
  isn't running. Install from docker.com, accept WSL 2, restart, and wait for
  the whale icon to show **Engine running** (green). (Full detail: `DOCKER_SETUP.md` A1–A2.)
- If you get *"docker compose is not recognized"* but `docker --version` works →
  use `docker-compose` (with a hyphen) in the commands below.

---

## Checkpoint 4 — Configure the secret (`.env`)

```powershell
cd C:\Users\beaum\shopping-app\device-scraper
dir
```
✓ `dir` lists `scraper.mjs`, `docker-compose.yml`, `Dockerfile`,
`.env.example`, `README.md`, `package.json`.

Then:
```powershell
copy .env.example .env
notepad .env
```

Make the two lines read exactly:
```
GH_TOKEN=github_pat_PASTE_YOUR_FRESH_TOKEN_HERE
GH_REPO=v3nerable/shopping-app
```
- Leave the `#` comment lines alone.
- **Save:** Ctrl+S → close Notepad.

✓ Re-open to double-check: `notepad .env` — token and repo should be there.

> `.env` is gitignored, so it will never be committed. It lives only on this PC.

---

## Checkpoint 5 — Build and start the container

### 5a. Manually clear the stale folders FIRST (v0.07+)

If you've run the feeder before (an older version crashed), clear the old
volumes so the clone starts from a clean slate:

```powershell
docker compose down -v
```

- `down` stops and removes the container.
- `-v` also deletes the two named volumes (`device-scraper_repo` and
  `device-scraper_profile`) that hold the old `/repo` and browser profile.
- ✓ It should print lines like `Removing network …`, `Removing volume
  device-scraper_repo`, `Removing volume device-scraper_profile`.
- If `down -v` can't find the volumes, that's fine — it just means they were
  never created; carry on.

> Note: from v0.07 the scraper also clears `/repo`'s *contents* automatically,
> so this manual step is belt-and-braces, not strictly required. It's still the
> cleanest way to recover from an older version that crash-looped.

### 5b. Build and start

```powershell
docker compose up -d --build
```
✓ First run downloads the browser image (~1.5 GB) — takes several minutes.
When the prompt returns, the container is running in the background.

Watch it work:
```powershell
docker compose logs -f
```
✓ You should see it warm up the browser, then lines like:
```
coles: ok — 207 items
woolworths: ok — 207 items
aldi: ok — 2 specials: sausages @ $13.99, rice @ $11.99
feed written. status: ok | fresh stores: [ 'coles', 'woolworths', 'aldi' ]
pushed new price feed ✔
```
Press **Ctrl+C** to stop *watching* the logs — the container keeps running.

---

## Checkpoint 6 — Verify end-to-end

1. GitHub → repo → **Commits**: a new commit `chore: refresh price feed (device)`.
2. The app → **More** tab: stores show **"live"** within a few minutes
   (Netlify redeploys on the push).

---

## Reading the results honestly

| Log line | Meaning |
|---|---|
| `coles: ok — 207 items` | Real Coles prices scraped ✔ |
| `woolworths: ok — 207 items` | Real Woolworths prices ✔ |
| `aldi: ok — N specials` | Aldi specials (known to work) ✔ |
| `coles: no results — page structure may have changed` | Store redesigned a page — app keeps working ("last known"); **paste me this log and I'll patch the selectors** |
| `Authentication failed` on push | PAT scope wrong → must be **Contents: Read & write** on this repo |
| `Device or resource busy '/repo'` | Old (pre-v0.07) image still running → run `docker compose down -v` (Checkpoint 5a), rebuild, and start again |

---

## Common hiccups

| Error | Fix |
|---|---|
| `git : The term 'git' is not recognized` | Install Git (`winget install --id Git.Git -e --source winget`, reopen PowerShell) — or skip Git and use the zip method (Checkpoint 1) |
| `cd …\device-scraper` fails | The zip wasn't extracted — redo Checkpoint 1 steps 2–4 |
| `copy : Cannot find path … .env.example` | You're in the wrong folder — run `cd C:\Users\beaum\shopping-app\device-scraper` then `dir` first |
| `docker … not recognized` | Docker Desktop not installed/running — Checkpoint 3 |
| Device offline overnight | Feed just shows "last known" — it recovers on the next successful run |

## Daily lifecycle (after setup)

- The container restarts itself on reboot (`restart: unless-stopped`).
- It scrapes **03:00 AWST nightly** + a **Wed 08:00** specials sweep, then pushes.
- To update the app later: push new code to GitHub → on the PC:
  `cd C:\Users\beaum\shopping-app` → `git pull` → `cd device-scraper` →
  `docker compose build --pull` → `docker compose up -d`.

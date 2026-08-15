# Docker setup walkthrough — Shopping App price feeder

Step-by-step for installing Docker on your always-on device and standing up the
price feeder. Follow **Path A (Windows)** or **Path B (Linux)** — skip the one
that doesn't apply.

**Estimated time:** 20–40 min (mostly downloads). One-time.

---

## 0 — Before you start: have these ready

1. The GitHub repo must already exist (with the project files pushed). If not,
   do that first — see `DEPLOY_GUIDE.md` Steps 2–3.
2. A **fine-grained PAT** (personal access token). Create it now:

   GitHub → click your avatar (top right) → **Settings** →
   **Developer settings** → **Personal access tokens** → **Fine-grained tokens**
   → **Generate new token**
   - *Repository access:* **Only select repositories** → pick `shopping-app`
   - *Permissions → Repository permissions → **Contents** → **Read and write**
   - *Expiration:* 90 days is fine (you'll refresh it once a quarter)
   - **Generate token** → copy the `github_pat_...` value **now** (it's shown once)

3. Your repo name in `owner/name` form, e.g. `v3nerable/shopping-app`.

---

## PATH A — Windows Mini PC (Docker Desktop)

### A1. Install Docker Desktop
1. Download **Docker Desktop for Windows** from https://www.docker.com/products/docker-desktop/
2. Run the installer. It will offer to install **WSL 2** — accept it.
3. When prompted, **restart Windows**.
4. Launch **Docker Desktop**. Wait until the whale icon stops animating and the
   bottom-left shows **Engine running** (green).
   - If it errors about **virtualization**, reboot into BIOS (usually Del/F2 at
     power-on), find **Virtualization / VT-x / AMD-V / SVM**, enable it, save &
     exit, then start Docker Desktop again.

### A2. Verify Docker is working
Open **PowerShell** and run:
```powershell
docker --version
docker compose version
```
Both should print version numbers. If `docker compose` says "not found", you
have an old install — use `docker-compose` (with hyphen) in the commands below instead.

### A3. Get the project onto the device

**If `git` is not installed** (PowerShell: *"The term 'git' is not recognized"*),
either install it first, or skip Git entirely with the ZIP method below.

*Install Git:*
```powershell
winget install --id Git.Git -e --source winget
```
Then close and reopen PowerShell (new terminals pick up the new PATH) and verify
with `git --version`. Fallback installer: https://git-scm.com/download/win

*Or skip Git on Windows* (the Docker container has its own git): open the repo on
GitHub → **Code → Download ZIP** → extract to e.g. `C:\Users\beaum\shopping-app` →
note the extracted folder is usually `shopping-app-main`.

*Then, either way:*
```powershell
# with git installed:
cd C:\Users\beaum
git clone https://github.com/v3nerable/shopping-app.git
cd shopping-app\device-scraper

# or, from the extracted ZIP:
cd C:\Users\beaum\shopping-app-main\device-scraper
```

### A4. Configure the secrets
```powershell
copy .env.example .env
notepad .env
```
Set the two required values (delete the `#` from optional lines if you change them):
```
GH_TOKEN=github_pat_YOUR_TOKEN_HERE
GH_REPO=v3nerable/shopping-app
```
Save and close.

### A5. Start it
```powershell
docker compose up -d --build
```
The **first run downloads a ~1.5 GB image** — let it finish. Then:
```powershell
docker compose logs -f
```
You should see it warm up, scrape each store, write the feed, and push.
Press **Ctrl+C** to stop watching logs (the container keeps running).

### A6. Confirm it worked
1. In GitHub, open your repo → **Commits** → you should see
   `chore: refresh price feed (device)`.
2. Open the app → **More** tab → stores should show **"live"** within minutes
   (Netlify redeploys on the push).

---

## PATH B — Linux Mini PC (Ubuntu / Debian / Raspberry Pi OS)

### B1. Install Docker Engine + compose plugin
Open a terminal and run:
```bash
curl -fsSL https://get.docker.com | sudo sh
```
Then allow your user to run docker without sudo:
```bash
sudo usermod -aG docker $USER
```
**Log out and back in** (or reboot) for that to take effect.

### B2. Verify
```bash
docker --version
docker compose version
```
If `docker compose` is missing, install the plugin:
```bash
sudo apt-get install -y docker-compose-plugin
```

### B3. Get the project onto the device
```bash
cd ~
git clone https://github.com/v3nerable/shopping-app.git
cd shopping-app/device-scraper
```

### B4. Configure the secrets
```bash
cp .env.example .env
nano .env        # or: vi .env
```
Set:
```
GH_TOKEN=github_pat_YOUR_TOKEN_HERE
GH_REPO=v3nerable/shopping-app
```
Save (Ctrl+O, Enter) and exit (Ctrl+X).

### B5. Start it
```bash
docker compose up -d --build
docker compose logs -f
```
First run downloads the image, then scrapes and pushes. **Ctrl+C** stops the
log view only — the container keeps running.

### B6. Confirm it worked
Same as A6: check GitHub commits, then the app's More tab for "live".

---

## How to test a single run (both paths)

Without the scheduler, just one scrape and exit:
```bash
docker compose run --rm -e RUN_ONCE=1 scraper node scraper.mjs --once
```

## How to update later (both paths)

After you push a new version of the code to GitHub:
```bash
git pull                          # on the device
docker compose build --pull
docker compose up -d
```

## How to stop / restart (both paths)

```bash
docker compose stop      # pause
docker compose start     # resume
docker compose logs -f   # watch
```

---

## What success looks like vs. what needs me

| You see in `docker compose logs` | Meaning |
|---|---|
| `coles: ok — 207 items` | Real Coles prices scraped ✔ |
| `woolworths: ok — …` | Real Woolworths prices ✔ |
| `aldi: ok — 2 specials` | Aldi specials (already known to work) ✔ |
| `coles: no results — page structure may have changed` | Store redesigned a page — the app keeps working ("last known"), but ping me to update the selectors |
| `gh token` / `authentication failed` | PAT scope wrong — must be **Contents: Read & write** on this repo |

## Troubleshooting quick hits

- **`git : The term 'git' is not recognized`** (Windows) → Git isn't installed.
  Run `winget install --id Git.Git -e --source winget` and reopen PowerShell, or
  use the ZIP method in A3 to skip Git on Windows entirely.
- **Docker Desktop won't start** → virtualization is off in BIOS (A1), or WSL2
  didn't install — re-run the installer.
- **`docker: permission denied`** (Linux) → you didn't log out/in after
  `usermod` (B1).
- **Nothing appears in GitHub** → check `GH_REPO` spelling and that the PAT has
  *Contents: Read and write*.
- **Store shows a CAPTCHA** → rare on home IPs; set `headless: false` in
  `scraper.mjs`, run once with a screen attached, solve it, then flip back.
- **Feed says "stale" in the app** → the device was off overnight, or a store
  redesigned — both recover automatically or with a selector patch.

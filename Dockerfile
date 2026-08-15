# Home-device price feeder — browser image with Playwright Chromium + git
# Pin to a recent tag: https://mcr.microsoft.com/en-us/product/playwright/about
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

RUN apt-get update && apt-get install -y --no-install-recommends git xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev \
    && npx playwright install chromium

COPY scraper.mjs docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV PROFILE_DIR=/profile \
    REPO_DIR=/repo \
    CATALOGUE_PATH=/catalogue.json

# ENTRYPOINT wraps the CMD (or any `docker compose run scraper <cmd>` override)
# in xvfb-run when HEADED=1. Default command is the scheduler.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "scraper.mjs"]

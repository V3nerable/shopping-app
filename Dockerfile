# Home-device price feeder — browser image with Playwright Chromium + git
# Pin to a recent tag: https://mcr.microsoft.com/en-us/product/playwright/about
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY scraper.mjs ./

ENV PROFILE_DIR=/profile \
    REPO_DIR=/repo \
    CATALOGUE_PATH=/catalogue.json

ENTRYPOINT ["node", "scraper.mjs"]

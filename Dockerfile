FROM node:24-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
RUN npx playwright install --with-deps chromium

COPY src ./src
COPY test ./test

RUN mkdir -p /app/data && chown -R node:node /app/data /app/test/fixtures /ms-playwright

ENV CHROMIUM_DISABLE_SANDBOX=1

USER node

CMD ["node", "src/index.js"]

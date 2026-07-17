FROM node:24-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
RUN npx playwright install --with-deps chromium

COPY src ./src
COPY test ./test

RUN mkdir -p /app/data && chown -R node:node /app/data /ms-playwright

ENV CHROMIUM_DISABLE_SANDBOX=1

USER node

CMD ["node", "src/index.js"]

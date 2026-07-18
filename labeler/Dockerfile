FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

EXPOSE 14831

CMD ["node", "src/index.js"]

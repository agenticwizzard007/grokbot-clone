# Grokbot: the web app and API server in one container.
# Build:  docker build -t grokbot .
# Run:    docker run -p 8787:8787 -v grokbot-data:/data -e SESSION_SECRET=... grokbot

FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 compiles from source; ffmpeg-static downloads its binary on install.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w web && npm run build -w server \
 && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/grokbot.db \
    FILES_DIR=/data/files
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY companion companion
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "server/dist/index.js"]

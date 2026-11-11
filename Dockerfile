# Swarm: the web app and API server in one container.
# Build:  docker build -t swarm .
# Run:    docker run -p 8787:8787 -v swarm-data:/data -e SESSION_SECRET=... swarm

ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
ARG DEBIAN_SNAPSHOT=""
WORKDIR /app
# better-sqlite3 compiles from source; ffmpeg-static downloads its binary on install.
RUN if [ -n "$DEBIAN_SNAPSHOT" ]; then \
      rm -f /etc/apt/sources.list.d/debian.sources \
      && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s trixie main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s trixie-security main\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list; \
    fi \
 && apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w web && npm run build -w server \
 && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE}
ARG DEBIAN_SNAPSHOT=""
ARG ZLIB_VERSION=""
WORKDIR /app
RUN if [ -n "$DEBIAN_SNAPSHOT" ]; then \
      rm -f /etc/apt/sources.list.d/debian.sources \
      && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s trixie main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s trixie-security main\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list; \
    fi \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 ${ZLIB_VERSION:+"zlib1g=$ZLIB_VERSION"} && rm -rf /var/lib/apt/lists/*
# The tenant pipeline can replace Node 22's older bundled npm using an exact verified tarball.
# Empty arguments preserve the existing standalone image build.
ARG NPM_VERSION=""
ARG NPM_INTEGRITY=""
RUN if [ -n "$NPM_VERSION" ]; then \
      NPM_RELEASE_VERSION="$NPM_VERSION" NPM_RELEASE_INTEGRITY="$NPM_INTEGRITY" node --input-type=module -e \
        'import {createHash} from "node:crypto"; import fs from "node:fs"; const v=process.env.NPM_RELEASE_VERSION; if(!/^\d+\.\d+\.\d+$/.test(v))throw Error("Invalid npm version"); const r=await fetch(`https://registry.npmjs.org/npm/-/npm-${v}.tgz`); if(!r.ok)throw Error("npm download failed"); const b=Buffer.from(await r.arrayBuffer()); if(`sha512-${createHash("sha512").update(b).digest("base64")}`!==process.env.NPM_RELEASE_INTEGRITY)throw Error("npm integrity mismatch"); fs.writeFileSync("/tmp/npm.tgz",b);' \
      && npm install --global --ignore-scripts --no-audit --no-fund /tmp/npm.tgz \
      && rm /tmp/npm.tgz && npm cache clean --force; \
    fi
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/swarm.db \
    FILES_DIR=/data/files
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
COPY companion companion
COPY infra/tenant-host/worker.mjs infra/tenant-host/worker.mjs
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "server/dist/index.js"]

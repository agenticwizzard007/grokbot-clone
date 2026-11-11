ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS ffmpeg
ARG DEBIAN_SNAPSHOT
RUN test -n "$DEBIAN_SNAPSHOT" \
 && rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s trixie main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s trixie-security main\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates build-essential pkg-config nasm gnupg gpgv xz-utils libxcb1-dev libxcb-shm0-dev libxcb-xfixes0-dev libxcb-shape0-dev \
 && rm -rf /var/lib/apt/lists/*
COPY infra/tenant-host/images.lock.json infra/tenant-host/ffmpeg-release.asc infra/tenant-host/build-ffmpeg.mjs /build/
RUN node /build/build-ffmpeg.mjs
FROM ${NODE_IMAGE}
USER root
ARG DEBIAN_SNAPSHOT
ARG CHROME_VERSION
ARG CHROME_SHA256
ARG ZLIB_VERSION
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_MCP_CLI=/opt/playwright/node_modules/@playwright/mcp/cli.js \
    CHROME_PATH=/usr/bin/google-chrome-stable SWARM_FFMPEG=/usr/local/bin/ffmpeg
RUN test -n "$DEBIAN_SNAPSHOT" && test -n "$CHROME_VERSION" && test -n "$CHROME_SHA256" \
 && rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s trixie main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s trixie-security main\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates xvfb xfwm4 dbus-x11 xdotool xdg-utils \
      fonts-liberation fonts-noto-color-emoji python3 procps libxcb-shm0 libxcb-xfixes0 libxcb-shape0 "zlib1g=$ZLIB_VERSION" \
 && CHROME_RELEASE_VERSION="$CHROME_VERSION" node --input-type=module -e \
      'import fs from "node:fs";const v=process.env.CHROME_RELEASE_VERSION;if(!/^\d+\.\d+\.\d+\.\d+-\d+$/.test(v))throw Error("Chrome version");const r=await fetch(`https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${v}_amd64.deb`);if(!r.ok)throw Error("Chrome download failed");fs.writeFileSync("/tmp/chrome.deb",Buffer.from(await r.arrayBuffer()));' \
 && printf '%s  /tmp/chrome.deb\n' "$CHROME_SHA256" | sha256sum --check - \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && test "$(dpkg-query -W -f='${Version}' google-chrome-stable)" = "$CHROME_VERSION" \
 && rm -f /tmp/chrome.deb /etc/apt/sources.list.d/google-chrome.list \
 && rm -rf /var/lib/apt/lists/*
# Current, minimal signed-source FFmpeg. No Debian libav stack or package-manager updates at boot.
COPY --from=ffmpeg /out/ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /out/ffmpeg-build.json /opt/swarm/ffmpeg-build.json
COPY --from=ffmpeg /out/COPYING.LGPLv2.1 /usr/share/doc/swarm-ffmpeg/COPYING.LGPLv2.1
COPY infra/tenant-host/desktop/package.json infra/tenant-host/desktop/package-lock.json /opt/playwright/
RUN cd /opt/playwright && npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force \
 && node -e 'if (process.versions.node.split(".")[0] !== "22" || require("/opt/playwright/node_modules/@playwright/mcp/package.json").version !== "0.0.85") process.exit(1)' \
 && groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/agent --shell /bin/bash agent
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER 10001:10001
ENV HOME=/home/agent
WORKDIR /home/agent
# The companion starts Xvfb/window manager/Chrome on demand. No runtime installers or sandbox bypass.
ENTRYPOINT []
CMD ["node", "--version"]

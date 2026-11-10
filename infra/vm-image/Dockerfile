# Swarm cloud VM image: one per user, one screen per Bot (see server/src/computers/cloudvm.ts).
# Holds the operating system, the desktop pieces and Chrome. The companion (the runtime that drives
# the screens) is downloaded from the Swarm server at every boot, so it updates without a rebuild;
# the copy baked in here is only a fallback.
#
#   docker build -t registry.fly.io/<FLY_VM_APP>:<version> -f infra/vm-image/Dockerfile .
#   docker push registry.fly.io/<FLY_VM_APP>:<version>      then set VM_IMAGE to that tag
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg sudo procps iptables tini \
      xvfb xfwm4 xfdesktop4 dbus-x11 xdotool imagemagick ffmpeg \
      fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
      git jq unzip python3 \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable nodejs \
  && rm -rf /var/lib/apt/lists/*

# Playwright MCP: every browser action Bots take goes through Playwright, attached to their own Chrome.
# Keep the version in step with package.json and server/src/computers/browser-tools.ts.
RUN npm install -g --no-audit --no-fund @playwright/mcp@0.0.85

# Two users: 'swarm' runs the companion and alone can read the VM's token;
# 'agent' runs the Bots' shells and browsers (their files live on the volume at /home/agent).
RUN useradd --system --create-home --home-dir /var/lib/swarm swarm \
 && useradd --create-home --home-dir /home/agent --shell /bin/bash agent \
 && echo 'swarm ALL=(agent) NOPASSWD: ALL' > /etc/sudoers.d/swarm && chmod 440 /etc/sudoers.d/swarm

COPY companion/swarm-companion.mjs /opt/swarm/companion.mjs
COPY infra/vm-image/entrypoint.sh /opt/swarm/entrypoint.sh
RUN chmod 755 /opt/swarm/entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/swarm/entrypoint.sh"]

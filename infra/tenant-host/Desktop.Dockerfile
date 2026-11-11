ARG DESKTOP_BASE
FROM ${DESKTOP_BASE}
# DESKTOP_BASE is a signed digest containing Chrome, Xvfb, window manager, Python,
# Node and pinned Playwright MCP; browser sandbox support is a release gate.
COPY companion/swarm-companion.mjs /opt/swarm/companion.mjs
USER 10001:10001
ENV HOME=/home/agent LANG=C.UTF-8
WORKDIR /home/agent
ENTRYPOINT []

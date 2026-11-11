# Build only with the digest-pinned inputs in images.lock.json (linux/amd64).
ARG NODE_IMAGE
ARG DOCKER_IMAGE
FROM ${DOCKER_IMAGE} AS docker
ARG DOCKER_VERSION
ARG DOCKER_STATIC_SHA256
RUN test -n "$DOCKER_VERSION" && test -n "$DOCKER_STATIC_SHA256" \
 && wget -q -O /tmp/docker.tgz "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
 && printf '%s  /tmp/docker.tgz\n' "$DOCKER_STATIC_SHA256" | sha256sum -c - \
 && tar -xzf /tmp/docker.tgz --strip-components=1 -C /usr/local/bin docker/containerd \
 && rm /tmp/docker.tgz
FROM ${NODE_IMAGE}
USER root
ARG DEBIAN_SNAPSHOT
ARG ZLIB_VERSION
# Signed Debian snapshot metadata pins package resolution to one archived release.
RUN test -n "$DEBIAN_SNAPSHOT" \
 && rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s trixie main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s trixie-security main\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates iptables util-linux mount procps "zlib1g=$ZLIB_VERSION" \
 && rm -rf /var/lib/apt/lists/*
# Official Docker's static binaries; no Alpine libraries, dind entrypoint or TCP daemon configuration.
COPY --from=docker /usr/local/bin/docker /usr/local/bin/dockerd /usr/local/bin/containerd /usr/local/bin/containerd-shim-runc-v2 /usr/local/bin/ctr /usr/local/bin/runc /usr/local/bin/docker-init /usr/local/bin/docker-proxy /usr/local/bin/
# Docker 29.9 embeds containerd; the matching standalone binary also supports host qualification tooling.
RUN node -e 'if (process.versions.node.split(".")[0] !== "22") process.exit(1)' \
 && docker --version && dockerd --version && runc --version \
 && mount --help | grep -q -- --no-canonicalize \
 && command -v iptables && command -v ip6tables
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
# This is the trusted VM host. Only its supervisor gets root/Docker access.
ENTRYPOINT []
CMD ["node", "--version"]

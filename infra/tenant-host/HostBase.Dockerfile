# Build only with the digest-pinned inputs in images.lock.json (linux/amd64).
ARG NODE_IMAGE
ARG DOCKER_IMAGE
ARG GO_IMAGE
# containerd, its runc shim and runc rebuilt from exact upstream release commits with the Go modules in
# images.lock.json upgraded: the released static binaries still carry fixable HIGH findings. Go module
# checksums are verified against the public checksum database; libpathrs uses runc's own checksummed build.
FROM ${GO_IMAGE} AS runtime
ARG DEBIAN_SNAPSHOT
ARG CONTAINERD_VERSION
ARG CONTAINERD_COMMIT
ARG RUNC_VERSION
ARG RUNC_COMMIT
ARG LIBPATHRS_VERSION
ARG GO_MODULE_UPGRADES
RUN test -n "$DEBIAN_SNAPSHOT" \
 && rm -f /etc/apt/sources.list.d/debian.sources \
 && printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s trixie main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s trixie-security main\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list \
 && apt-get update && apt-get install -y --no-install-recommends \
      git make gcc libc6-dev pkg-config libseccomp-dev rustc cargo lld xz-utils curl gnupg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV GOTOOLCHAIN=local GOSUMDB=sum.golang.org
WORKDIR /src
# Upgrade only modules each project already requires, so no new dependency enters the build.
RUN printf '%s\n' '#!/bin/sh' 'set -eu' 'for m in $GO_MODULE_UPGRADES; do if go list -mod=mod -m "${m%@*}" >/dev/null 2>&1; then go get "$m"; fi; done' 'go mod tidy' 'go mod vendor' > /usr/local/bin/upgrade-modules \
 && chmod 755 /usr/local/bin/upgrade-modules
RUN test -n "$CONTAINERD_COMMIT" \
 && git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$CONTAINERD_VERSION" https://github.com/containerd/containerd containerd \
 && test "$(git -C containerd rev-parse HEAD)" = "$CONTAINERD_COMMIT" \
 && cd containerd && upgrade-modules \
 && make STATIC=1 VERSION="$CONTAINERD_VERSION" REVISION="$CONTAINERD_COMMIT" bin/containerd bin/containerd-shim-runc-v2 \
 && mkdir -p /out && cp bin/containerd bin/containerd-shim-runc-v2 /out/ \
 && /out/containerd --version | grep -q "$CONTAINERD_VERSION $CONTAINERD_COMMIT"
RUN test -n "$RUNC_COMMIT" \
 && git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$RUNC_VERSION" https://github.com/opencontainers/runc runc \
 && test "$(git -C runc rev-parse HEAD)" = "$RUNC_COMMIT" \
 && cd runc && ./script/build-libpathrs.sh "$LIBPATHRS_VERSION" /opt/libpathrs \
 && export PKG_CONFIG_PATH=/opt/libpathrs/lib/pkgconfig && upgrade-modules \
 && make static COMMIT="$RUNC_COMMIT" \
 && cp runc /out/runc && /out/runc --version | grep -q "commit: $RUNC_COMMIT" \
 && test -z "$(readelf -d /out/runc | grep NEEDED)"
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
COPY --from=docker /usr/local/bin/docker /usr/local/bin/dockerd /usr/local/bin/docker-init /usr/local/bin/docker-proxy /usr/local/bin/
# containerd, its shim and runc come from the patched source build above; ctr is not shipped.
COPY --from=runtime /out/containerd /out/containerd-shim-runc-v2 /out/runc /usr/local/bin/
RUN node -e 'if (process.versions.node.split(".")[0] !== "22") process.exit(1)' \
 && docker --version && dockerd --version && containerd --version && runc --version \
 && mount --help | grep -q -- --no-canonicalize \
 && command -v iptables && command -v ip6tables
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
# This is the trusted VM host. Only its supervisor gets root/Docker access.
ENTRYPOINT []
CMD ["node", "--version"]

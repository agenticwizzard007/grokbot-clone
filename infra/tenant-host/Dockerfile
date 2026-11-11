# All build arguments must be immutable @sha256 references from the qualified release pipeline.
ARG HOST_BASE
FROM ${HOST_BASE}
# HOST_BASE supplies Node 22+, dockerd, Docker CLI (bind-recursive support),
# util-linux mount/umount (--no-canonicalize), iptables/ip6tables, and CA certificates.
# Images are exported by build-release.sh after scanning and signature verification.
COPY .context/tenant-release/images /opt/swarm/images
COPY .context/tenant-release/release.json /opt/swarm/release.json
COPY .context/tenant-release/app /app
COPY infra/tenant-host/validate-release.mjs /opt/swarm/validate-release.mjs
COPY infra/tenant-host/chromium-seccomp.json /opt/swarm/chromium-seccomp.json
COPY infra/tenant-host/firewall.sh /opt/swarm/firewall.sh
COPY infra/tenant-host/entrypoint.sh /opt/swarm/entrypoint.sh
RUN chmod 755 /opt/swarm/*.sh
ENTRYPOINT ["/opt/swarm/entrypoint.sh"]

#!/bin/sh
set -eu
umask 077
node /opt/swarm/validate-release.mjs /opt/swarm/release.json /opt/swarm/chromium-seccomp.json
mkdir -p /run/swarm-host /run/swarm /data/app /data/files /data/subscriptions /data/desktop
# Only fixed image archives supplied by the signed host release are loaded; boot downloads no code.
dockerd --host=unix:///run/docker.sock --data-root=/var/lib/docker --dns=1.1.1.1 --dns=1.0.0.1 --ipv6=false > /run/swarm-host/docker.log 2>&1 &
docker_pid=$!
trap 'kill "$docker_pid" 2>/dev/null || true' EXIT INT TERM
attempt=0
until docker --host=unix:///run/docker.sock info >/dev/null 2>&1; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 60 ] || exit 1
  sleep 1
done
export DOCKER_HOST=unix:///run/docker.sock
for archive in /opt/swarm/images/*.tar; do docker load --input "$archive" >/dev/null; done
docker network inspect swarm-app >/dev/null 2>&1 || docker network create --subnet 172.30.0.0/24 --opt com.docker.network.bridge.enable_icc=false swarm-app >/dev/null
docker network inspect swarm-desktop >/dev/null 2>&1 || docker network create --subnet 172.31.0.0/24 --opt com.docker.network.bridge.enable_icc=false swarm-desktop >/dev/null
docker network inspect swarm-public >/dev/null 2>&1 || docker network create --subnet 172.29.0.0/24 --opt com.docker.network.bridge.enable_icc=false swarm-public >/dev/null
/opt/swarm/firewall.sh
exec node /app/server/dist/runtime/host.js

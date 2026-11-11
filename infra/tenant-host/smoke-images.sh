#!/usr/bin/env bash
# Image compatibility only. This does not qualify a Fly kernel, network or tenant boundary.
set -euo pipefail
[[ $# == 3 ]] || { echo 'Usage: smoke-images.sh APP_IMAGE HOST_BASE DESKTOP_IMAGE' >&2; exit 1; }
app=$1 host=$2 desktop=$3
mkdir -p .context/tenant-release/reports
limits=(--rm --pull=never --network=none --read-only --user=10001:10001 --cap-drop=ALL --security-opt=no-new-privileges:true --pids-limit=512 --memory=1536m --memory-swap=1536m --cpus=2 --tmpfs=/tmp:rw,nosuid,nodev,size=256m,mode=1777)
docker run "${limits[@]}" --env=HOME=/tmp "$app" node -e '
  const fs=require("node:fs"),{execFileSync}=require("node:child_process"),path=require("node:path");
  if(process.getuid()!==10001||process.versions.node.split(".")[0]!=="22")throw Error("Identity/Node mismatch");
  const db=new (require("better-sqlite3"))(":memory:"); db.exec("CREATE TABLE smoke(n INTEGER)"); db.close();
  for(const [pkg,bin] of [["@openai/codex","codex"],["@anthropic-ai/claude-code","claude"]]){
    const file=require.resolve(`${pkg}/package.json`),manifest=require(file);
    execFileSync(path.resolve(path.dirname(file),manifest.bin[bin]),["--version"],{timeout:30000,stdio:"inherit"});
  }
  try{fs.writeFileSync("/etc/swarm-smoke","unexpected");throw Error("Writable root");}catch(e){if(e.code!=="EROFS")throw e;}
'
docker run --rm --pull=never --network=none --entrypoint sh "$host" -ec '
  test "$(node -p "process.versions.node.split(\".\")[0]")" = 22
  docker --version; dockerd --version; containerd --version; runc --version
  command -v docker-init; command -v iptables; command -v ip6tables
  command -v tar; command -v gzip; command -v sha256sum
  mount --help | grep -q -- --no-canonicalize
  umount --help | grep -q -- --no-canonicalize
'
profile=$(realpath infra/tenant-host/chromium-seccomp.json)
docker run "${limits[@]}" --security-opt="seccomp=$profile" \
  --tmpfs=/home/agent:rw,nosuid,nodev,uid=10001,gid=10001,size=128m --shm-size=256m \
  "$desktop" sh -ec '
    node --check /opt/swarm/companion.mjs
    node "$PLAYWRIGHT_MCP_CLI" --version
    python3 --version
    Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
    xpid=$!; trap "kill $xpid 2>/dev/null || true" EXIT
    for i in 1 2 3 4 5; do test -S /tmp/.X11-unix/X99 && break; sleep 1; done
    test -S /tmp/.X11-unix/X99
    DISPLAY=:99 xfwm4 --compositor=off >/tmp/wm.log 2>&1 &
    DISPLAY=:99 xdotool getdisplaygeometry
    "$SWARM_FFMPEG" -hide_banner -loglevel error -f x11grab -i :99 -frames:v 1 -c:v mjpeg -f image2 /tmp/screen.jpg
    test -s /tmp/screen.jpg
    google-chrome-stable --headless --allow-chrome-scheme-url --disable-gpu --no-first-run --no-default-browser-check \
      --user-data-dir=/home/agent/probe --dump-dom chrome://sandbox > /tmp/sandbox.html
    cat /tmp/sandbox.html
  ' > .context/tenant-release/reports/desktop-smoke.txt 2>&1
# Chrome must report both namespace and seccomp sandboxing; never add --no-sandbox to make this pass.
node --input-type=module <<'JS'
import fs from 'node:fs';
import {assertChromeSandbox} from './infra/tenant-host/sandbox-evidence.mjs';
assertChromeSandbox(fs.readFileSync('.context/tenant-release/reports/desktop-smoke.txt','utf8'));
console.log('Image smoke passed; real Fly containment is a separate gate.');
JS

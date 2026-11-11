#!/usr/bin/env bash
set -euo pipefail
required=(APP_IMAGE RUNNER_IMAGE MCP_IMAGE DESKTOP_IMAGE HOST_BASE PLATFORM_PUBLIC_KEY_FILE IMAGE_VERIFICATION_KEY HOST_IMAGE_TAG)
for name in "${required[@]}"; do [[ -n ${!name:-} ]] || { echo "Missing $name" >&2; exit 1; }; done
for name in APP_IMAGE RUNNER_IMAGE MCP_IMAGE DESKTOP_IMAGE HOST_BASE; do
  [[ ${!name} =~ @sha256:[a-f0-9]{64}$ ]] || { echo "$name must be an immutable digest" >&2; exit 1; }
  cosign verify --key "$IMAGE_VERIFICATION_KEY" "${!name}" >/dev/null
  trivy image --exit-code 1 --severity HIGH,CRITICAL "${!name}"
done
npm run build
mkdir -p .context/tenant-release/images
for name in APP_IMAGE RUNNER_IMAGE MCP_IMAGE DESKTOP_IMAGE; do
  docker pull "${!name}"
  docker save --output ".context/tenant-release/images/$name.tar" "${!name}"
done
node --input-type=module <<'JS'
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const e=process.env;
const release={appImage:e.APP_IMAGE,runnerImage:e.RUNNER_IMAGE,mcpImage:e.MCP_IMAGE,desktopImage:e.DESKTOP_IMAGE,platformPublicKey:fs.readFileSync(e.PLATFORM_PUBLIC_KEY_FILE,'utf8')};
release.imageIds=Object.fromEntries(['appImage','runnerImage','mcpImage','desktopImage'].map(key=>[key,execFileSync('docker',['image','inspect','--format','{{.Id}}',release[key]],{encoding:'utf8'}).trim()]));
fs.writeFileSync('.context/tenant-release/release.json',JSON.stringify(release,null,2));
JS
docker build -f infra/tenant-host/Dockerfile --build-arg "HOST_BASE=$HOST_BASE" -t "$HOST_IMAGE_TAG" .
# Publishing and signing the resulting host image belongs to the release pipeline.

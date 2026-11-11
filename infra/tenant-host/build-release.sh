#!/usr/bin/env bash
set -euo pipefail
mode=verified
if [[ ${1:-} == --dry-run && $# == 1 ]]; then mode=dry-run
elif [[ $# != 0 ]]; then echo 'Usage: build-release.sh [--dry-run]' >&2; exit 1; fi
export RELEASE_BUILD_MODE="$mode"
node infra/tenant-host/release-inputs.mjs
required=(APP_IMAGE RUNNER_IMAGE MCP_IMAGE DESKTOP_IMAGE HOST_BASE)
if [[ $mode == verified ]]; then
  declare -A checked=()
  for name in "${required[@]}"; do
    ref=${!name}
    if [[ ${checked[$ref]+present} ]]; then continue; fi
    checked[$ref]=1
    cosign verify --key "$IMAGE_VERIFICATION_KEY" "${!name}" >/dev/null
    trivy image --exit-code 1 --scanners vuln --severity HIGH,CRITICAL "${!name}"
    docker pull "${!name}" >/dev/null
  done
fi
# Everything below is local. Dry-run never pulls, signs, logs in, or pushes.
# Fail before Docker can resolve a missing local base during assembly.
for name in "${required[@]}"; do docker image inspect "${!name}" >/dev/null; done
release_dir=.context/tenant-release
mkdir -p "$release_dir/images" "$release_dir/app/server"
rm -f "$release_dir/images/"*.tar
rm -rf "$release_dir/app"
mkdir -p "$release_dir/app/server"
extract_id=''
cleanup() { if [[ -n $extract_id ]]; then docker rm --force --volumes "$extract_id" >/dev/null; fi; }
trap cleanup EXIT
# Reuse the compiled application and production dependency tree from the exact reviewed APP_IMAGE.
# Do not independently compile privileged host code from a potentially different working tree.
extract_id=$(docker create --pull=never --network=none "$APP_IMAGE" node --version)
docker cp "$extract_id:/app/server/dist" "$release_dir/app/server/"
docker cp "$extract_id:/app/server/package.json" "$release_dir/app/server/package.json"
docker cp "$extract_id:/app/node_modules" "$release_dir/app/"
docker rm --volumes "$extract_id" >/dev/null
extract_id=''
extract_id=$(docker create --pull=never --network=none "$DESKTOP_IMAGE" node --version)
docker cp "$extract_id:/opt/swarm/ffmpeg-build.json" "$release_dir/ffmpeg-build.json"
docker cp "$extract_id:/usr/local/bin/ffmpeg" "$release_dir/ffmpeg"
docker rm --volumes "$extract_id" >/dev/null
extract_id=''
node --input-type=module <<'JS'
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createPublicKey,createHash} from 'node:crypto';
const e=process.env;
const ffmpeg=JSON.parse(fs.readFileSync('.context/tenant-release/ffmpeg-build.json','utf8'));
const expected=JSON.parse(fs.readFileSync('infra/tenant-host/images.lock.json','utf8')).ffmpeg;
for(const key of ['version','sourceUrl','sourceSha256','signingKeyFingerprint','configureFlags'])if(JSON.stringify(ffmpeg[key])!==JSON.stringify(expected[key]))throw Error('FFmpeg provenance differs from the reviewed source');
if(createHash('sha256').update(fs.readFileSync('.context/tenant-release/ffmpeg')).digest('hex')!==ffmpeg.binarySha256)throw Error('FFmpeg binary differs from its build record');
fs.unlinkSync('.context/tenant-release/ffmpeg');
const release={buildMode:e.RELEASE_BUILD_MODE,sourceCommit:e.RELEASE_SOURCE_SHA,
  appImage:e.APP_IMAGE,runnerImage:e.RUNNER_IMAGE,mcpImage:e.MCP_IMAGE,desktopImage:e.DESKTOP_IMAGE,
  platformPublicKey:createPublicKey(fs.readFileSync(e.PLATFORM_PUBLIC_KEY_FILE)).export({type:'spki',format:'pem'}),
  desktopSeccompSha256:createHash('sha256').update(fs.readFileSync('infra/tenant-host/chromium-seccomp.json')).digest('hex'),ffmpeg,imageIds:{}};
const saved=new Set();
for(const [key,name] of Object.entries({mcpImage:'MCP_IMAGE',appImage:'APP_IMAGE',runnerImage:'RUNNER_IMAGE',desktopImage:'DESKTOP_IMAGE'})){
  const info=JSON.parse(execFileSync('docker',['image','inspect',release[key]],{encoding:'utf8'}))[0];
  if(info.Os!=='linux'||info.Architecture!=='amd64'||!/^sha256:[a-f0-9]{64}$/.test(info.Id))throw Error('Unexpected component platform or image ID');
  if(info.Config?.Labels?.['org.opencontainers.image.revision']!==e.RELEASE_SOURCE_SHA)throw Error('Component source commit mismatch');
  release.imageIds[key]=info.Id;
  // APP/RUNNER/MCP intentionally share one immutable build. Avoid three copies of the same archive.
  if(!saved.has(info.Id))execFileSync('docker',['save','--output',`.context/tenant-release/images/${name}.tar`,release[key]],{stdio:'inherit'}),saved.add(info.Id);
}
fs.writeFileSync('.context/tenant-release/release.json',JSON.stringify(release,null,2)+'\n');
JS
docker build --platform=linux/amd64 -f infra/tenant-host/Dockerfile \
  --build-arg "HOST_BASE=$HOST_BASE" \
  --label "org.opencontainers.image.revision=$RELEASE_SOURCE_SHA" \
  --label "so.swarms.tenant.build-mode=$mode" -t "$HOST_IMAGE_TAG" .
# Publishing/signing belongs to release-images.mjs. Dry-run hosts refuse to boot.

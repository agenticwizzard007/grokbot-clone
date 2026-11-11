#!/usr/bin/env bash
set -euo pipefail
lock=infra/tenant-host/images.lock.json
tools_dir=.context/tenant-tools
mkdir -p "$tools_dir"
cosign_version=$(node -p "require('./$lock').cosignVersion")
cosign_sha=$(node -p "require('./$lock').cosignSha256")
trivy_version=$(node -p "require('./$lock').trivyVersion")
trivy_sha=$(node -p "require('./$lock').trivySha256")
[[ $cosign_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $trivy_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ $cosign_sha =~ ^[a-f0-9]{64}$ && $trivy_sha =~ ^[a-f0-9]{64}$ ]]
curl --fail --silent --show-error --location --retry 3 "https://github.com/sigstore/cosign/releases/download/v$cosign_version/cosign-linux-amd64" -o "$tools_dir/cosign"
printf '%s  %s\n' "$cosign_sha" "$tools_dir/cosign" | sha256sum --check -
curl --fail --silent --show-error --location --retry 3 "https://github.com/aquasecurity/trivy/releases/download/v$trivy_version/trivy_${trivy_version}_Linux-64bit.tar.gz" -o "$tools_dir/trivy.tar.gz"
printf '%s  %s\n' "$trivy_sha" "$tools_dir/trivy.tar.gz" | sha256sum --check -
tar -xzf "$tools_dir/trivy.tar.gz" -C "$tools_dir" trivy
chmod 755 "$tools_dir/cosign" "$tools_dir/trivy"
rm "$tools_dir/trivy.tar.gz"
"$tools_dir/cosign" version
"$tools_dir/trivy" --version

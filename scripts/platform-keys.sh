#!/usr/bin/env bash
set -euo pipefail
umask 077
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
key_dir="${1:-${HOME}/.local/share/swarm-platform/keys}"
# Directories need search permission: 0700 directory, 0600 files.
mkdir -p -- "$key_dir"
key_dir="$(cd -- "$key_dir" && pwd -P)"
case "$key_dir/" in "$repo_dir/"*) echo 'Keys must be outside the git checkout.' >&2; exit 1;; esac
chmod 700 -- "$key_dir"
if [[ -e "$key_dir/platform-private.pem" || -e "$key_dir/platform-public.pem" ]]; then
  [[ -f "$key_dir/platform-private.pem" && ! -L "$key_dir/platform-private.pem" && -f "$key_dir/platform-public.pem" && ! -L "$key_dir/platform-public.pem" ]] || { echo 'Refusing incomplete or linked key pair.' >&2; exit 1; }
  openssl pkey -in "$key_dir/platform-private.pem" -pubout | cmp -s - "$key_dir/platform-public.pem" || { echo 'Key pair does not match.' >&2; exit 1; }
else
  openssl genpkey -algorithm ED25519 -out "$key_dir/platform-private.pem"
  openssl pkey -in "$key_dir/platform-private.pem" -pubout -out "$key_dir/platform-public.pem"
fi
chmod 600 -- "$key_dir/platform-private.pem" "$key_dir/platform-public.pem"
if [[ ! -e "$key_dir/kms-seed.yaml" ]]; then
  # Random local emulator key material, never a checked-in shared wrapping key.
  cat > "$key_dir/kms-seed.yaml" <<SEED
Keys:
  Symmetric:
    Aes:
      - Metadata:
          KeyId: 11111111-2222-4333-8444-555555555555
        BackingKeys:
          - $(openssl rand -hex 32)
SEED
fi
[[ -f "$key_dir/kms-seed.yaml" && ! -L "$key_dir/kms-seed.yaml" ]] || { echo 'Refusing linked KMS seed.' >&2; exit 1; }
chmod 600 -- "$key_dir/kms-seed.yaml"
printf 'Offline keys ready in %s\n' "$key_dir"

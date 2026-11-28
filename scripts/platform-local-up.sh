#!/usr/bin/env bash
set -euo pipefail
umask 077
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_dir"
command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 1; }
docker compose version >/dev/null
docker info >/dev/null
local_env="${PLATFORM_ENV_FILE:-${HOME}/.local/share/swarm-platform/local.env}"
mkdir -p -- "$(dirname -- "$local_env")"
# Parsing uses Node's env parser, never shell evaluation. Existing files are not overwritten.
node --input-type=module - "$local_env" "$repo_dir" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
const [file, root] = process.argv.slice(2);
const resolved = path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file));
if (resolved === root || resolved.startsWith(root + path.sep)) throw new Error('Local env files must be outside the git checkout.');
if (!fs.existsSync(file)) {
  const secrets = new Set(['POSTGRES_ADMIN_PASSWORD','POSTGRES_OWNER_PASSWORD','POSTGRES_RUNTIME_PASSWORD','SESSION_SECRET','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY','MINIO_ROOT_USER','MINIO_ROOT_PASSWORD','BACKUP_S3_ACCESS_KEY_ID','BACKUP_S3_SECRET_ACCESS_KEY','COMPOSIO_API_KEY','COMPOSIO_WEBHOOK_SECRET']);
  let source = fs.readFileSync(path.join(root, 'deploy/docker/.env.example'), 'utf8');
  source = source.replace(/^LOCAL_UID=.*$/m, `LOCAL_UID=${process.getuid()}`).replace(/^LOCAL_GID=.*$/m, `LOCAL_GID=${process.getgid()}`);
  source = source.replace(/^(\w+)=$/gm, (line, name) => {
    if (name === 'PLATFORM_KEYS_DIR') return `${name}='${path.join(path.dirname(path.resolve(file)), 'keys')}'`;
    if (name === 'MINIO_KMS_SECRET_KEY') return `${name}=local-key:${randomBytes(32).toString('base64')}`;
    return secrets.has(name) ? `${name}=${randomBytes(32).toString('hex')}` : line;
  });
  fs.writeFileSync(file, source, { mode: 0o600, flag: 'wx' });
}
if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Refusing linked env file.');
fs.chmodSync(file, 0o600);
JS
key_dir="$(node --input-type=module - "$local_env" <<'JS'
import fs from 'node:fs'; import { parseEnv } from 'node:util';
const env = parseEnv(fs.readFileSync(process.argv[2], 'utf8'));
if (!env.PLATFORM_KEYS_DIR?.startsWith('/')) throw new Error('PLATFORM_KEYS_DIR must be absolute.');
console.log(env.PLATFORM_KEYS_DIR);
JS
)"
bash scripts/platform-keys.sh "$key_dir"
# The env file is authoritative; do not accidentally inherit cloud credentials from the shell.
compose() {
  node --input-type=module - "$local_env" "$@" <<'JS'
import fs from 'node:fs'; import { parseEnv } from 'node:util'; import { spawnSync, execFileSync } from 'node:child_process';
const [file, ...args] = process.argv.slice(2), env = { ...process.env };
for (const name of Object.keys(parseEnv(fs.readFileSync(file, 'utf8')))) delete env[name];
env.SWARM_BUILD_REVISION = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const r = spawnSync('docker', ['compose', '--env-file', file, '-f', 'deploy/docker/compose.platform.yml', ...args], { env, stdio: 'inherit' });
process.exit(r.status ?? 1);
JS
}
compose build platform minio minio-init https
compose up -d --wait postgres local-kms minio
compose run --rm minio-init
compose run --rm migrate
compose up -d --wait --wait-timeout 180
node --input-type=module - "$local_env" <<'JS'
import fs from 'node:fs'; import { parseEnv } from 'node:util';
const env = parseEnv(fs.readFileSync(process.argv[2], 'utf8'));
console.log(`Platform: https://localhost:${env.PLATFORM_HTTPS_PORT || '8443'}`);
console.log(`Gateway: https://localhost:${env.GATEWAY_HTTPS_PORT || '8444'}/health`);
console.log(`Configuration: ${process.argv[2]}`);
console.log('Trust the local Caddy CA as described in docs/docker-platform.md.');
console.log(env.SWARM_LOCAL_PROVISIONER_HOLD === '1' ? 'Provisioning is HELD. External sign-in and connected apps are not configured.' : 'Provisioner started through the existing release gates.');
JS

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { parse } from 'yaml';
import { platformCredentialNames } from '../server/src/deployment.js';
import { startDockerProvisioner } from '../deploy/docker/provisioner-entrypoint.mjs';

const read = (name: string) => parse(fs.readFileSync(`deploy/docker/${name}`, 'utf8'), { merge: true });
const platform = read('compose.platform.yml'), standalone = read('compose.standalone.yml');
const tenantOnly = ['SWARM_TENANT_ID', 'TENANT_DATA_KEY_FILE', 'TENANT_MANIFEST_FILE', 'TENANT_RUNTIME_TOKEN_FILE', 'TENANT_HOST_TOKEN_FILE'];
function boundaries(config: any) {
  for (const [name, service] of Object.entries<any>(config.services)) {
    assert.ok(service.healthcheck?.test?.length && !service.healthcheck.disable, `${name}: healthcheck`);
    assert.equal(service.privileged, undefined, `${name}: privileged`);
    assert.ok(!(service.volumes ?? []).some((v: any) => /docker\.sock|\/run\/docker|\/var\/run:/.test(typeof v === 'string' ? v : JSON.stringify(v))), `${name}: Docker socket`);
    const env = service.environment ?? {};
    if (['platform', 'provisioner', 'composio-gateway'].includes(env.SWARM_ROLE)) {
      assert.equal(service.env_file, undefined, `${name}: unfiltered env file`);
      for (const key of tenantOnly) assert.equal(env[key], undefined, `${name}: tenant-only ${key}`);
      if (name !== 'migrate') assert.equal(env.MIGRATION_DATABASE_URL, undefined, `${name}: schema owner credential`);
    }
    if (env.SWARM_ROLE === 'tenant') {
      assert.equal(service.env_file, undefined);
      for (const key of [...platformCredentialNames, 'SESSION_SECRET', 'PLATFORM_PRIVATE_KEY_FILE']) assert.equal(env[key], undefined, `${name}: platform credential ${key}`);
      assert.equal(service.secrets?.length ?? 0, 0, `${name}: platform file secrets`);
    }
    for (const [key, value] of Object.entries(env)) {
      if (/PASSWORD|SECRET|ACCESS_KEY|SESSION_TOKEN|API_KEY|API_TOKEN|DATABASE_URL/.test(key)) assert.match(String(value), /\$\{[A-Z_]+/, `${name}: inline secret ${key}`);
    }
  }
}
test('both parsed compose manifests enforce health and credential boundaries', () => {
  boundaries(platform); boundaries(standalone);
  assert.deepEqual(platform.services.platform.secrets, ['platform_private_key', 'platform_public_key']);
  assert.deepEqual(platform.services['composio-gateway'].secrets, ['platform_public_key']);
  assert.equal(platform.services.provisioner.secrets, undefined);
  assert.equal(platform.services['composio-gateway'].environment.BACKUP_S3_SECRET_ACCESS_KEY, undefined);
  assert.equal(platform.networks.platform.internal, true);
  for (const [name, service] of Object.entries<any>(platform.services)) assert.deepEqual(service.networks, name === 'https' ? ['platform', 'ingress'] : ['platform']);
  for (const service of Object.values<any>(platform.services)) {
    assert.equal(service.read_only, true);
    assert.ok(service.security_opt.includes('no-new-privileges:true'));
    for (const port of service.ports ?? []) assert.match(port, /^127\.0\.0\.1:/);
  }
});
test('static boundary checks reject socket, secret, healthcheck and tenant credential regressions', () => {
  const changes = [
    (c: any) => { c.services.platform.volumes.push('/var/run/docker.sock:/var/run/docker.sock'); },
    (c: any) => { c.services.platform.environment.TENANT_DATA_KEY_FILE = '/bad'; },
    (c: any) => { c.services.platform.environment.SESSION_SECRET = 'inline-secret'; },
    (c: any) => { delete c.services.platform.healthcheck; },
    (c: any) => { c.services.platform.environment.SWARM_ROLE = 'tenant'; },
    (c: any) => { c.services.platform.env_file = '.env'; },
  ];
  for (const change of changes) { const copy = structuredClone(platform); change(copy); assert.throws(() => boundaries(copy)); }
});
test('same repo image, migration ordering, standalone data and tenant driver passthrough are explicit', () => {
  for (const name of ['platform', 'provisioner', 'composio-gateway', 'migrate']) {
    assert.equal(platform.services[name].image, platform.services.platform.image);
    assert.equal(platform.services[name].build.dockerfile, 'Dockerfile');
    if (name !== 'migrate') assert.equal(platform.services[name].depends_on.migrate.condition, 'service_completed_successfully');
  }
  assert.deepEqual(platform.services.migrate.command, ['node', 'server/dist/platform/migrate.js']);
  assert.match(platform.services.provisioner.environment.TENANT_DRIVER, /\$\{TENANT_DRIVER/);
  assert.equal(standalone.services.standalone.environment.SWARM_ROLE, 'standalone');
  assert.deepEqual(standalone.services.standalone.volumes, ['standalone-data:/data']);
});
test('env example documents every compose input with no credential values', () => {
  const example = fs.readFileSync('deploy/docker/.env.example', 'utf8');
  const declared = new Set([...example.matchAll(/^(\w+)=/gm)].map(m => m[1]));
  const compose = fs.readFileSync('deploy/docker/compose.platform.yml', 'utf8') + fs.readFileSync('deploy/docker/compose.standalone.yml', 'utf8');
  for (const match of compose.matchAll(/\$\{([A-Z0-9_]+)/g)) assert.ok(declared.has(match[1]), match[1]);
  for (const match of example.matchAll(/^(\w*(?:PASSWORD|SECRET|ACCESS_KEY_ID|API_KEY|API_TOKEN)\w*)=(.*)$/gm)) assert.equal(match[2], '', match[1]);
});
test('offline key script creates matching Ed25519 files, preserves them and refuses unsafe locations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-keys-test-'));
  fs.mkdirSync('.context', { recursive: true });
  const run = (target: string) => spawnSync('bash', ['scripts/platform-keys.sh', target], { encoding: 'utf8' });
  const local = fs.mkdtempSync(path.join(process.cwd(), '.context', 'keys-refused-'));
  try {
    assert.equal(run(dir).status, 0);
    const privateKey = fs.readFileSync(path.join(dir, 'platform-private.pem'));
    const publicKey = fs.readFileSync(path.join(dir, 'platform-public.pem'));
    assert.equal(createPrivateKey(privateKey).asymmetricKeyType, 'ed25519');
    assert.equal(createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }), publicKey.toString());
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    for (const file of ['platform-private.pem', 'platform-public.pem', 'kms-seed.yaml']) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
    assert.equal(run(dir).status, 0);
    assert.deepEqual(fs.readFileSync(path.join(dir, 'platform-private.pem')), privateKey);
    assert.notEqual(run(local).status, 0);
    fs.unlinkSync(path.join(dir, 'platform-public.pem'));
    assert.notEqual(run(dir).status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(local, { recursive: true, force: true }); }
});
test('local provisioner hold is explicit, checks the database and never starts a worker', async () => {
  let started = 0, healthy = true, closed = false;
  const service = await startDockerProvisioner({
    env: { SWARM_ROLE: 'provisioner', SWARM_LOCAL_PROVISIONER_HOLD: '1', SWARM_ALLOW_LOCAL_CLOUD: '1' }, port: 0,
    connect: async () => ({ pool: { query: async () => { if (!healthy) throw Error('offline'); }, end: async () => { closed = true; } } }),
    start: async () => { started++; throw Error('Must not start'); },
  });
  const url = `http://127.0.0.1:${(service.server.address() as any).port}/health`;
  try {
    assert.deepEqual(await (await fetch(url)).json(), { ok: true, role: 'provisioner', provisioning: 'held' });
    assert.equal(started, 0);
    healthy = false; assert.equal((await fetch(url)).status, 503);
  } finally { await service.close(); }
  assert.equal(closed, true);
});
test('provisioner defaults to the real release-gated entrypoint and never suppresses its refusal', async () => {
  let started = 0, closed = false;
  await assert.rejects(startDockerProvisioner({ env: { SWARM_ROLE: 'provisioner' }, port: 0,
    connect: async () => ({ pool: { end: async () => { closed = true; } } }),
    start: async () => { started++; throw Error('Runtime image lacks qualification evidence'); },
  }), /qualification evidence/);
  assert.equal(started, 1); assert.equal(closed, true);
  for (const env of [{ SWARM_ROLE: 'standalone' }, { SWARM_ROLE: 'provisioner', SWARM_LOCAL_PROVISIONER_HOLD: '1' }, { SWARM_ROLE: 'provisioner', SWARM_LOCAL_PROVISIONER_HOLD: 'yes' }]) {
    await assert.rejects(startDockerProvisioner({ env }));
  }
});

test('bootstrap creates protected offline configuration, preserves it and rejects an in-repo env file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bootstrap-test-'));
  fs.mkdirSync('.context', { recursive: true });
  const inside = fs.mkdtempSync(path.join(process.cwd(), '.context', 'env-refused-'));
  try {
    const fake = path.join(dir, 'bin'); fs.mkdirSync(fake);
    fs.writeFileSync(path.join(fake, 'docker'), '#!/bin/sh\nif [ "$1" = info ] || [ "$2" = version ]; then exit 0; fi\nexit 75\n', { mode: 0o700 });
    const file = path.join(dir, 'local.env');
    const run = (envFile: string) => spawnSync('bash', ['scripts/platform-local-up.sh'], {
      env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, PLATFORM_ENV_FILE: envFile }, encoding: 'utf8',
    });
    const first = run(file); assert.equal(first.status, 75, first.stderr);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const original = fs.readFileSync(file, 'utf8');
    assert.match(original, /^SESSION_SECRET=[a-f0-9]{64}$/m);
    assert.match(original, /^MINIO_KMS_SECRET_KEY=local-key:[A-Za-z0-9+/]{43}=$/m);
    assert.equal(run(file).status, 75);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    const forbidden = path.join(inside, 'local.env');
    assert.notEqual(run(forbidden).status, 0);
    assert.equal(fs.existsSync(forbidden), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(inside, { recursive: true, force: true }); }
});

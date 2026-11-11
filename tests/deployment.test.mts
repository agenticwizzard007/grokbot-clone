import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Each case runs deployment.ts in a fresh process because the role is fixed at import time.
const run = (env: Record<string, string | undefined>) => {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(NODE_ENV|SWARM_ROLE|DEV_LOGIN|SWARM_TENANT_ID)$/.test(k)) clean[k] = v;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "const d = await import(process.argv[1]); d.validateDeployment(); console.log('ok:' + d.deploymentRole);",
    path.resolve('server/src/deployment.ts')], { env: clean, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout + r.stderr).trim() };
};

test('production refuses a process whose role is not configured', () => {
  const r = run({ NODE_ENV: 'production' });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /Production requires SWARM_ROLE/);
  assert.match(r.out, /SWARM_ROLE=standalone/);
});

test('production accepts the single-server deployment when SWARM_ROLE=standalone is set (fly.toml)', () => {
  const r = run({ NODE_ENV: 'production', SWARM_ROLE: 'standalone' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ok:standalone/);
});

test('development runs as standalone without any role configured', () => {
  const r = run({});
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /ok:standalone/);
});

test('production still refuses development sign-in and unknown roles', () => {
  assert.match(run({ NODE_ENV: 'production', SWARM_ROLE: 'standalone', DEV_LOGIN: '1' }).out, /Development authentication is forbidden/);
  assert.match(run({ NODE_ENV: 'production', SWARM_ROLE: 'nonsense' }).out, /Invalid SWARM_ROLE/);
});

test('a tenant process still needs its identity, key and manifest', () => {
  assert.match(run({ NODE_ENV: 'production', SWARM_ROLE: 'tenant' }).out, /Tenant identity is required/);
  assert.match(run({ NODE_ENV: 'production', SWARM_ROLE: 'tenant', SWARM_TENANT_ID: 'usr_12345678abc' }).out, /Tenant key and volume manifest are required/);
});

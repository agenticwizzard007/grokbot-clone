import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Pool } from 'pg';

// Release-gate evidence recording against a disposable PostgreSQL schema. The command only records what an operator
// names (URI, artifact SHA-256, reviewer) and only approved rows satisfy assertQualifiedImage.
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required (disposable PostgreSQL only).');
const admin = new Pool({ connectionString: url });
const schema = `test_${randomBytes(8).toString('hex')}`;
await admin.query(`CREATE SCHEMA ${schema}`);
const connection = new URL(url); connection.searchParams.set('options', `-c search_path=${schema},public`);
const { Directory } = await import('../server/src/platform/directory.js');
const { releaseGatesCommand, releaseGateStatus, optionalGates } = await import('../server/src/platform/release-gates-cli.js');
const { infrastructureGates, assertQualifiedImage } = await import('../server/src/platform/release-policy.js');
const directory = new Directory(connection.href);
await directory.migrate(); await directory.migrate();

const image = `registry.fly.io/swarm-tenant-host@sha256:${'a'.repeat(64)}`;
const other = `registry.fly.io/swarm-tenant-host@sha256:${'b'.repeat(64)}`;
const digest = 'c'.repeat(64);
const uri = 's3://swarm-evidence/containment-2026-11-11.json';
const run = (args: string[]) => releaseGatesCommand(args, directory);

test('an image with no evidence is not qualified', async () => {
  await assert.rejects(assertQualifiedImage(directory.pool, image), /lacks infrastructure or provider qualification/);
  await assert.rejects(run(['verify', image]), /Missing or unapproved: fly-network-isolation/);
  assert.deepEqual((await releaseGateStatus(directory, image)).missing, infrastructureGates);
});

test('recording requires a pinned image, a known gate, a clean URI, a SHA-256 and a reviewer', async () => {
  await assert.rejects(run(['record', 'registry.fly.io/swarm-tenant-host:latest', 'signed-runtime-image', uri, digest, 'reviewer']), /digest|pinned|sha256/i);
  await assert.rejects(run(['record', image, 'not-a-gate', uri, digest, 'reviewer']), /Unknown gate/);
  await assert.rejects(run(['record', image, 'signed-runtime-image', 'https://user:secret@evidence.example/x.json', digest, 'reviewer']), /must not carry credentials/);
  await assert.rejects(run(['record', image, 'signed-runtime-image', 'http://evidence.example/x.json', digest, 'reviewer']), /absolute https:, s3: or file:/);
  await assert.rejects(run(['record', image, 'signed-runtime-image', uri, 'not-hex', 'reviewer']), /SHA-256/);
  await assert.rejects(run(['record', image, 'signed-runtime-image', uri, digest, ' ']), /Reviewer/);
  await assert.rejects(run(['record', image, 'signed-runtime-image', uri, digest]), /Usage/);
  assert.equal((await releaseGateStatus(directory, image)).gates.length, 0, 'nothing was recorded by rejected commands');
});

test('unapproved and withdrawn evidence never qualifies; approval does, for that image only', async () => {
  for (const gate of infrastructureGates) await run(['record', image, gate, uri, digest, 'alice@example.test']);
  let status = await releaseGateStatus(directory, image);
  assert.equal(status.qualified, false);
  assert.deepEqual(status.missing, infrastructureGates, 'recorded but unapproved rows do not count');
  assert.ok(status.gates.every(g => g.approved === false && g.approved_at === null && g.evidence_sha256 === digest && g.reviewer === 'alice@example.test'));
  await assert.rejects(assertQualifiedImage(directory.pool, image));

  for (const gate of infrastructureGates) await run(['record', image, gate, uri, digest, 'alice@example.test', '--approve']);
  status = await releaseGateStatus(directory, image);
  assert.equal(status.qualified, true); assert.deepEqual(status.missing, []); assert.deepEqual(status.incomplete, []);
  await assertQualifiedImage(directory.pool, image);
  assert.deepEqual(await run(['verify', image]), { image, qualified: true, provenance: 'complete', required: infrastructureGates });
  await assert.rejects(assertQualifiedImage(directory.pool, other), /lacks/, 'another image is unaffected');

  // Re-recording without --approve withdraws the approval.
  await run(['record', image, 'provider-quotas', uri, digest, 'alice@example.test']);
  await assert.rejects(run(['verify', image]), /Missing or unapproved: provider-quotas/);
  await assert.rejects(assertQualifiedImage(directory.pool, image));
});

test('an approval dated in the future does not count, and legacy rows without provenance are reported', async () => {
  for (const gate of infrastructureGates) await run(['record', other, gate, uri, digest, 'bob', '--approve']);
  await directory.pool.query("UPDATE release_gates SET approved_at=now()+interval '1 hour' WHERE image_digest=$1 AND name='signed-runtime-image'", [other]);
  await assert.rejects(assertQualifiedImage(directory.pool, other));
  assert.deepEqual((await releaseGateStatus(directory, other)).missing, ['signed-runtime-image']);
  await directory.pool.query('UPDATE release_gates SET evidence_sha256=NULL, reviewer=NULL, approved_at=now() WHERE image_digest=$1 AND name=$2', [other, 'signed-runtime-image']);
  const status = await releaseGateStatus(directory, other);
  assert.equal(status.qualified, true, 'assertQualifiedImage predicate is unchanged by provenance columns');
  assert.deepEqual(status.incomplete, ['signed-runtime-image'], 'but missing provenance is surfaced');
  await assertQualifiedImage(directory.pool, other);
  await assert.rejects(run(['verify', other]), /lack evidence SHA-256 or reviewer: signed-runtime-image/, 'operator verify refuses incomplete required provenance');
  await run(['record', other, 'signed-runtime-image', uri, digest, 'bob', '--approve']);
  assert.deepEqual(await run(['verify', other]), { image: other, qualified: true, provenance: 'complete', required: infrastructureGates });
});

test('the optional capacity gate is recorded but never required', async () => {
  assert.deepEqual(optionalGates, ['tenant-capacity-resize']);
  const fresh = `registry.fly.io/swarm-tenant-host@sha256:${'d'.repeat(64)}`;
  await run(['record', fresh, 'tenant-capacity-resize', uri, digest, 'carol', '--approve']);
  const status = await releaseGateStatus(directory, fresh);
  assert.equal(status.gates.length, 1); assert.equal(status.qualified, false);
  assert.deepEqual(status.missing, infrastructureGates, 'the optional gate does not substitute for required ones');
});

test('a tenant process refuses the command before touching the database', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('server/src/platform/release-gates-cli.ts'), 'list', image],
    { env: { ...process.env, SWARM_ROLE: 'tenant', SWARM_TENANT_ID: 'usr_12345678abc', DATABASE_URL: 'postgresql://must-not-be-used.invalid/x' }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /refused in a tenant process/);
});

test.after(async () => { await directory.pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

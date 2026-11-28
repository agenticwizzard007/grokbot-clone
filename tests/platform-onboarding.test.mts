import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { spawnSync } from 'node:child_process';
import { Directory, opaqueToken } from '../server/src/platform/directory.js';
import { AdmissionError, admissionCounts, tenantLimit } from '../server/src/platform/onboarding.js';
import { tenantsCommand } from '../server/src/platform/tenants-cli.js';
import { collectOperationsMetrics, renderOperationsMetrics } from '../server/src/platform/operations-metrics.js';

const url = process.env.TEST_DATABASE_URL;
test('platform admission and operator commands on disposable PostgreSQL', { skip: !url }, async t => {
  Object.assign(process.env, { SESSION_SECRET: 'fixture-onboarding-only-01234567890123456789', PLATFORM_URL: 'https://swarm.test', MESSAGING_SIGNUPS_PER_DAY: '0' });
  const { onboardingRoutes } = await import('../server/src/platform/onboarding-routes.js');
  delete process.env.MESSAGING_SIGNUP_MODE; delete process.env.PLATFORM_TENANT_LIMIT;
  const admin = new Pool({ connectionString: url }), schema = `test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const target = new URL(url!); target.searchParams.set('options', `-c search_path=${schema},public`);
  const directory = new Directory(target.href); await directory.migrate(); await directory.migrate();
  t.after(async () => { await directory.pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const command = (...args: string[]) => tenantsCommand(args, directory) as Promise<any>;
  const policy = async (mode: string, daily = 0) => {
    const current = await command('policy', 'show');
    return command('policy', 'set', '--mode', mode, '--signups-per-day', String(daily), '--revision', current.policy.revision);
  };
  const invite = async (uses = 1) => (await command('invites', 'create', '--uses', String(uses), '--days', '7', '--note', 'Fixture invitation')).invite.code as string;
  const identity = (subject: string, code?: string, provider = 'google') => directory.identity(provider, subject, { name: 'Fixture', email: 'fixture@example.test' }, undefined, code);
  const denial = (code: string) => (error: unknown) => error instanceof AdmissionError && error.code === code;
  await t.test('production defaults to invite mode and 100 tenants without needing a first tenant', async () => {
    assert.equal(tenantLimit(), 100);
    assert.equal((await command('policy', 'show')).policy.mode, 'invite');
    await assert.rejects(identity('uninvited'), denial('invite_needed'));
    assert.equal((await directory.pool.query('SELECT 1 FROM tenants')).rowCount, 0);
    assert.equal((await directory.pool.query('SELECT 1 FROM lifecycle_jobs')).rowCount, 0);
  });
  let existing: string;
  await t.test('first invitation creates one identity and one create job atomically', async () => {
    const code = await invite(); existing = await identity('existing', code);
    assert.equal((await directory.pool.query('SELECT uses FROM web_invites WHERE code=$1', [code])).rows[0].uses, 1);
    assert.equal((await directory.pool.query('SELECT operation FROM lifecycle_jobs WHERE tenant_id=$1', [existing])).rows[0].operation, 'create');
    assert.equal(await identity('existing', 'malformed'), existing);
  });
  await t.test('expired, revoked, exhausted and unknown invitations create nothing', async () => {
    for (const state of ['expired', 'revoked', 'exhausted', 'unknown']) {
      const code = await invite();
      if (state === 'expired') await directory.pool.query("UPDATE web_invites SET expires_at=now()-interval '1 second' WHERE code=$1", [code]);
      if (state === 'revoked') await command('invites', 'revoke', '--code', code);
      if (state === 'exhausted') await directory.pool.query('UPDATE web_invites SET uses=max_uses WHERE code=$1', [code]);
      const before = await admissionCounts(directory.pool);
      await assert.rejects(identity(state, state === 'unknown' ? 'A'.repeat(32) : code), denial('invite_invalid'));
      assert.deepEqual(await admissionCounts(directory.pool), before);
    }
  });
  await t.test('20 concurrent identities cannot spend the last invite use twice', async () => {
    const code = await invite(), results = await Promise.allSettled(Array.from({ length: 20 }, (_, n) => identity(`race-${n}`, code)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => denial('invite_invalid')(r.reason)));
    assert.equal((await directory.pool.query('SELECT uses FROM web_invites WHERE code=$1', [code])).rows[0].uses, 1);
  });
  await t.test('transaction rollback restores the invitation and leaves no tenant or lifecycle job', async () => {
    const code = await invite(), before = await admissionCounts(directory.pool);
    await assert.rejects(directory.transaction(async client => {
      await directory.identityInTransaction(client, 'apple', 'rolled-back', { name: 'Rollback' }, undefined, code);
      throw new Error('Fixture rollback');
    }), /Fixture rollback/);
    assert.deepEqual(await admissionCounts(directory.pool), before);
    assert.equal((await directory.pool.query('SELECT uses FROM web_invites WHERE code=$1', [code])).rows[0].uses, 0);
  });
  await t.test('cap applies in open mode and with invites, including simultaneous last-seat signups', async () => {
    const before = await admissionCounts(directory.pool); process.env.PLATFORM_TENANT_LIMIT = String(before.current + 1);
    const code = await invite(20);
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, n) => identity(`cap-${n}`, code)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => denial('at_capacity')(r.reason)));
    await policy('open'); await assert.rejects(identity('open-cap'), denial('at_capacity'));
    assert.equal((await directory.pool.query('SELECT uses FROM web_invites WHERE code=$1', [code])).rows[0].uses, 1);
    const metrics = await collectOperationsMetrics(directory);
    assert.equal(metrics.current_tenants, before.current + 1); assert.equal(metrics.tenant_limit, before.current + 1);
    assert.match(renderOperationsMetrics(metrics, 'platform', { ready: true }), /swarm_operations_tenant_limit/);
  });
  await t.test('existing accounts, explicit links and staged legacy claims bypass closed policy and cap', async () => {
    await policy('closed'); assert.equal(await identity('existing'), existing!);
    const raw = await directory.createSession(existing!, undefined, 'Fixture device');
    const { hashToken } = await import('../server/src/platform/directory.js');
    assert.equal(await directory.identity('apple', 'linked', { name: 'Linked' }, hashToken(raw)), existing!);
    for (const provider of ['google', 'apple', 'openrouter', 'phone']) {
      const tenant = `usr_${randomBytes(16).toString('hex')}`;
      await directory.pool.query('INSERT INTO tenants(id,display_name,composio_user_id) VALUES($1,$1,$1)', [tenant]);
      await directory.pool.query('INSERT INTO legacy_identity_claims(provider,subject,tenant_id,snapshot_hash) VALUES($1,$2,$3,$4)', [provider, 'legacy', tenant, 'a'.repeat(64)]);
      assert.equal(await identity('legacy', undefined, provider), tenant);
      assert.equal((await directory.pool.query('SELECT 1 FROM lifecycle_jobs WHERE tenant_id=$1', [tenant])).rowCount, 0);
    }
    await assert.rejects(identity('closed', await invite()), denial('closed'));
    delete process.env.PLATFORM_TENANT_LIMIT;
  });
  await t.test('daily allowance spans providers and is serialized, with zero meaning unlimited', async () => {
    const today = (await admissionCounts(directory.pool)).today;
    await policy('open', today + 1);
    const results = await Promise.allSettled(['google', 'apple', 'openrouter', 'phone'].map(provider => identity(`daily-${provider}`, undefined, provider)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => denial('at_capacity')(r.reason)));
    assert.equal(await identity('existing'), existing!);
    await policy('open', 0); await identity('unlimited');
  });
  await t.test('admission timestamps use wall time after waits so UTC rollover cannot backdate daily usage', async () => {
    await policy('open');
    await directory.transaction(async client => {
      await client.query('SELECT pg_sleep(0.03)');
      const admittedAfter = (await client.query('SELECT clock_timestamp() at')).rows[0].at;
      const tenant = await directory.identityInTransaction(client, 'google', 'admission-clock', { name: 'Clock fixture' });
      assert.equal((await client.query('SELECT created_at >= $2 AS fresh FROM tenants WHERE id=$1', [tenant, admittedAfter])).rows[0].fresh, true);
    });
  });
  await t.test('an invite expiring while admission waits on the lock is refused', async () => {
    await policy('invite');
    const code = await invite(), blocker = await directory.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT pg_advisory_xact_lock(hashtext('swarm-phone-signups'))");
      await blocker.query("UPDATE web_invites SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE code=$1", [code]);
      const pending = assert.rejects(identity('expired-during-wait', code), denial('invite_invalid'));
      await blocker.query('SELECT pg_sleep(0.3)'); await blocker.query('COMMIT'); await pending;
      assert.equal((await directory.pool.query('SELECT uses FROM web_invites WHERE code=$1', [code])).rows[0].uses, 0);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    await policy('open');
  });
  await t.test('only deleting, deleted and failed tenants are excluded from the cap', async () => {
    const base = (await admissionCounts(directory.pool)).current;
    for (const state of ['pending', 'provisioning', 'active', 'suspended', 'deleting', 'deleted', 'failed']) {
      const tenant = `usr_${randomBytes(16).toString('hex')}`;
      await directory.pool.query('INSERT INTO tenants(id,display_name,composio_user_id,state) VALUES($1,$1,$1,$2)', [tenant, state]);
    }
    assert.equal((await admissionCounts(directory.pool)).current, base + 4);
    process.env.PLATFORM_TENANT_LIMIT = 'invalid';
    await assert.rejects(identity('invalid-cap'), /Invalid PLATFORM_TENANT_LIMIT/);
    assert.equal(await identity('existing'), existing!); delete process.env.PLATFORM_TENANT_LIMIT;
  });
  await t.test('CLI validates unknown, duplicate, malformed and confirmation options without mutations', async () => {
    for (const args of [[], ['unknown', 'list'], ['tenants', 'list', '--force', 'yes'], ['invites', 'create', '--uses', '0'], ['invites', 'create', '--days', '1.5'], ['invites', 'create', '--uses', '2', '--uses', '3'], ['tenants', 'delete', '--id', existing!], ['tenants', 'delete', '--id', existing!, '--confirm', 'wrong'], ['policy', 'set', '--mode', 'open', '--revision', '0']]) await assert.rejects(command(...args));
    assert.notEqual((await command('tenants', 'status', '--id', existing!)).tenant.state, 'deleting');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/platform/tenants-cli.ts', 'bad'], { encoding: 'utf8', env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://secret:private@127.0.0.1:1/missing', SESSION_SECRET: 'never-print-me' } });
    assert.equal(result.status, 1); assert.doesNotMatch(result.stderr + result.stdout, /secret|private|never-print-me|postgres:\/\//);
    assert.ok(JSON.parse(result.stderr).error);
  });
  await t.test('operator CLI runs with only DATABASE_URL and no application or provider secrets', async () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/platform/tenants-cli.ts', 'policy', 'show'], { encoding: 'utf8', env: { PATH: process.env.PATH, DATABASE_URL: target.href } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).policy.mode, 'open');
    assert.equal(JSON.parse(result.stdout).capacity.limit, 100);
    assert.equal(result.stdout.includes(target.href), false);
  });
  await t.test('list and status output allowlists exclude credentials and session tokens', async () => {
    await directory.pool.query("UPDATE tenants SET encrypted_data_key=$2,fly_app='private-app' WHERE id=$1", [existing!, Buffer.from('never-print-key')]);
    const raw = await directory.createSession(existing!, undefined, 'Private session device');
    const output = JSON.stringify([await command('tenants', 'list'), await command('tenants', 'status', '--id', existing!)]);
    assert.doesNotMatch(output, /encrypted_data_key|private-app|never-print-key|session|ciphertext|payload/);
    assert.equal(output.includes(raw), false);
    assert.ok((await command('invites', 'list')).invites.length > 0);
  });
  await t.test('suspend and wake queue existing jobs idempotently; delete revokes and queues cleanup', async () => {
    await directory.pool.query("UPDATE lifecycle_jobs SET state='completed' WHERE tenant_id=$1", [existing!]);
    await directory.pool.query("UPDATE tenants SET state='active' WHERE id=$1", [existing!]);
    const first = await command('tenants', 'suspend', '--id', existing!);
    assert.equal(first.job.operation, 'suspend'); assert.equal(first.job.state, 'queued');
    assert.equal((await command('tenants', 'suspend', '--id', existing!)).job.id, first.job.id);
    await assert.rejects(command('tenants', 'wake', '--id', existing!), /pending/);
    await directory.pool.query("UPDATE lifecycle_jobs SET state='completed' WHERE tenant_id=$1", [existing!]);
    await directory.pool.query("UPDATE tenants SET state='suspended' WHERE id=$1", [existing!]);
    assert.equal((await command('tenants', 'wake', '--id', existing!)).job.operation, 'wake');
    const raw = await directory.createSession(existing!, undefined, 'Delete fixture');
    assert.equal((await command('tenants', 'delete', '--id', existing!, '--confirm', existing!)).state, 'deleting');
    assert.equal(await directory.session(raw), null);
    await command('tenants', 'delete', '--id', existing!, '--confirm', existing!);
    assert.equal((await directory.pool.query("SELECT 1 FROM lifecycle_jobs WHERE tenant_id=$1 AND operation='delete'", [existing!])).rowCount, 1);
    await assert.rejects(command('tenants', 'wake', '--id', existing!), /active or suspended/);
  });
  await t.test('public status and waitlist validate, deduplicate, rate limit and approve without messages', async () => {
    const app = new Hono().route('/api/auth', onboardingRoutes(directory));
    const post = (body: unknown, origin?: string) => app.request('/api/auth/waitlist', { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
    await policy('invite');
    assert.equal((await (await app.request('/api/auth/onboarding')).json() as any).state, 'invite_needed');
    const code = await invite();
    assert.equal((await (await app.request(`/api/auth/onboarding?invite=${code}`)).json() as any).state, 'invite_accepted');
    assert.equal((await (await app.request('/api/auth/onboarding?invite=bad')).json() as any).state, 'invite_invalid');
    assert.equal((await post({ contact: 'not a contact' })).status, 400);
    assert.equal((await post({ contact: 'fixture@example.test', secret: 'forbidden' })).status, 400);
    assert.equal((await post({ contact: 'fixture@example.test' }, 'https://foreign.test')).status, 403);
    for (const contact of ['fixture@example.test', 'fixture@example.test', '+15550000001']) assert.equal((await post({ contact })).status, 200);
    const list = await command('waitlist', 'list'); assert.equal(list.waitlist.length, 2);
    assert.equal((await directory.pool.query('SELECT 1 FROM web_waitlist WHERE approved_at IS NOT NULL')).rowCount, 0);
    const approved = await command('waitlist', 'approve', '--id', list.waitlist[0].id);
    assert.equal(approved.sent, false);
    assert.deepEqual(await command('waitlist', 'approve', '--id', list.waitlist[0].id), approved);
    assert.equal(new URL(approved.url).searchParams.get('invite'), approved.code);
    await identity('waitlist-invited', approved.code);
    await assert.rejects(identity('waitlist-again', approved.code), denial('invite_invalid'));
    for (let n = 0; n < 17; n++) assert.equal((await post({ contact: 'fixture@example.test' })).status, 200);
    assert.equal((await post({ contact: 'fixture@example.test' })).status, 429);
    await directory.pool.query('DELETE FROM platform_rate_windows');
    await directory.pool.query("INSERT INTO web_waitlist(id,contact,kind) SELECT lpad(n::text,43,'0'), 'waiter-'||n||'@example.test','email' FROM generate_series(1,9998) n");
    assert.equal((await post({ contact: 'full@example.test' })).status, 503);
    assert.equal((await post({ contact: 'fixture@example.test' })).status, 200, 'existing entries remain idempotent at capacity');
    const first = await command('waitlist', 'list'), second = await command('waitlist', 'list', '--after', first.next);
    assert.equal(first.waitlist.length, 100); assert.equal(second.waitlist.length, 100);
    assert.equal(new Set([...first.waitlist, ...second.waitlist].map(r => r.id)).size, 200);
    await directory.pool.query("UPDATE web_waitlist SET created_at=now()-interval '31 days'");
    const { pruneSignupMetadata } = await import('../server/src/platform/signup.js');
    await pruneSignupMetadata(directory);
    assert.equal((await directory.pool.query('SELECT 1 FROM web_waitlist')).rowCount, 0);
  });
});

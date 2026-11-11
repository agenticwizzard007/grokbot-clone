import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { Directory } from '../server/src/platform/directory.js';
import { RuntimeIdentity } from '../server/src/platform/runtime-identity.js';
import { runtimeOperations } from '../server/src/platform/runtime-operations.js';
import { setHostIntent } from '../server/src/platform/host-control.js';

const url = process.env.TEST_DATABASE_URL;
const defer = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
test('runtime metadata operations fence body, lock and expiration races', { skip: !url }, async t => {
  const admin = new Pool({ connectionString: url }), schema = `test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const connection = new URL(url!); connection.searchParams.set('options', `-c search_path=${schema},public`);
  const directory = new Directory(connection.href); await directory.migrate();
  t.after(async () => { await directory.pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const a = await directory.identity('google', 'runtime-owner-a', { name: 'A' });
  const b = await directory.identity('google', 'runtime-owner-b', { name: 'B' });
  await directory.pool.query("UPDATE tenants SET state='active',machine_id=id");
  await directory.pool.query("INSERT INTO host_policies(tenant_id,generation,machine_id,desired) SELECT id,generation,machine_id,'run' FROM tenants");
  const keys = await generateKeyPair('EdDSA', { extractable: true });
  const identity = new RuntimeIdentity(directory, await exportPKCS8(keys.privateKey), await exportSPKI(keys.publicKey));
  const sign = (tenant: string, lifetime = '5m') => identity.sign({ sub: tenant, machine: tenant, generation: '1' }, 'swarm-runtime', lifetime);
  const tokens = { a: await sign(a), b: await sign(b) }, revoked: string[] = [];
  const app = runtimeOperations(identity, (tenant, scope) => revoked.push(`${tenant}:${scope}`));
  const post = (route: string, body: unknown, token = tokens.a) => app.request(route, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const hashA = 'a'.repeat(64), hashB = 'b'.repeat(64);
  const route = async (tenant: string) => (await directory.pool.query('SELECT hash FROM companion_routes WHERE tenant_id=$1', [tenant])).rows;
  const seed = async () => { await directory.pool.query('INSERT INTO wake_events(tenant_id,id,ciphertext) VALUES($1,$3,$4),($2,$3,$4) ON CONFLICT DO NOTHING', [a, b, 'owned-event', Buffer.from('ciphertext')]); };
  const eventCount = async (tenant: string) => Number((await directory.pool.query('SELECT count(*) n FROM wake_events WHERE tenant_id=$1', [tenant])).rows[0].n);

  await t.test('companion scopes and event acknowledgements use only the authenticated owner', async () => {
    assert.equal((await post('/companions', { hash: hashA, scope: 'native-local' })).status, 200);
    assert.equal((await post('/companions', { hash: hashB, scope: 'native-local' }, tokens.b)).status, 200);
    assert.equal((await post('/companions', { hash: hashB, scope: 'native-local' })).status, 409);
    assert.deepEqual(await route(a), [{ hash: hashA }]); assert.deepEqual(await route(b), [{ hash: hashB }]);
    assert.equal((await post('/companions', { hash: null, scope: 'native-local', tenant: b })).status, 400);
    await seed();
    assert.equal((await post('/events/ack', { ids: ['owned-event'], tenant: b })).status, 400);
    assert.equal((await post('/events/ack', { ids: ['owned-event'] })).status, 200);
    assert.equal(await eventCount(a), 0); assert.equal(await eventCount(b), 1);
    assert.deepEqual(revoked, [`${a}:native-local`, `${b}:native-local`]);
  });

  for (const operation of ['companions', 'events/ack']) await t.test(`${operation} rejects generation replacement while reading the body`, async () => {
    await seed(); const entered = defer(); const verify = identity.verify.bind(identity);
    identity.verify = async (...args) => { const result = await verify(...args); entered.resolve(); return result; };
    let release!: (body: unknown) => void;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { release = body => { controller.enqueue(Buffer.from(JSON.stringify(body))); controller.close(); }; } });
    const pending = app.request(`/${operation}`, { method: 'POST', headers: { authorization: `Bearer ${tokens.a}`, 'content-type': 'application/json' }, body: stream, duplex: 'half' } as any);
    try {
      await entered.promise;
      await directory.pool.query('UPDATE tenants SET generation=generation+1 WHERE id=$1', [a]);
      release(operation === 'companions' ? { scope: 'native-local', hash: null } : { ids: ['owned-event'] });
      assert.equal((await pending).status, 409);
      assert.deepEqual(await route(a), [{ hash: hashA }]); assert.equal(await eventCount(a), 1);
    } finally { identity.verify = verify; await directory.pool.query('UPDATE tenants SET generation=1 WHERE id=$1', [a]); }
  });

  async function waitForLock() {
    for (let i = 0; i < 500; i++) {
      if ((await directory.pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query=$1", ['SELECT id FROM tenants WHERE id=$1 FOR UPDATE'])).rowCount) return;
      await new Promise(done => setTimeout(done, 5));
    }
    throw new Error('Runtime did not wait for the lifecycle lock.');
  }
  await t.test('a run permit changed to hold while waiting on the tenant lock cannot authorize a stale dispatch', async () => {
    const lock = await directory.pool.connect(); let effect = false;
    try {
      await lock.query('BEGIN'); await lock.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [a]);
      await setHostIntent(lock, { tenant: a, machine: a, generation: '1' }, 'hold');
      const pending = identity.authorized(tokens.a, async () => { effect = true; });
      const rejection = assert.rejects(pending, /revoked/);
      await waitForLock(); await lock.query('COMMIT'); await rejection;
      assert.equal(effect, false);
    } finally { await lock.query('ROLLBACK'); lock.release(); await directory.transaction(client => setHostIntent(client, { tenant: a, machine: a, generation: '1' }, 'run')); }
  });
  await t.test('a signed runtime token that expires during the lifecycle lock wait cannot mutate metadata', async () => {
    const lock = await directory.pool.connect(); let effect = false;
    try {
      const expiring = await sign(a, '2s');
      await lock.query('BEGIN'); await lock.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [a]);
      const rejection = assert.rejects(identity.authorized(expiring, async () => { effect = true; }), /revoked/);
      await waitForLock(); await new Promise(done => setTimeout(done, 2100)); await lock.query('COMMIT'); await rejection;
      assert.equal(effect, false);
    } finally { await lock.query('ROLLBACK'); lock.release(); }
  });
  await t.test('held and deleted runtimes cannot list encrypted events or alter registrations', async () => {
    await directory.transaction(client => setHostIntent(client, { tenant: a, machine: a, generation: '1' }, 'hold'));
    assert.equal((await app.request('/events', { headers: { authorization: `Bearer ${tokens.a}` } })).status, 401);
    assert.equal((await post('/companions', { hash: null, scope: 'native-local' })).status, 401);
    await directory.pool.query("UPDATE tenants SET state='deleting' WHERE id=$1", [a]);
    assert.equal((await post('/events/ack', { ids: ['owned-event'] })).status, 401);
    assert.deepEqual(await route(a), [{ hash: hashA }]); assert.equal(await eventCount(a), 1);
  });
});

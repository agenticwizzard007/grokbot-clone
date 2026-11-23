// P-13: real public routers with temporary SQLite and mocked model/toolkit backends.
// Run with node --import tsx --test tests/public-json-body-limits.test.mts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';
import { Hono } from 'hono';
import { PUBLIC_AUTH_BODY_LIMIT, PUBLIC_AUTH_TOO_LARGE } from '../server/src/security/body-limits.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-json-limits-'));
Object.assign(process.env, {
  NODE_ENV: 'development', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', SWARM_NO_SCHEDULER: '1',
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'public-json-local-fixture', COMPUTER_PROVIDER: 'local',
  COMPOSIO_API_KEY: '', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', XAI_API_KEY: '',
  LLM_PROVIDER: 'direct', INKBOX_API_KEY: '', INKBOX_ADMIN_API_KEY: '', INKBOX_TUNNEL: '0',
  APP_URL: 'http://localhost', SERVER_URL: 'http://localhost',
});
const backend = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Unexpected model, toolkit or messaging request in local fixture');
});
const { db } = await import('../server/src/db.js');
const { messagingPublic } = await import('../server/src/messaging/routes.js');
const { createInvite, activeClaim } = await import('../server/src/messaging/signup.js');
const app = new Hono().route('/api', messagingPublic);
const invite = createInvite(null, { maxUses: 100 });
const phone = '+1 (555) 000-0100';
const loginId = 'local-phone-attempt';
const code = '123456';
db.prepare('INSERT INTO users(id,email,name,phone,created_at) VALUES(?,?,?,?,?)')
  .run('fixture-user', 'fixture@example.test', 'Fixture account', '15550000100', Date.now());
db.prepare('INSERT INTO phone_logins(id,phone,code_hash,created_at,expires_at) VALUES(?,?,?,?,?)')
  .run(loginId, '15550000100', createHash('sha256').update(`${loginId}:${code}`).digest('hex'), Date.now(), Date.now() + 600_000);

const routes = [
  { url: `/api/join/${invite.code}/claim`, body: { phone }, status: 200 },
  { url: '/api/auth/text/request', body: { phone }, status: 200 },
  { url: '/api/auth/phone/start', body: { phone }, status: 503 },
  { url: '/api/auth/phone/verify', body: { id: loginId, code: '654321' }, status: 400 },
];
const post = (url: string, body: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  app.request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, duplex: 'half' } as RequestInit);
const padded = (body: object, size: number) => {
  const raw = JSON.stringify({ ...body, padding: '' });
  return JSON.stringify({ ...body, padding: 'x'.repeat(size - Buffer.byteLength(raw)) });
};
const unchanged = () => {
  assert.equal(activeClaim('15550000100'), undefined, 'invalid requests do not reserve an invite');
  const row = db.prepare('SELECT attempts,used_at FROM phone_logins WHERE id=?').get(loginId);
  assert.deepEqual(row, { attempts: 0, used_at: null }, 'invalid requests do not consume a verification attempt');
  assert.equal((db.prepare('SELECT count(*) n FROM phone_logins').get() as { n: number }).n, 1);
  assert.equal((db.prepare('SELECT count(*) n FROM auth_sessions').get() as { n: number }).n, 0);
  assert.equal(backend.mock.callCount(), 0, 'invalid requests do not reach backends');
};

after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('P-13 declared oversize bodies return 413 without reading the stream', async () => {
  for (const { url } of routes) {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.close(); } }, { highWaterMark: 0 });
    const response = await post(url, body, { 'content-length': String(PUBLIC_AUTH_BODY_LIMIT + 1) });
    assert.equal(response.status, 413, url);
    assert.deepEqual(await response.json(), { error: PUBLIC_AUTH_TOO_LARGE });
    assert.equal(reads, 0);
  }
  unchanged();
});

test('P-13 streams without a length stop reading at the byte cap before parsing', async () => {
  for (const { url } of routes) {
    let reads = 0;
    // Invalid JSON must still return 413, and reading must stop before the final chunk.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new Uint8Array(512).fill(120));
        if (reads === 12) controller.close();
      },
    }, { highWaterMark: 0 });
    const response = await post(url, body);
    assert.equal(response.status, 413, url);
    assert.deepEqual(await response.json(), { error: PUBLIC_AUTH_TOO_LARGE });
    assert.equal(reads, 9, 'only read through the first chunk exceeding 4 KB');
  }
  unchanged();
});

test('P-13 limits count UTF-8 bytes and reject one byte over the boundary', async () => {
  for (const { url, body } of routes) {
    for (const raw of [padded(body, PUBLIC_AUTH_BODY_LIMIT + 1), JSON.stringify({ ...body, padding: '界'.repeat(1400) })]) {
      assert.ok(Buffer.byteLength(raw) > PUBLIC_AUTH_BODY_LIMIT);
      const response = await post(url, raw);
      assert.equal(response.status, 413, url);
      assert.deepEqual(await response.json(), { error: PUBLIC_AUTH_TOO_LARGE });
    }
  }
  unchanged();
});

test('P-13 malformed JSON and non-object bodies consistently return 400', async () => {
  for (const { url } of routes) {
    for (const raw of ['', '{', 'null', '[]', '123', 'true', '"fixture-private-input"']) {
      const response = await post(url, raw);
      assert.equal(response.status, 400, url);
      assert.deepEqual(await response.json(), { error: 'Invalid JSON body' });
    }
  }
  unchanged();
});

test('P-13 required string fields reject coercion and excessive lengths without echoing input', async () => {
  const privateInput = 'fixture-private-input';
  for (const { url, body } of routes) {
    const fields = url.endsWith('/verify') ? { id: 128, code: 32, inviteCode: 128 } : { phone: 64 };
    for (const [field, max] of Object.entries(fields)) {
      const invalid: unknown[] = [null, 123456, true, [privateInput], { value: privateInput }, privateInput.repeat(max)];
      if (field !== 'inviteCode') invalid.push(undefined, '');
      for (const value of invalid) {
        const response = await post(url, JSON.stringify({ ...body, [field]: value }));
        assert.equal(response.status, 400, `${url}: ${field}`);
        const error = await response.json() as { error: string };
        assert.match(error.error, new RegExp(`^Invalid ${field}:`));
        assert.ok(!JSON.stringify(error).includes(privateInput));
      }
    }
  }
  unchanged();
});

test('P-13 valid bodies at the byte boundary still reach each public handler', async () => {
  for (const { url, body, status } of routes) {
    const raw = padded(body, PUBLIC_AUTH_BODY_LIMIT);
    assert.equal(Buffer.byteLength(raw), PUBLIC_AUTH_BODY_LIMIT);
    for (const headers of [{}, { 'content-length': String(Buffer.byteLength(raw)) }]) {
      const response = await post(url, raw, headers);
      assert.equal(response.status, status, url);
    }
  }
  assert.equal(activeClaim('15550000100')?.invite_code, invite.code);
  assert.equal((db.prepare('SELECT attempts FROM phone_logins WHERE id=?').get(loginId) as { attempts: number }).attempts, 2);
  const verified = await post('/api/auth/phone/verify', JSON.stringify({ id: loginId, code, inviteCode: '' }));
  assert.equal(verified.status, 200);
  assert.deepEqual(await verified.json(), { ok: true, created: false });
  assert.match(verified.headers.get('set-cookie') ?? '', /swarm_session=/);
});

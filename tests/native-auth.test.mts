import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { Hono } from 'hono';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-native-auth-'));
Object.assign(process.env, { DB_PATH: path.join(temp, 'test.db'), FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'native-test-only', SERVER_URL: 'https://swarm.test', APP_URL: 'https://swarm.test', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '' });
const { db } = await import('../server/src/db.js');
const { nativeAuth, finishNativeLogin } = await import('../server/src/native-auth.js');
const { userFromCookieHeader } = await import('../server/src/lib/auth.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('user-a', 'a@example.com', 'A', Date.now());
const app = new Hono();
app.route('/api/auth/native', nativeAuth);
// Model the already-verified Google callback, without contacting a provider.
app.get('/verified-callback', (c) => c.json({ callback: finishNativeLogin(c, 'user-a') }));
app.get('/denied-callback', (c) => c.json({ callback: finishNativeLogin(c, undefined, 'google_denied') }));
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

const secret = () => crypto.randomBytes(32).toString('base64url');
async function start() {
  const verifier = secret(), state = secret();
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const res = await app.request(`/api/auth/native/start?challenge=${challenge}&state=${state}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/api/auth/google/start');
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  assert.match(res.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(res.headers.get('set-cookie')!, /Secure/);
  return { verifier, state, cookie };
}
async function finish(cookie: string, path = '/verified-callback') {
  const res = await app.request(path, { headers: { cookie } });
  assert.match(res.headers.get('set-cookie')!, /Max-Age=0/);
  return (await res.json()).callback as string | null;
}
const exchange = (code: string, verifier: string) => app.request('/api/auth/native/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, verifier }) });

test('system-browser handoff creates an HttpOnly secure session only for the initiating app, once', async () => {
  const flow = await start();
  const callback = new URL((await finish(flow.cookie))!);
  assert.equal(callback.protocol, 'so.swarms.app:');
  assert.equal(callback.host, 'auth');
  assert.equal(callback.searchParams.get('state'), flow.state);
  const code = callback.searchParams.get('code')!;
  assert.equal(callback.searchParams.has('token'), false);
  assert.equal((await exchange(code, secret())).status, 401, 'intercepting the code is insufficient');
  const res = await exchange(code, flow.verifier);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const cookie = res.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(userFromCookieHeader(cookie.split(';')[0])?.id, 'user-a');
  assert.deepEqual(await res.json(), { ok: true }, 'session credentials never go in JSON');
  assert.equal((await exchange(code, flow.verifier)).status, 401, 'codes cannot be replayed');
});

test('pending and expired attempts cannot be redeemed', async () => {
  const pending = await start();
  assert.equal((await exchange(pending.cookie.split('=')[1], pending.verifier)).status, 401);
  db.prepare('UPDATE native_login_attempts SET expires_at=? WHERE id=?').run(Date.now() - 1, pending.cookie.split('=')[1]);
  assert.equal(await finish(pending.cookie), null);
  const flow = await start();
  const callback = new URL((await finish(flow.cookie))!);
  db.prepare('UPDATE native_login_attempts SET expires_at=?').run(Date.now() - 1);
  assert.equal((await exchange(callback.searchParams.get('code')!, flow.verifier)).status, 401);
});

test('Google failure returns the matching state and no redeemable code', async () => {
  const flow = await start();
  const callback = new URL((await finish(flow.cookie, '/denied-callback'))!);
  assert.equal(callback.searchParams.get('state'), flow.state);
  assert.equal(callback.searchParams.get('error'), 'google_denied');
  assert.equal(callback.searchParams.has('code'), false);
  assert.equal(await finish(flow.cookie), null);
});

test('another browser cannot finish an attempt and a callback cannot issue a second code', async () => {
  const flow = await start();
  assert.equal(await finish('swarm_native_attempt=unknown'), null);
  assert.ok(await finish(flow.cookie));
  assert.equal(await finish(flow.cookie), null);
});

test('malformed requests fail closed', async () => {
  for (const query of ['', '?challenge=short&state=short', `?challenge=${secret()}&state=https://evil.test`]) {
    assert.equal((await app.request(`/api/auth/native/start${query}`)).status, 400);
  }
  for (const body of ['bad json', '{}', '{"code":5,"verifier":{}}', 'null']) {
    assert.equal((await app.request('/api/auth/native/exchange', { method: 'POST', body })).status, 400);
  }
  assert.equal((await exchange(secret(), 'x'.repeat(129))).status, 400);
});

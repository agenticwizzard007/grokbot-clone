import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd1-google-'));
Object.assign(process.env, {
  SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'd1-local-fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'fixture-project',
  GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret',
  SERVER_URL: 'https://swarm.test', APP_URL: 'https://swarm.test',
});
mock.method(globalThis, 'fetch', async () => { throw new Error('No external requests in D1 fixtures'); });
const { db, now } = await import('../server/src/db.js');
const { composio, startConnect } = await import('../server/src/composio.js');
const { api } = await import('../server/src/routes.js');
const app = new Hono().route('/api', api);
let gmailAuthorizations = 0;
// The managed Gmail auth config belongs to connect-apps. Its scopes must never be replaced by login scopes.
const gmailScopes = ['https://mail.google.com/'];
mock.method(composio(), 'create', async (userId: string, options: any) => {
  assert.equal(options.manageConnections, false);
  return { sessionId: 'd1-session', authorize: async (toolkit: string, input: any) => {
    gmailAuthorizations++;
    assert.equal(toolkit, 'gmail');
    assert.deepEqual(Object.keys(input), ['callbackUrl'], 'preserve managed Gmail scopes without a login override');
    const consent = new URL('https://connect.fixture/consent');
    consent.searchParams.set('scope', gmailScopes.join(' '));
    return { id: 'fixture-gmail', redirectUrl: consent.href };
  } };
});
mock.method(composio().connectedAccounts, 'list', async () => ({ items: [], nextCursor: null }) as any);
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function begin() {
  const response = await app.request('/api/auth/google/start');
  const url = new URL(response.headers.get('location')!);
  const cookie = response.headers.getSetCookie().find(v => v.startsWith('swarm_google_attempt='))!.split(';')[0];
  return { url, cookie };
}

test('D1 login scopes are exactly identity scopes while connect Gmail retains Gmail access', async () => {
  const { url } = await begin();
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.deepEqual(url.searchParams.get('scope')!.split(' '), ['openid', 'email', 'profile']);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('nonce'));
  assert.equal(gmailAuthorizations, 0);
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('d1-user', 'd1@example.test', 'D1', now());
  const connection = await startConnect('d1-user', 'gmail', 'https://swarm.test/api/apps/callback');
  assert.deepEqual(new URL(connection.redirectUrl).searchParams.get('scope')!.split(' '), gmailScopes);
  assert.equal(gmailAuthorizations, 1);
});

test('D1 missing, partial or blank Google client configuration restores the Composio login', async () => {
  const before = gmailAuthorizations;
  for (const [id, secret] of [[undefined, undefined], ['', ''], ['fixture-client', ''], ['', 'fixture-secret'], ['   ', 'fixture-secret'], ['fixture-client', '  ']]) {
    if (id === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = id;
    if (secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = secret;
    try {
      const response = await app.request('/api/auth/google/start');
      assert.equal(response.headers.get('location'), 'https://connect.fixture/consent?scope=https%3A%2F%2Fmail.google.com%2F');
      assert.equal((await (await app.request('/api/auth/me')).json() as any).googleLogin, true);
      assert.ok(gmailAuthorizations > before);
    } finally {
      process.env.GOOGLE_CLIENT_ID = 'fixture-client'; process.env.GOOGLE_CLIENT_SECRET = 'fixture-secret';
    }
  }
});

test('D1 failed and expired callbacks return welcome recovery state without token exchange', async () => {
  for (const [query, expected] of [
    ['status=failed&error=connection+is+no+longer+awaiting+completion', 'google_expired'],
    ['status=failed&error=Link+session+has+expired', 'google_expired'],
    ['status=failed', 'google_failed'],
    ['error=access_denied', 'google_denied'],
  ]) {
    const { url, cookie } = await begin();
    const response = await app.request(`/api/auth/google/callback?state=${url.searchParams.get('state')}&${query}`, { headers: { cookie } });
    assert.equal(response.headers.get('location'), `https://swarm.test/?login=${expected}`);
    assert.equal(response.headers.getSetCookie().some(v => v.startsWith('swarm_session=')), false);
  }
});

test('D1 each click starts a fresh attempt and an expired attempt returns welcome recovery state', async () => {
  const first = await begin(), second = await begin();
  assert.notEqual(first.url.searchParams.get('state'), second.url.searchParams.get('state'));
  assert.notEqual(first.url.searchParams.get('code_challenge'), second.url.searchParams.get('code_challenge'));
  const state = first.url.searchParams.get('state');
  db.prepare('UPDATE google_oidc_attempts SET expires_at=? WHERE id=?').run(now() - 1, state);
  const response = await app.request(`/api/auth/google/callback?state=${state}&code=unused`, { headers: { cookie: first.cookie } });
  assert.equal(response.headers.get('location'), 'https://swarm.test/?login=google_expired');
});

test('D1 existing sessions survive missing configuration and failed sign-in attempts', async () => {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('d1-existing', 'existing@example.test', 'Existing', now());
  db.prepare('INSERT INTO google_identities VALUES (?,?)').run('existing-google-subject', 'd1-existing');
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)')
    .run('existing-session', 'd1-existing', now(), now() + 3600_000);
  const session = 'swarm_session=existing-session';
  const profile = async () => await (await app.request('/api/auth/me', { headers: { cookie: session } })).json() as any;
  delete process.env.GOOGLE_CLIENT_SECRET;
  try {
    assert.equal((await profile()).user.id, 'd1-existing');
    assert.equal((await profile()).googleLinked, true);
    assert.equal((await app.request('/api/auth/google/start', { headers: { cookie: session } })).headers.get('location'),
      'https://connect.fixture/consent?scope=https%3A%2F%2Fmail.google.com%2F');
    assert.equal((await profile()).user.id, 'd1-existing');
  } finally { process.env.GOOGLE_CLIENT_SECRET = 'fixture-secret'; }
  const { url, cookie } = await begin();
  await app.request(`/api/auth/google/callback?state=${url.searchParams.get('state')}&status=failed`, { headers: { cookie: `${session}; ${cookie}` } });
  assert.equal((await profile()).user.id, 'd1-existing');
});

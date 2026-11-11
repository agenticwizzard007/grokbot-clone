import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test, mock } from 'node:test';
import { Hono } from 'hono';
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, SignJWT, jwtVerify } from 'jose';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-apple-'));
const signing = await generateKeyPair('ES256', { extractable: true });
const apple = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...await exportJWK(apple.publicKey), kid: 'apple-test', alg: 'RS256', use: 'sig' };
Object.assign(process.env, {
  DB_PATH: path.join(root, 'db.sqlite'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'apple-tests-only', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '',
  APP_URL: 'https://swarm.test', SERVER_URL: 'https://swarm.test', APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567',
  APPLE_SERVICE_ID: 'so.swarm.web', APPLE_IOS_CLIENT_ID: 'so.swarms.app', APPLE_MACOS_CLIENT_ID: 'so.swarms.app.macos', APPLE_PRIVATE_KEY: await exportPKCS8(signing.privateKey),
});
const { db } = await import('../server/src/db.js');
const { appleAuth } = await import('../server/src/auth/apple.js');
const { verifyAppleIdentity, appleClientSecret, appleAvailability, revokeAppleAccess } = await import('../server/src/auth/apple-provider.js');
const { userFromCookieHeader } = await import('../server/src/lib/auth.js');
const app = new Hono().route('/api/auth/apple', appleAuth);
const random = () => crypto.randomBytes(32).toString('base64url');
const challenge = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');
const codes = new Map<string, { nonce: string; client: string; subject: string; email?: string; verified?: boolean; web: boolean; bad?: boolean }>();
let tokenRequests = 0, revokeRequests = 0, rejectRevocation = false;
const token = (payload: Record<string, unknown>, key = apple.privateKey) => new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'apple-test' }).setIssuer('https://appleid.apple.com').setIssuedAt().setExpirationTime('5m').sign(key);
mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [jwk] });
  if (url === 'https://appleid.apple.com/auth/token') {
    tokenRequests++;
    const body = new URLSearchParams(String(init?.body));
    const code = body.get('code')!;
    const data = codes.get(code);
    codes.delete(code);
    if (!data) return Response.json({ error: 'invalid_grant' }, { status: 400 });
    assert.equal(body.get('client_id'), data.client);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('redirect_uri'), data.web ? 'https://swarm.test/api/auth/apple/callback' : null);
    const { payload } = await jwtVerify(body.get('client_secret')!, signing.publicKey, { issuer: 'TEAM123456', audience: 'https://appleid.apple.com', subject: data.client, algorithms: ['ES256'] });
    assert.ok(payload.exp! - payload.iat! <= 300);
    return Response.json({ id_token: await token({ sub: data.subject, aud: data.client, nonce: data.bad ? 'wrong' : data.nonce, email: data.email, email_verified: data.verified ?? true }), refresh_token: `refresh-${data.subject}` });
  }
  if (url === 'https://appleid.apple.com/auth/revoke') {
    revokeRequests++;
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get('token_type_hint'), 'refresh_token');
    assert.match(body.get('token')!, /^refresh-/);
    return new Response('', { status: rejectRevocation ? 503 : 200 });
  }
  if (new URL(url).hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (new URL(url).hostname === 'telemetry.composio.dev') return Response.json({});
  throw new Error('Unexpected network request');
});
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function account(id: string, email: string) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, email, 'Existing user', Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3600000);
  db.prepare('UPDATE auth_sessions SET authenticated_at=created_at,last_seen_at=created_at WHERE user_id=?').run(id);
  return `swarm_session=${id}`;
}
function register(attempt: any, subject: string, email?: string, options: { bad?: boolean; verified?: boolean } = {}) {
  const code = random();
  codes.set(code, { nonce: attempt.nonce, client: attempt.client_id, subject, email, web: attempt.client === 'web', ...options });
  return code;
}
async function native(client = 'ios', cookie?: string) {
  const verifier = random();
  const response = await app.request('/api/auth/apple/native/start', { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ client, challenge: challenge(verifier), intent: cookie ? 'link' : 'signin' }) });
  assert.equal(response.status, 200);
  const { attempt } = await response.json();
  const row = db.prepare('SELECT * FROM apple_login_attempts WHERE id=?').get(attempt) as any;
  return { row, verifier };
}
const complete = (flow: Awaited<ReturnType<typeof native>>, code: string, verifier = flow.verifier, name = 'Apple member') => app.request('/api/auth/apple/native/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ attempt: flow.row.id, verifier, code, name }) });
const user = (response: Response) => userFromCookieHeader(response.headers.getSetCookie().find(value => value.startsWith('swarm_session='))?.split(';')[0]);
async function web(cookie?: string) {
  const response = await app.request(`/api/auth/apple/start${cookie ? '?intent=link' : ''}`, { headers: cookie ? { cookie } : {} });
  assert.equal(response.status, 302);
  const url = new URL(response.headers.get('location')!);
  assert.equal(url.origin, 'https://appleid.apple.com');
  assert.equal(url.searchParams.get('response_mode'), 'form_post');
  const browserCookie = response.headers.get('set-cookie')!;
  assert.match(browserCookie, /HttpOnly/); assert.match(browserCookie, /SameSite=None/); assert.match(browserCookie, /Secure/);
  return { row: db.prepare('SELECT * FROM apple_login_attempts WHERE id=?').get(url.searchParams.get('state')) as any, cookie: browserCookie.split(';')[0] };
}
const callback = (flow: Awaited<ReturnType<typeof web>>, body: Record<string, string>, cookie = flow.cookie) => app.request('/api/auth/apple/callback', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ state: flow.row.id, ...body }) });

test('only configured client types are enabled and the client secret is scoped and short-lived', async () => {
  assert.deepEqual(appleAvailability(), { web: true, ios: true, macos: true });
  const saved = process.env.APPLE_SERVICE_ID; delete process.env.APPLE_SERVICE_ID;
  assert.equal(appleAvailability().web, false); process.env.APPLE_SERVICE_ID = saved;
  const jwt = await appleClientSecret('so.swarms.app');
  assert.equal((await jwtVerify(jwt, signing.publicKey)).payload.sub, 'so.swarms.app');
  await assert.rejects(appleClientSecret('attacker-client'));
});

test('identity verification rejects forged signatures, wrong issuer/audience/nonce and expired tokens', async () => {
  const getKey = createLocalJWKSet({ keys: [jwk] });
  const claims = { sub: 'subject', aud: 'so.swarms.app', nonce: 'nonce', email: 'relay@privaterelay.appleid.com', email_verified: true };
  assert.deepEqual(await verifyAppleIdentity(await token(claims), 'so.swarms.app', 'nonce', getKey), { subject: 'subject', email: claims.email });
  for (const payload of [{ ...claims, aud: 'other' }, { ...claims, nonce: 'wrong' }]) await assert.rejects(verifyAppleIdentity(await token(payload), 'so.swarms.app', 'nonce', getKey));
  const expired = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'apple-test' }).setIssuer('https://appleid.apple.com').setIssuedAt(1).setExpirationTime(2).sign(apple.privateKey);
  await assert.rejects(verifyAppleIdentity(expired, 'so.swarms.app', 'nonce', getKey));
  const wrongIssuer = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'apple-test' }).setIssuer('https://evil.test').setIssuedAt().setExpirationTime('5m').sign(apple.privateKey);
  await assert.rejects(verifyAppleIdentity(wrongIssuer, 'so.swarms.app', 'nonce', getKey));
  const forged = await token(claims, (await generateKeyPair('RS256')).privateKey);
  await assert.rejects(verifyAppleIdentity(forged, 'so.swarms.app', 'nonce', getKey));
});

test('native sign-in supports private relay and returning users without a name or email', async () => {
  const flow = await native();
  const code = register(flow.row, 'private-subject', 'private@privaterelay.appleid.com');
  const before = tokenRequests;
  assert.equal((await complete(flow, code, random())).status, 401);
  assert.equal(tokenRequests, before, 'wrong proof never reaches Apple');
  const response = await complete(flow, code);
  assert.equal(response.status, 200);
  const first = user(response)!;
  assert.equal(first.email, 'private@privaterelay.appleid.com');
  assert.equal(first.name, 'Apple member');
  assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(response.headers.get('set-cookie')!, /Secure/);
  assert.equal((await complete(flow, code)).status, 401);
  const returning = await native('macos');
  const again = await complete(returning, register(returning.row, 'private-subject'));
  assert.equal(user(again)?.id, first.id);
  assert.equal((db.prepare('SELECT count(*) AS n FROM apple_refresh_tokens WHERE user_id=?').get(first.id) as any).n, 2);
  const tokens = db.prepare('SELECT token FROM apple_refresh_tokens WHERE user_id=?').all(first.id) as any[];
  assert.ok(tokens.every(r => r.token.startsWith('v1:') && !r.token.includes('refresh-')));
});

test('browser callback is cookie-bound, single-use, and trusts only the signed token email', async () => {
  const flow = await web();
  const code = register(flow.row, 'web-subject', 'verified@example.com');
  const before = tokenRequests;
  const rejected = await callback(flow, { code }, '');
  assert.match(rejected.headers.get('location')!, /apple_session/);
  assert.equal(tokenRequests, before);
  const response = await callback(flow, { code, user: JSON.stringify({ email: 'attacker@example.com', name: { firstName: 'Casey', lastName: 'Apple' } }) });
  assert.equal(response.status, 303);
  assert.equal(user(response)?.email, 'verified@example.com');
  assert.equal(user(response)?.name, 'Casey Apple');
  assert.match((await callback(flow, { code })).headers.get('location')!, /apple_session/);
});

test('existing emails require explicit linking; matching Apple identity takes priority over changing email', async () => {
  const cookie = account('existing', 'same@example.com');
  const flow = await native();
  const response = await complete(flow, register(flow.row, 'link-subject', 'same@example.com'));
  assert.equal((await response.json()).error, 'apple_link_required');
  assert.equal(user(response), null);
  const linking = await web(cookie);
  const linked = await callback(linking, { code: register(linking.row, 'link-subject', 'private-link@privaterelay.appleid.com') });
  assert.equal(user(linked)?.id, 'existing');
  assert.match(linked.headers.get('location')!, /#settings\/account/);
  const again = await native();
  assert.equal(user(await complete(again, register(again.row, 'link-subject', 'changed@example.com')))?.id, 'existing');
  const otherCookie = account('other', 'other@example.com');
  const wrong = await native('ios', otherCookie);
  assert.equal((await (await complete(wrong, register(wrong.row, 'link-subject'))).json()).error, 'apple_already_linked');
});

test('cancelled, stale, unverified and wrong-nonce authorizations create no session', async () => {
  const denied = await web();
  assert.match((await callback(denied, { error: 'access_denied' })).headers.get('location')!, /apple_denied/);
  const expired = await native();
  db.prepare('UPDATE apple_login_attempts SET expires_at=0 WHERE id=?').run(expired.row.id);
  assert.equal((await complete(expired, 'unused')).status, 401);
  for (const options of [{ bad: true }, { verified: false }]) {
    const flow = await native();
    const response = await complete(flow, register(flow.row, random(), 'not-verified@example.com', options));
    assert.equal(response.status, 401);
    assert.equal(user(response), null);
  }
  const cookie = account('logout-link', 'logout@example.com');
  const linking = await native('ios', cookie);
  db.prepare('DELETE FROM auth_sessions WHERE token=session_hash(?)').run('logout-link');
  assert.equal((await complete(linking, 'unused')).status, 401, 'logging out invalidates an outstanding link');
});

test('refresh tokens are revoked server-side; failures retain the credentials for retry', async () => {
  const id = (db.prepare('SELECT user_id FROM apple_identities WHERE subject=?').get('private-subject') as any).user_id;
  rejectRevocation = true;
  await assert.rejects(revokeAppleAccess(id));
  assert.ok(db.prepare('SELECT 1 FROM apple_refresh_tokens WHERE user_id=?').get(id));
  rejectRevocation = false;
  await revokeAppleAccess(id);
  assert.equal(db.prepare('SELECT 1 FROM apple_refresh_tokens WHERE user_id=?').get(id), undefined);
  assert.equal(revokeRequests, 3);
});

test('bad native payloads and unsupported clients fail closed', async () => {
  for (const body of ['null', '{}', 'not json', JSON.stringify({ client: 'attacker', challenge: random() })]) {
    assert.equal((await app.request('/api/auth/apple/native/start', { method: 'POST', body })).status, 400);
  }
  assert.equal((await app.request('/api/auth/apple/native/complete', { method: 'POST', body: '{}' })).status, 400);
});

test('account deletion requires a session and explicit confirmation, and revokes Apple before deleting', async () => {
  const { api } = await import('../server/src/routes.js');
  const server = new Hono().route('/api', api);
  const cookie = account('delete-me', 'delete@example.com');
  const linking = await native('ios', cookie);
  assert.equal((await complete(linking, register(linking.row, 'delete-subject', 'delete@example.com'))).status, 200);
  const remove = (headers: Record<string, string>, body: unknown) => server.request('/api/account', { method: 'DELETE', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await remove({}, { confirmation: 'DELETE' })).status, 401);
  assert.equal((await remove({ cookie }, {})).status, 400);
  assert.equal((await remove({ cookie, origin: 'https://evil.test' }, { confirmation: 'DELETE' })).status, 403);
  rejectRevocation = true;
  assert.equal((await remove({ cookie }, { confirmation: 'DELETE' })).status, 502);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id=?').get('delete-me'));
  rejectRevocation = false;
  assert.equal((await remove({ cookie }, { confirmation: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id=?').get('delete-me'), undefined);
  assert.equal(db.prepare('SELECT 1 FROM apple_identities WHERE subject=?').get('delete-subject'), undefined);
});

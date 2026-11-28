import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { Hono } from 'hono';
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { Directory, opaqueToken, hashToken } from '../server/src/platform/directory.js';
import { tenantsCommand } from '../server/src/platform/tenants-cli.js';
import { platformSecrets } from '../server/src/platform/crypto.js';

const url = process.env.TEST_DATABASE_URL;
test('all hosted and native sign-in paths enforce platform admission', { skip: !url }, async t => {
  const signing = await generateKeyPair('RS256', { extractable: true }), appleSigning = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...await exportJWK(signing.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' };
  Object.assign(process.env, { PLATFORM_URL: 'https://swarm.test', SERVER_URL: 'https://swarm.test', APP_URL: 'https://swarm.test',
    SESSION_SECRET: 'fixture-onboarding-only-01234567890123456789', MESSAGING_SIGNUP_MODE: 'invite', MESSAGING_SIGNUPS_PER_DAY: '0',
    GOOGLE_CLIENT_ID: 'fixture-google', GOOGLE_CLIENT_SECRET: 'fixture-secret', APPLE_TEAM_ID: 'fixture-team', APPLE_KEY_ID: 'fixture-key',
    APPLE_SERVICE_ID: 'fixture-web', APPLE_IOS_CLIENT_ID: 'fixture-ios', APPLE_MACOS_CLIENT_ID: 'fixture-macos', APPLE_PRIVATE_KEY: await exportPKCS8(appleSigning.privateKey) });
  const admin = new Pool({ connectionString: url }), schema = `test_${randomBytes(8).toString('hex')}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const target = new URL(url!); target.searchParams.set('options', `-c search_path=${schema},public`);
  const directory = new Directory(target.href); await directory.migrate();
  t.after(async () => { await directory.pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const { platformAuth } = await import('../server/src/platform/auth.js');
  const { platformMessaging } = await import('../server/src/platform/messaging.js');
  const events: unknown[] = [];
  const envelopes = { create: async (tenant: string) => { events.push({ tenant }); }, event: async (...args: unknown[]) => { events.push(args); }, encrypt: async () => 'fixture-encrypted' };
  const app = new Hono().route('/api/auth', platformAuth(directory, envelopes as any, () => {}));
  app.route('/', platformMessaging(directory, envelopes as any, {} as any, () => {}, {
    ready: () => true, verify: () => false, line: async () => ({ number: '+15550000000', connectCommand: 'connect @fixture', smsLink: 'sms:+15550000000?&body=connect%20%40fixture' }), send: async () => 'fixture-receipt',
  }));
  const codes = new Map<string, { provider: string; subject: string; nonce: string; client: string }>();
  let routerSubject = '';
  t.mock.method(globalThis, 'fetch', async (input: any, init?: RequestInit) => {
    const u = String(input);
    if (u === 'https://www.googleapis.com/oauth2/v3/certs' || u === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [jwk] });
    if (u === 'https://oauth2.googleapis.com/token' || u === 'https://appleid.apple.com/auth/token') {
      const fields = new URLSearchParams(String(init?.body)), value = codes.get(fields.get('code')!); assert.ok(value);
      assert.equal(init?.redirect, 'error');
      const id_token = await new SignJWT({ sub: value.subject, nonce: value.nonce, email: 'fixture@example.test', email_verified: true })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(value.provider === 'google' ? 'https://accounts.google.com' : 'https://appleid.apple.com').setAudience(value.client).setIssuedAt().setExpirationTime('5m').sign(signing.privateKey);
      return Response.json({ id_token, refresh_token: 'fixture-refresh-never-print' });
    }
    if (u === 'https://openrouter.ai/api/v1/auth/keys') return Response.json({ key: 'sk-or-v1-abcdefghijklmnopqrstuvwxyz123456', user_id: routerSubject });
    if (u === 'https://openrouter.ai/api/v1/key') return Response.json({ data: { label: 'Fixture' } });
    throw new Error('Unexpected outbound request.');
  });
  const post = (route: string, body: unknown, cookie = '') => app.request(route, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
  const invite = async () => ((await tenantsCommand(['invites', 'create'], directory)) as any).invite.code as string;
  const challenge = (value: string) => createHash('sha256').update(value).digest('base64url');
  async function oauth(provider: string, subject: string, invitation?: string, nativeCookie = '') {
    const started = await app.request(`/api/auth/${provider}/start${invitation ? `?invite=${invitation}` : ''}`, { headers: { cookie: nativeCookie } });
    assert.equal(started.status, 302);
    const redirect = new URL(started.headers.get('location')!), state = redirect.searchParams.get('state')!;
    const attempt = (await directory.pool.query('SELECT payload FROM auth_attempts WHERE hash=$1', [hashToken(state)])).rows[0];
    if (invitation) assert.equal(JSON.stringify(attempt).includes(invitation), false, 'invitation stays encrypted in the OAuth attempt');
    const code = opaqueToken();
    codes.set(code, { provider, subject, nonce: redirect.searchParams.get('nonce')!, client: provider === 'google' ? 'fixture-google' : 'fixture-web' });
    routerSubject = subject;
    const cookie = [nativeCookie, started.headers.getSetCookie()[0].split(';')[0]].filter(Boolean).join('; ');
    return provider === 'apple' ? app.request('/api/auth/apple/callback', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, state }) })
      : app.request(`/api/auth/${provider}/callback?code=${code}&state=${state}`, { headers: { cookie } });
  }
  for (const provider of ['google', 'apple', 'openrouter']) {
    await t.test(`${provider} callback without an invite creates no tenant, job, key event or session`, async () => {
      const before = events.length, result = await oauth(provider, `denied-${provider}`);
      assert.match(result.headers.get('location')!, /onboarding=invite_needed/);
      assert.equal(result.headers.getSetCookie().some(v => v.startsWith('swarm_session=')), false);
      assert.equal((await directory.pool.query('SELECT 1 FROM identities WHERE provider=$1 AND subject=$2', [provider, `denied-${provider}`])).rowCount, 0);
      assert.equal(events.length, before);
    });
    await t.test(`${provider} carries an invite through the OAuth attempt, consumes once and signs existing identities in`, async () => {
      const code = await invite(), result = await oauth(provider, `allowed-${provider}`, code);
      assert.equal(result.headers.get('location'), 'https://swarm.test');
      assert.ok(result.headers.getSetCookie().some(v => v.startsWith('swarm_session=')));
      assert.equal((await directory.pool.query('SELECT uses FROM web_invites WHERE code=$1', [code])).rows[0].uses, 1);
      assert.match((await oauth(provider, `other-${provider}`, code)).headers.get('location')!, /onboarding=invite_invalid/);
      assert.equal((await oauth(provider, `allowed-${provider}`, 'invalid')).headers.get('location'), 'https://swarm.test');
    });
  }
  for (const provider of ['google', 'openrouter']) await t.test(`${provider} native browser handoff carries the invitation and keeps PKCE single use`, async () => {
    for (const allowed of [false, true]) {
      const code = allowed ? await invite() : undefined, verifier = opaqueToken(), state = opaqueToken();
      const started = await app.request(`/api/auth/native/start?challenge=${challenge(verifier)}&state=${state}&provider=${provider}${code ? `&invite=${code}` : ''}`);
      assert.equal(started.status, 302);
      const cookie = started.headers.getSetCookie()[0].split(';')[0];
      const result = await oauth(provider, `native-${provider}-${allowed}`, undefined, cookie);
      const redirect = new URL(result.headers.get('location')!);
      if (!allowed) { assert.equal(redirect.searchParams.get('onboarding'), 'invite_needed'); continue; }
      assert.equal(redirect.protocol, 'so.swarms.app:'); assert.equal(redirect.searchParams.get('state'), state);
      assert.equal(redirect.searchParams.has('token'), false);
      const body = { code: redirect.searchParams.get('code'), verifier };
      assert.equal((await post('/api/auth/native/exchange', { ...body, verifier: opaqueToken() })).status, 401);
      assert.equal((await post('/api/auth/native/exchange', body)).status, 200);
      assert.equal((await post('/api/auth/native/exchange', body)).status, 401);
    }
  });
  for (const client of ['ios', 'macos']) await t.test(`Apple ${client} native completion gates new identities`, async () => {
    for (const allowed of [false, true]) {
      const invitation = allowed ? await invite() : undefined, verifier = opaqueToken();
      const start = await post('/api/auth/apple/native/start', { client, challenge: challenge(verifier), inviteCode: invitation });
      assert.equal(start.status, 200); const body = await start.json() as any, code = opaqueToken();
      codes.set(code, { provider: 'apple', subject: `native-${client}-${allowed}`, nonce: body.nonce, client: `fixture-${client}` });
      const response = await post('/api/auth/apple/native/complete', { attempt: body.attempt, verifier, code });
      assert.equal(response.status, allowed ? 200 : 403);
      if (!allowed) assert.equal((await response.json() as any).onboarding, 'invite_needed');
    }
  });
  async function phone(number: string, invitation?: string) {
    const response = await post('/api/auth/phone/start', { phone: number, inviteCode: invitation });
    assert.equal(response.status, 200); const body = await response.json() as any;
    const row = (await directory.pool.query('SELECT * FROM phone_attempts WHERE hash=$1', [hashToken(body.id)])).rows[0];
    const proof = platformSecrets().open<any>(`phone:${hashToken(body.id)}`, row.ciphertext);
    return { id: body.id, code: proof.code, cookie: response.headers.getSetCookie()[0].split(';')[0] };
  }
  await t.test('phone stores the invitation at start and admits only after valid phone proof', async () => {
    const invitation = await invite(), a = await phone('+15551110001', invitation);
    assert.equal((await post('/api/auth/phone/verify', { id: a.id, code: 'wrong' }, a.cookie)).status, 401);
    assert.equal((await directory.pool.query('SELECT uses FROM web_invites WHERE code=$1', [invitation])).rows[0].uses, 0);
    assert.equal((await post('/api/auth/phone/verify', { id: a.id, code: a.code }, a.cookie)).status, 200);
    assert.equal((await directory.pool.query('SELECT uses FROM web_invites WHERE code=$1', [invitation])).rows[0].uses, 1);
    const denied = await phone('+15551110002');
    const response = await post('/api/auth/phone/verify', { id: denied.id, code: denied.code }, denied.cookie);
    assert.equal(response.status, 403); assert.equal((await response.json() as any).onboarding, 'invite_needed');
    assert.equal((await directory.pool.query("SELECT 1 FROM identities WHERE provider='phone' AND subject='15551110002'")).rowCount, 0);
  });
  await t.test('OAuth cap denial leaves the invite unused and existing browser sign-in works', async () => {
    process.env.PLATFORM_TENANT_LIMIT = '1';
    const code = await invite();
    assert.match((await oauth('google', 'over-cap', code)).headers.get('location')!, /onboarding=at_capacity/);
    assert.equal((await directory.pool.query('SELECT uses FROM web_invites WHERE code=$1', [code])).rows[0].uses, 0);
    assert.equal((await oauth('google', 'allowed-google')).headers.get('location'), 'https://swarm.test');
    delete process.env.PLATFORM_TENANT_LIMIT;
  });
  await t.test('platform discovery is explicit and signup state is never inferred from a failed request', async () => {
    const me = await (await app.request('/api/auth/me')).json() as any;
    assert.equal(me.platform, true); assert.equal(me.user, null);
  });
});

import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { Hono } from 'hono';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-diagnostics-'));
const signing = await generateKeyPair('ES256', { extractable: true });
const identityKey = await generateKeyPair('RS256', { extractable: true });
const jwk = { ...await exportJWK(identityKey.publicKey), kid: 'fixture', alg: 'RS256', use: 'sig' };
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.sqlite'), FILES_DIR: path.join(root, 'files'), DEV_LOGIN: '1',
  SESSION_SECRET: 'diagnostics-local-fixture-secret-0123456789', PLATFORM_URL: 'https://swarm.test',
  APP_URL: 'https://swarm.test', SERVER_URL: 'https://swarm.test', COMPUTER_PROVIDER: 'local',
  COMPOSIO_API_KEY: '', XAI_API_KEY: '', LLM_PROVIDER: 'direct', DIRECT_BASE_URL: 'https://model.test/v1',
  DIRECT_API_KEY: 'fixture-model-key', OPENROUTER_BASE_URL: 'https://router.test/v1',
  GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-client-secret',
  APPLE_TEAM_ID: 'FIXTURE', APPLE_KEY_ID: 'FIXTURE', APPLE_SERVICE_ID: 'fixture.web',
  APPLE_IOS_CLIENT_ID: 'fixture.ios', APPLE_PRIVATE_KEY: await exportPKCS8(signing.privateKey),
});
const privateContent = 'fixture-private-content';
const credential = 'sk-or-v1-fixture_private_credential_123456';
let mode = 'success', nonce = '', appleClient = 'fixture.web', sequence = 0;
const logs: string[] = [];
mock.method(console, 'warn', (...args: unknown[]) => { logs.push(args.join(' ')); });
mock.method(console, 'error', (...args: unknown[]) => { logs.push(args.join(' ')); });
const sensitiveError = () => Object.assign(new Error(`${privateContent} ${credential}`), {
  code: privateContent, body: { access_token: credential }, cause: new Error(privateContent),
});
mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
  const url = String(input);
  if (url.endsWith('/certs') || url.endsWith('/auth/keys') && url.includes('appleid')) return Response.json({ keys: [jwk] });
  if (url.includes('telemetry.composio.dev')) return Response.json({});
  if (url.includes('registry.npmjs.org')) return Response.json({ version: '0.28.0' });
  if (mode === 'network') throw sensitiveError();
  if (mode === 'provider') return Response.json({ error: privateContent, token: credential }, { status: 503 });
  if (url === 'https://router.test/v1/key') return Response.json({ data: { label: privateContent } });
  if (url === 'https://router.test/v1/auth/keys') return Response.json({ key: credential, user_id: mode === 'identity' ? null : `subject-${sequence}` });
  if (url === 'https://oauth2.googleapis.com/token' || url === 'https://appleid.apple.com/auth/token') {
    const apple = url.includes('appleid');
    const token = await new SignJWT({ sub: `subject-${sequence}`, email: `fixture-${sequence}@example.test`, email_verified: true,
      name: privateContent, nonce: mode === 'identity' ? 'invalid-nonce' : nonce })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(apple ? 'https://appleid.apple.com' : 'https://accounts.google.com')
      .setAudience(apple ? appleClient : 'fixture-client').setIssuedAt().setExpirationTime('5m').sign(identityKey.privateKey);
    return Response.json({ id_token: token, refresh_token: credential });
  }
  // Model and toolkit backends are never contacted by this auth-only fixture.
  throw new Error('Unexpected fixture request');
});
const { db } = await import('../server/src/db.js');
const { googleAuth } = await import('../server/src/auth/google.js');
const { appleAuth } = await import('../server/src/auth/apple.js');
const { openrouterAuth } = await import('../server/src/auth/openrouter.js');
const { platformAuth } = await import('../server/src/platform/auth.js');
const { authBoundary, authFailure, authStage } = await import('../server/src/auth/events.js');
const legacy = new Hono().route('/google', googleAuth).route('/apple', appleAuth).route('/openrouter', openrouterAuth);
const proof = () => randomBytes(32).toString('base64url');
const tables = { google: 'google_oidc_attempts', apple: 'apple_login_attempts', openrouter: 'openrouter_login_attempts' };
type Provider = keyof typeof tables;
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function platformFixture() {
  let row: any;
  const directory = {
    session: async () => null,
    createSession: async () => { if (mode === 'session') throw sensitiveError(); return proof(); },
    identity: async () => {
      if (mode === 'account') throw sensitiveError();
      if (mode === 'conflict') throw new Error('identity_already_linked');
      return 'fixture-tenant';
    },
    pool: { query: async (sql: string, values: any[] = []) => {
      if (sql.startsWith('INSERT INTO auth_attempts')) row = { hash: values[0], provider: values[1], browser: values[2], payload: values[3], link_session: values[4] };
      if (sql.includes('RETURNING *')) {
        if (mode === 'attempt') throw sensitiveError();
        const found = row && mode !== 'expired' && row.hash === values[0] && row.provider === values[1] && row.browser === values[2] ? row : undefined;
        row = undefined;
        return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    } },
  };
  const envelopes = { create: async () => { if (mode === 'delivery') throw sensitiveError(); }, event: async () => {} };
  return platformAuth(directory as any, envelopes as any, () => {});
}

async function begin(app: Hono, provider: Provider) {
  mode = 'success'; appleClient = 'fixture.web'; sequence++;
  const result = await app.request(`/${provider}/start`);
  assert.equal(result.status, 302);
  const url = new URL(result.headers.get('location')!);
  nonce = url.searchParams.get('nonce') ?? '';
  return { state: url.searchParams.get('state')!, cookie: result.headers.getSetCookie()[0].split(';')[0] };
}
function finish(app: Hono, provider: Provider, attempt: { state: string; cookie: string }, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ state: attempt.state, code: privateContent, ...extra });
  const headers = { cookie: `${attempt.cookie}; fixture_cookie=${privateContent}`, authorization: `Bearer ${credential}`, 'X-Auth-Correlation-ID': privateContent };
  return app.request(`/${provider}/callback${provider === 'apple' ? '' : `?${params}`}`, provider === 'apple'
    ? { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: params.toString() }
    : { headers });
}
function diagnostic(response: Response, provider: Provider, surface: string, reason: string, stage: string) {
  assert.equal(logs.length, 1, 'one diagnostic per failed request with no raw framework error');
  const event = JSON.parse(logs[0]);
  const id = response.headers.get('x-auth-correlation-id');
  assert.match(id!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(event, { event: 'authentication_failure', correlation_id: id, provider, surface, stage, status: 'failure', error_code: reason });
  assert.ok(!logs[0].includes(privateContent));
  assert.ok(!logs[0].includes(credential));
  assert.ok(!logs[0].includes('@example.test'));
  assert.ok(!logs[0].includes('subject-'));
  return id;
}

for (const surface of ['legacy', 'platform'] as const) {
  for (const provider of ['google', 'apple', 'openrouter'] as const) {
    test(`${surface} ${provider} retains safe correlated failure reasons`, async t => {
      for (const [failure, reason, stage] of [
        ['provider', 'provider_failure', 'provider'], ['network', 'provider_failure', 'provider'],
        ['identity', 'invalid_identity', 'identity'], ['expired', 'attempt_expired', 'attempt'],
        ['conflict', 'link_conflict', 'account'], ['account', 'storage_failure', 'account'],
        ['attempt', 'storage_failure', 'attempt'], ['session', 'storage_failure', 'session'],
        ...(surface === 'platform' ? [['delivery', 'storage_failure', 'delivery']] : []),
      ]) {
        await t.test(failure, async () => {
          const app = surface === 'legacy' ? legacy : platformFixture();
          const attempt = await begin(app, provider);
          if (surface === 'legacy' && failure === 'expired') db.prepare(`UPDATE ${tables[provider]} SET expires_at=0 WHERE id=?`).run(attempt.state);
          const prepare = db.prepare.bind(db);
          const replacement = surface === 'legacy' ? mock.method(db, 'prepare', (sql: string) => {
            if (failure === 'account' && sql.includes(`INSERT INTO ${provider}_identities`)
              || failure === 'attempt' && sql.startsWith(`DELETE FROM ${tables[provider]}`)
              || failure === 'session' && sql.includes('INSERT INTO auth_sessions')) throw sensitiveError();
            if (failure === 'conflict' && sql.includes(`INSERT INTO ${provider}_identities`)) throw new Error(`${provider}_already_linked`);
            return prepare(sql);
          }) : undefined;
          mode = failure; logs.length = 0;
          try {
            const response = await finish(app, provider, attempt);
            assert.ok([302, 303].includes(response.status));
            assert.match(response.headers.get('location')!, new RegExp(`[?]login=${provider}_`));
            diagnostic(response, provider, surface, reason, stage);
          } finally { replacement?.mock.restore(); }
        });
      }
      await t.test('success emits no failure', async () => {
        const app = surface === 'legacy' ? legacy : platformFixture();
        const attempt = await begin(app, provider); logs.length = 0;
        const response = await finish(app, provider, attempt);
        assert.ok([302, 303].includes(response.status));
        assert.ok(!response.headers.get('location')!.includes('login='));
        assert.equal(logs.length, 0);
      });
      await t.test('provider denial ignores raw error text', async () => {
        const app = surface === 'legacy' ? legacy : platformFixture();
        const attempt = await begin(app, provider); logs.length = 0;
        diagnostic(await finish(app, provider, attempt, { error: privateContent, error_description: credential }),
          provider, surface, 'provider_denied', surface === 'legacy' ? 'attempt' : 'request');
      });
    });
  }
}

test('concurrent callback failures get independent server-generated correlation IDs', async () => {
  logs.length = 0;
  const results = await Promise.all(['google', 'openrouter'].map(provider => legacy.request(`/${provider}/callback?state=${privateContent}`, {
    headers: { 'X-Auth-Correlation-ID': privateContent },
  })));
  assert.equal(logs.length, 2);
  const ids = results.map(response => response.headers.get('x-auth-correlation-id'));
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(new Set(logs.map(line => JSON.parse(line).correlation_id)), new Set(ids));
  assert.ok(logs.every(line => JSON.parse(line).error_code === 'attempt_invalid' && !line.includes(privateContent)));
});

test('unknown errors and fallback failures cannot leak arbitrary properties', async () => {
  for (const error of [sensitiveError(), { message: privateContent, code: credential }, `${privateContent}\n${credential}`]) {
    const app = new Hono().get('/', authBoundary('google', 'legacy', c => {
      authStage(c, 'account'); authFailure(c, error); throw error;
    }, () => { throw sensitiveError(); }));
    logs.length = 0;
    const response = await app.request('/');
    assert.equal(response.status, 500);
    diagnostic(response, 'google', 'legacy', 'storage_failure', 'account');
  }
});

for (const surface of ['legacy', 'platform'] as const) {
  test(`${surface} native Apple completion records provider and identity failures`, async () => {
    for (const [failure, reason, stage] of [['network', 'provider_failure', 'provider'], ['identity', 'invalid_identity', 'identity']]) {
      mode = 'success'; appleClient = 'fixture.ios'; sequence++;
      const app = surface === 'legacy' ? legacy : platformFixture();
      const verifier = proof();
      const request = (route: string, body: unknown) => app.request(route, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` }, body: JSON.stringify(body),
      });
      const started = await request('/apple/native/start', { client: 'ios', challenge: createHash('sha256').update(verifier).digest('base64url') });
      assert.equal(started.status, 200);
      const attempt = await started.json() as { attempt: string; nonce: string };
      nonce = attempt.nonce; mode = failure; logs.length = 0;
      const response = await request('/apple/native/complete', { attempt: attempt.attempt, verifier, code: privateContent, name: privateContent });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'apple_invalid' });
      diagnostic(response, 'apple', surface, reason, stage);
    }
  });
}

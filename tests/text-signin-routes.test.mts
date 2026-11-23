// P-14: local dev server, temporary SQLite, fake deliveries and mocked backends.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-signin-limits-'));
Object.assign(process.env, {
  NODE_ENV: 'development', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', SWARM_NO_SCHEDULER: '1',
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'text-signin-local-fixture', COMPUTER_PROVIDER: 'local',
  COMPOSIO_API_KEY: '', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', XAI_API_KEY: '',
  LLM_PROVIDER: 'direct', INKBOX_API_KEY: '', INKBOX_ADMIN_API_KEY: '', INKBOX_TUNNEL: '0',
  APP_URL: 'http://localhost', SERVER_URL: 'http://localhost',
  MESSAGING_TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
});
const localFetch = globalThis.fetch;
const backend = mock.method(globalThis, 'fetch', async () => {
  throw new Error('Unexpected model, toolkit or messaging backend request');
});
let now = Date.now();
mock.method(Date, 'now', () => now);
const { db } = await import('../server/src/db.js');
const { messagingPublic } = await import('../server/src/messaging/routes.js');
const { registerAdapter } = await import('../server/src/messaging/bridge.js');
const { upsertLink } = await import('../server/src/messaging/store.js');
const { TEXT_SIGNIN_WINDOW_MS } = await import('../server/src/messaging/text-signin-limiter.js');
const deliveries: string[] = [];
registerAdapter({
  transport: 'inkbox', ready: () => true, format: (text) => text, maxChars: () => 10_000,
  send: async (link) => { deliveries.push(link.phone!); return `fixture-${deliveries.length}`; },
});
const app = new Hono().route('/api', messagingPublic);
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(() => { now += TEXT_SIGNIN_WINDOW_MS; deliveries.length = 0; });

let accountIndex = 0;
function account(phone: string, linked = true) {
  const id = `fixture-${++accountIndex}`;
  db.prepare('INSERT INTO users(id,email,name,phone,created_at) VALUES(?,?,?,?,?)')
    .run(id, `${id}@example.test`, 'Fixture account', phone, now);
  if (linked) upsertLink(id, 'imessage', 'inkbox', { status: 'connected', phone, chatRef: `fixture-${phone}` });
}
const tokenCount = () => (db.prepare('SELECT count(*) n FROM login_tokens').get() as { n: number }).n;
async function request(phone: string, source: string, extraHeaders: Record<string, string> = {}) {
  const response = await localFetch(`${origin}/api/auth/text/request`, {
    method: 'POST', body: JSON.stringify({ phone }),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': source, ...extraHeaders },
  });
  return { status: response.status, body: await response.json() };
}
const accepted = { status: 200, body: { ok: true } };
const throttled = { status: 429, body: { error: 'Too many tries. Wait a few minutes.' } };

test('P-14 normalized recipient quota is independent of source and account existence', async () => {
  account('15550000100');
  account('15550000102', false);
  const baseline = tokenCount();
  for (let i = 0; i < 4; i++) {
    const expected = i < 3 ? accepted : throttled;
    assert.deepEqual(await request(i % 2 ? '+1 (555) 000-0100' : '15550000100', `198.51.100.${i + 1}`), expected);
    assert.deepEqual(await request('15550000101', `198.51.100.${i + 10}`), expected);
    assert.deepEqual(await request('15550000102', `198.51.100.${i + 20}`), expected);
  }
  assert.equal(deliveries.length, 3);
  assert.equal(tokenCount() - baseline, 3);
  assert.equal(backend.mock.callCount(), 0);
});

test('P-14 source quota spans recipients and ignores untrusted entries before the client hop', async () => {
  account('15550000200');
  const baseline = tokenCount();
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(await request(`155500002${String(i + 1).padStart(2, '0')}`, `203.0.113.${i + 1}, 198.51.100.50`), accepted);
  }
  assert.deepEqual(await request('15550000200', '203.0.113.20, 198.51.100.50'), throttled);
  assert.deepEqual(await request('15550000299', '203.0.113.21, 198.51.100.50'), throttled);
  assert.equal(deliveries.length, 0);
  assert.equal(tokenCount(), baseline);
  assert.deepEqual(await request('15550000200', '198.51.100.51'), accepted);
  assert.deepEqual(deliveries, ['15550000200']);
});

test('P-14 concurrent requests reserve quota before asynchronous delivery', async () => {
  account('15550000300');
  const baseline = tokenCount();
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => request('15550000300', `198.51.100.${i + 60}`)));
  assert.equal(responses.filter((r) => r.status === 200).length, 3);
  assert.equal(responses.filter((r) => r.status === 429).length, 5);
  assert.equal(deliveries.length, 3);
  assert.equal(tokenCount() - baseline, 3);
});

test('P-14 both quotas recover after expiry without extending blocked recipient windows', async () => {
  account('15550000400');
  for (let i = 0; i < 3; i++) assert.deepEqual(await request('15550000400', '198.51.100.80'), accepted);
  now += TEXT_SIGNIN_WINDOW_MS - 1;
  assert.deepEqual(await request('15550000400', '198.51.100.80'), throttled);
  now++;
  assert.deepEqual(await request('15550000400', '198.51.100.80'), accepted);
  assert.equal(deliveries.length, 4);
});

test('P-14 absent socket metadata shares a source quota regardless of headers', async () => {
  for (let i = 0; i < 11; i++) {
    const response = await app.request('/api/auth/text/request', {
      method: 'POST', body: JSON.stringify({ phone: `155500005${String(i).padStart(2, '0')}` }),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${i + 90}`, 'fly-client-ip': `203.0.113.${i + 90}` },
    });
    assert.deepEqual({ status: response.status, body: await response.json() }, i < 10 ? accepted : throttled);
  }
});

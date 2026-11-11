import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { Hono } from 'hono';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-platform-voice-'));
const requests: { path: string; key: string; body: string }[] = [];
let failure: 'reject' | 'malformed' | 'expired' | 'echo' | 'offline' | null = null;
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  requests.push({ path: req.url!, key: req.headers.authorization ?? '', body });
  res.setHeader('content-type', 'application/json');
  if (failure === 'reject' || failure === 'offline') {
    res.statusCode = failure === 'reject' ? 401 : 503;
    return res.end(JSON.stringify({ error: `sensitive upstream echo ${req.headers.authorization}` }));
  }
  if (req.url === '/xai/realtime/client_secrets') {
    return res.end(JSON.stringify(failure === 'malformed' ? { value: '' } : {
      value: failure === 'echo' ? req.headers.authorization?.slice(7) : 'ephemeral-test-credential',
      expires_at: Math.floor(Date.now() / 1000) + (failure === 'expired' ? -5 : 300),
    }));
  }
  if (req.url === '/xai/stt') return res.end(JSON.stringify({ text: 'Ask the main agent to prepare my agenda.' }));
  if (req.url === '/xai/tts') {
    if (typeof JSON.parse(body).language !== 'string') {
      res.statusCode = 422;
      return res.end(JSON.stringify({ error: 'missing field language' }));
    }
    res.setHeader('content-type', 'audio/mpeg');
    return res.end(Buffer.alloc(256, 1));
  }
  res.statusCode = 500;
  res.end('{}');
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const address = upstream.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
Object.assign(process.env, {
  DB_PATH: path.join(tmp, 'test.db'), FILES_DIR: path.join(tmp, 'files'), SESSION_SECRET: 'platform-voice-test-only',
  APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0',
  ADMIN_EMAILS: 'admin@example.com', ADMIN_PHONES: '', XAI_API_KEY: '', XAI_BASE_URL: `${base}/xai`,
  DIRECT_API_KEY: '', DIRECT_BASE_URL: `${base}/direct`, OPENROUTER_API_KEY: 'text-key-only',
  OPENROUTER_BASE_URL: `${base}/openrouter`, LLM_PROVIDER: 'openrouter',
});
const { db } = await import('../server/src/db.js');
const { configApi } = await import('../server/src/routes-config.js');
const { voiceApi } = await import('../server/src/voice.js');
const { requireUser } = await import('../server/src/lib/auth.js');
const { createBot } = await import('../server/src/bots.js');
const { env, setEnvOverride } = await import('../server/src/env.js');
const { clearSetting, loadSettings } = await import('../server/src/settings.js');
const { withUsage } = await import('../server/src/usage-context.js');
const { speechStatus, transcribe, synthesize } = await import('../server/src/lib/speech.js');
const { llmProvider } = await import('../server/src/lib/llm.js');
const { saveOpenRouterKey } = await import('../server/src/providers/openrouter.js');
const { selectCli } = await import('../server/src/cli/store.js');

const authenticated = new Hono();
authenticated.use('*', requireUser);
authenticated.route('/voice', voiceApi);
const app = new Hono().route('/api', configApi).route('/api', authenticated);
function account(id: string) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.com`, id, Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3600_000);
  return createBot(id, { name: `${id} main agent`, isPrimary: true });
}
account('admin');
db.prepare("INSERT INTO account_roles VALUES(?,'admin')").run('admin');
const alice = account('alice'), bob = account('bob');
function request(user: string | null, endpoint: string, method = 'GET', body?: unknown) {
  return app.request(`/api${endpoint}`, {
    method, headers: { ...(user ? { cookie: `swarm_session=${user}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const key = 'test-platform-voice-secret';
const save = () => request('admin', '/settings/keys/voice', 'PUT', { value: key });
beforeEach(() => {
  clearSetting('voice'); delete process.env.XAI_API_KEY;
  db.exec('DELETE FROM cli_preferences; DELETE FROM provider_connections; DELETE FROM usage_events;');
  failure = null; requests.length = 0;
});
after(async () => {
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  db.close(); fs.rmSync(tmp, { recursive: true, force: true });
});

test('only admins can save/remove voice credentials; validation failures never overwrite a working key', async () => {
  assert.equal((await request(null, '/settings/keys/voice', 'PUT', { value: key })).status, 401);
  assert.equal((await request('alice', '/settings/keys/voice', 'PUT', { value: key })).status, 403);
  assert.equal((await request('bob', '/settings/keys/voice', 'DELETE')).status, 403);
  assert.equal(requests.length, 0);
  assert.equal((await save()).status, 200);
  assert.deepEqual(JSON.parse(requests[0].body), { expires_after: { seconds: 300 } });
  const stored = db.prepare("SELECT value,updated_by FROM server_settings WHERE key='voice'").get() as any;
  assert.ok(stored.value.startsWith('v1:')); assert.ok(!stored.value.includes(key)); assert.equal(stored.updated_by, 'admin');
  setEnvOverride('XAI_API_KEY', null); assert.equal(env.voiceKey, '');
  loadSettings(); assert.equal(env.voiceKey, key);
  for (const user of ['admin', 'alice']) {
    const status = await (await request(user, '/settings/keys')).json();
    assert.deepEqual(status.voice, { set: true, source: 'app', hint: null });
    assert.ok(!JSON.stringify(status).includes(key));
  }
  failure = 'reject';
  const rejected = await request('admin', '/settings/keys/voice', 'PUT', { value: 'bad-secret' });
  assert.equal(rejected.status, 400); assert.ok(!(await rejected.text()).includes('bad-secret')); assert.equal(env.voiceKey, key);
  assert.equal((await request('admin', '/settings/keys/voice', 'DELETE')).status, 200);
  assert.equal(env.voiceKey, '');
});

test('existing and newly created accounts inherit voice, with only an ephemeral credential exposed', async () => {
  assert.equal((await save()).status, 200);
  const newcomer = account('newcomer');
  for (const [user, bot] of [['alice', alice], ['newcomer', newcomer]] as const) {
    const response = await request(user, '/voice/session', 'POST', { botId: bot.id });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.clientSecret, 'ephemeral-test-credential');
    assert.equal(body.clientSecretProtocol, 'xai-client-secret');
    assert.equal(body.websocketUrl, `${base.replace('http', 'ws')}/xai/realtime`);
    assert.ok(!JSON.stringify(body).includes(key));
    assert.ok(body.instructions.includes(bot.name));
    assert.equal((await request(user, '/voice/end', 'POST', { botId: bot.id, callId: body.callId })).status, 200);
    const usage = db.prepare("SELECT user_id,bot_id,provider FROM usage_events WHERE kind='voice' AND user_id=?").get(user);
    assert.deepEqual(usage, { user_id: user, bot_id: bot.id, provider: 'xai' });
  }
  assert.ok(requests.every(r => r.key === `Bearer ${key}` && r.path.startsWith('/xai/')));
});

test('voice credentials never allow another account’s bot or calls to be accessed', async () => {
  await save(); requests.length = 0;
  assert.equal((await request(null, '/voice/session', 'POST', { botId: alice.id })).status, 401);
  for (const endpoint of ['session', 'tool', 'end']) {
    assert.equal((await request('bob', `/voice/${endpoint}`, 'POST', { botId: alice.id, name: 'peek_activity', callId: 'foreign' })).status, 404);
  }
  assert.equal(requests.length, 0);
});

test('CLI subscriptions and personal OpenRouter keep their text routing while using platform voice', async () => {
  await save();
  for (const mode of ['codex', 'claude', 'openrouter'] as const) {
    selectCli('alice', mode === 'openrouter' ? null : mode);
    if (mode === 'openrouter') saveOpenRouterKey('alice', 'personal-text-secret', 'manual');
    const selected = withUsage({ userId: 'alice' }, () => llmProvider());
    assert.equal(selected, mode === 'openrouter' ? 'openrouter' : `${mode}-cli`);
    const session = await request('alice', '/voice/session', 'POST', { botId: alice.id });
    assert.equal(session.status, 200);
    const body = await session.json();
    assert.equal((await request('alice', '/voice/preview', 'POST', { botId: alice.id })).status, 200);
    const form = new FormData(); form.append('file', new Blob([Buffer.alloc(512)], { type: 'audio/webm' }), 'voice.webm');
    const stt = await app.request('/api/voice/stt', { method: 'POST', headers: { cookie: 'swarm_session=alice' }, body: form });
    assert.equal(stt.status, 200); assert.match((await stt.json()).text, /main agent/);
    await withUsage({ userId: 'alice' }, async () => {
      assert.equal(speechStatus().speech, 'xai');
      await synthesize('Hello', 'luna');
      assert.match(await transcribe({ data: Buffer.alloc(512), mime: 'audio/webm' }), /main agent/);
      assert.equal(llmProvider(), selected);
    });
    await request('alice', '/voice/end', 'POST', { botId: alice.id, callId: body.callId });
  }
  assert.ok(requests.every(r => r.key === `Bearer ${key}` && r.path.startsWith('/xai/')));
  assert.ok((db.prepare('SELECT DISTINCT user_id,provider FROM usage_events').all() as any[]).every(r => r.user_id === 'alice' && r.provider === 'xai'));
});

test('upstream failures and invalid credentials are sanitized, produce no call, and never fall back to text keys', async () => {
  await save(); selectCli('alice', 'codex');
  for (const mode of ['reject', 'offline', 'malformed', 'expired', 'echo'] as const) {
    failure = mode;
    const count = db.prepare('SELECT COUNT(*) AS n FROM rows').get() as any;
    const response = await request('alice', '/voice/session', 'POST', { botId: alice.id });
    assert.equal(response.status, 502);
    const text = await response.text(); assert.ok(!text.includes(key)); assert.ok(!text.includes('sensitive'));
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n FROM rows').get(), count);
  }
  assert.ok(requests.every(r => r.path.startsWith('/xai/')));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_events').get().n, 0);
});

test('missing and removed platform keys give an admin instruction; env keys survive removal of an app override', async () => {
  const missing = await request('alice', '/voice/session', 'POST', { botId: alice.id });
  assert.equal(missing.status, 503); assert.match((await missing.json()).error, /platform admin/);
  await save(); process.env.XAI_API_KEY = 'deployment-secret';
  const removed = await request('admin', '/settings/keys/voice', 'DELETE');
  assert.deepEqual((await removed.json()).voice, { set: true, source: 'env', hint: null });
  assert.equal(env.voiceKey, 'deployment-secret');
  delete process.env.XAI_API_KEY;
  selectCli('alice', 'codex'); requests.length = 0;
  assert.equal((await request('alice', '/voice/session', 'POST', { botId: alice.id })).status, 409);
  assert.equal(requests.length, 0);
});

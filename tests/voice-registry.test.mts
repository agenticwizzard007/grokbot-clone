import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
const tmp = mkdtempSync(join(tmpdir(), 'voice-lifetime-'));
Object.assign(process.env, { NODE_ENV: 'test', SWARM_ROLE: 'standalone', DB_PATH: join(tmp, 'db'), FILES_DIR: join(tmp, 'files'),
  SESSION_SECRET: 'fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', OPENROUTER_API_KEY: '', XAI_API_KEY: 'fixture', XAI_BASE_URL: 'https://voice.fixture' });
mock.method(globalThis, 'fetch', async (url: any) => {
  if (String(url).endsWith('/realtime/client_secrets')) return Response.json({ value: 'provider-secret', expires_at: 9999999999 });
  throw Error('No external requests');
});
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { createBot } = await import('../server/src/bots.js');
const { requireUser } = await import('../server/src/lib/auth.js');
const { voiceApi } = await import('../server/src/voice.js');
const { VoiceRegistry, CALL_IDLE_MS } = await import('../server/src/voice-registry.js');
const app = new Hono(); app.use('*', requireUser); app.route('/voice', voiceApi);
for (const id of ['alice', 'bob']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, id, Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3600000);
}
const bot = createBot('alice', { name: 'Voice fixture' });
const post = (route: string, body: any, user = 'alice') => app.request(`/voice/${route}`, { method: 'POST', headers: { cookie: `swarm_session=${user}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
after(() => { mock.restoreAll(); db.close(); rmSync(tmp, { recursive: true, force: true }); });

test('session publishes the registered app ID before polling and rejects provider IDs or foreign owners', async () => {
  const response = await post('session', { botId: bot.id }); assert.equal(response.status, 200);
  const { callId } = await response.json();
  assert.ok(new VoiceRegistry().has(callId));
  for (let i = 0; i < 6; i++) assert.equal((await post('updates', { botId: bot.id, callId, after: 0 })).status, 200);
  assert.equal((await post('updates', { botId: bot.id, callId: 'provider-session-id', after: 0 })).status, 404);
  assert.equal((await post('updates', { botId: bot.id, callId, after: 0 }, 'bob')).status, 404);
});

test('restart restores the same call, cursor, maps, transcripts and completed tool results without provider credentials', async () => {
  const { callId } = await (await post('session', { botId: bot.id })).json();
  const registry = new VoiceRegistry(), call = registry.get(callId)!;
  call.cursor = 12; call.transcript = [{ role: 'user', text: 'Keep this context' }];
  call.seenRows.set('row-1', 'Already delivered'); call.connectionBaseline.set(bot.id, { generation: 1, seq: 1 });
  const output = { output: 'Action completed once' };
  call.toolCalls.set('provider-tool-id', { signature: 'action', result: Promise.resolve(output), output });
  call.toolCalls.set('pending-tool-id', { signature: 'pending', result: new Promise(() => {}) });
  registry.save(call);
  const restored = new VoiceRegistry().get(callId)!;
  assert.equal(restored.id, callId); assert.equal(restored.cursor, 12); assert.deepEqual(restored.transcript, call.transcript);
  assert.equal(restored.seenRows.get('row-1'), 'Already delivered');
  assert.deepEqual(restored.connectionBaseline.get(bot.id), { generation: 1, seq: 1 });
  assert.deepEqual(await restored.toolCalls.get('provider-tool-id')!.result, output);
  assert.match((await restored.toolCalls.get('pending-tool-id')!.result).output, /uncertain.*do not automatically repeat/);
  assert.doesNotMatch((db.prepare('SELECT state FROM voice_calls WHERE id=?').get(callId) as any).state, /provider-secret/);
  registry.delete(callId); registry.save(call);
  assert.equal(new VoiceRegistry().has(callId), false, 'late work cannot resurrect ended calls');
});

test('a healthy call remains registered beyond two hours while an idle call expires', async () => {
  const { callId } = await (await post('session', { botId: bot.id })).json();
  const registry = new VoiceRegistry(), call = registry.get(callId)!;
  call.startedAt = Date.now() - CALL_IDLE_MS * 3; call.lastActiveAt = Date.now(); registry.save(call);
  assert.equal(registry.expired(Date.now()).includes(call), false);
  call.lastActiveAt -= CALL_IDLE_MS + 1;
  assert.equal(registry.expired(Date.now()).includes(call), true);
});

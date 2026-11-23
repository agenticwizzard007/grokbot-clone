import { mock } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

// All toolkit and model traffic is handled in process using fake data.
mock.method(globalThis, 'fetch', async (input: any) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  if (url.hostname === 'backend.composio.dev') return Response.json({ items: [{ slug: 'github', name: 'GitHub', meta: { description: 'Review supplied repository notes', categories: [] } }] });
  if (url.hostname === 'openrouter.ai') return Response.json({ data: [] });
  throw new Error('Unexpected fixture network request');
});
const { db } = await import('../../server/src/db.js');
(await import('../../server/src/agent/subagents.js')).initSubagents();
(await import('../../server/src/agent/rooms.js')).initRooms();
const { createBot } = await import('../../server/src/bots.js');
const { appendRow, appendHistory, setLive } = await import('../../server/src/store.js');
const { composio } = await import('../../server/src/composio.js');
const { llmClient } = await import('../../server/src/lib/llm.js');
const { api } = await import('../../server/src/routes.js');
mock.method(composio().connectedAccounts, 'list', async () => ({ items: [], nextCursor: null }));
mock.method(llmClient(30_000).responses, 'create', async () => ({ output_text: JSON.stringify({ suggestions: [] }), usage: { input_tokens: 10, output_tokens: 10, cost_in_usd_ticks: 0 } }));
const attempts = new Map<string, number>();
mock.method(llmClient(360_000).responses, 'create', async (body: any) => {
  const key = body.prompt_cache_key ?? 'fixture-chat';
  const attempt = attempts.get(key) ?? 0;
  attempts.set(key, attempt + 1);
  const text = attempt === 0 ? "I'm still being set up. Tap Skip setup to start working now, or answer: Which workflow?" : 'Hi there, ready to help.';
  return (async function* () {
    const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
    for (const delta of text.match(/.{1,12}/gs) ?? []) yield { type: 'response.output_text.delta', delta };
    yield { type: 'response.output_item.done', item };
    yield { type: 'response.completed', response: { output: [item] } };
  })();
});
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run('owner', 'owner@example.test', 'Test account', Date.now());
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run('active-setup-token', 'owner', Date.now(), Date.now() + 600_000);
const bot = createBot('owner', { name: 'Active Bot', description: 'Review supplied repository notes.' });
const text = "I'm still being set up. Tap Skip setup to start working now.";
appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text });
appendHistory(bot.id, [{ role: 'assistant', content: text }]);
const question = appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'Which setup workflow?', options: [], status: 'pending' });
db.prepare('UPDATE rows SET created_at=? WHERE bot_id=? AND seq=?').run(Date.now() - 2000, bot.id, question.seq);
db.prepare("UPDATE bot_setups SET onboarding_status='active', revision=32, confirmed_at=? WHERE bot_id=?").run(Date.now() - 1000, bot.id);
setLive(bot.id, { awaiting: { reason: 'Setup question', since: Date.now() - 2000 }, activity: { kind: 'waiting_for_you', since: Date.now() - 2000 } });
for (const width of [1280, 390]) for (const stage of ['interviewing', 'review']) {
  const configuring = createBot('owner', { name: `${stage} Bot ${width}`, description: 'Respond to requests in this chat.' });
  db.prepare('UPDATE bot_setups SET onboarding_status=? WHERE bot_id=?').run(stage, configuring.id);
  appendRow(configuring.id, 'message', { type: 'message', role: 'assistant', text });
  appendHistory(configuring.id, [{ role: 'assistant', content: text }]);
}
serve({ fetch: new Hono().route('/api', api).fetch, port: Number(process.env.PORT), hostname: '127.0.0.1' });

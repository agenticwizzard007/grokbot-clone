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
const { appendRow, appendHistory } = await import('../../server/src/store.js');
const { composio } = await import('../../server/src/composio.js');
const { llmClient } = await import('../../server/src/lib/llm.js');
const { api } = await import('../../server/src/routes.js');
mock.method(composio().connectedAccounts, 'list', async () => ({ items: [], nextCursor: null }));
mock.method(llmClient(30_000).responses, 'create', async () => ({ output_text: JSON.stringify({ suggestions: [] }), usage: { input_tokens: 10, output_tokens: 10, cost_in_usd_ticks: 0 } }));
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run('owner', 'owner@example.test', 'Test account', Date.now());
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run('active-setup-token', 'owner', Date.now(), Date.now() + 600_000);
const bot = createBot('owner', { name: 'Active Bot', description: 'Review supplied repository notes.' });
const text = "I'm still being set up. Tap Skip setup to start working now.";
appendRow(bot.id, 'message', { type: 'message', role: 'assistant', text });
appendHistory(bot.id, [{ role: 'assistant', content: text }]);
const question = appendRow(bot.id, 'card', { type: 'card', card: 'question', question: 'Which setup workflow?', options: [], status: 'pending' });
db.prepare('UPDATE rows SET created_at=? WHERE bot_id=? AND seq=?').run(Date.now() - 2000, bot.id, question.seq);
db.prepare("UPDATE bot_setups SET onboarding_status='active', revision=32, confirmed_at=? WHERE bot_id=?").run(Date.now() - 1000, bot.id);
serve({ fetch: new Hono().route('/api', api).fetch, port: Number(process.env.PORT), hostname: '127.0.0.1' });

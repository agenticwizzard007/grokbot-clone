// Synthetic local data and intercepted providers only. Never mounted by the app.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { mock } from 'node:test';
await import('./voice-chat-backends.mjs');
await import('../../server/src/db-config.js');
const { initSubagents } = await import('../../server/src/agent/subagents.js');
const { initRooms } = await import('../../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { db } = await import('../../server/src/db.js');
const { appendRow } = await import('../../server/src/store.js');
const { composio } = await import('../../server/src/composio.js');
const connected = new Set<string>();
mock.method(composio().connectedAccounts, 'list', async (query: any) => ({ items: connected.has(query.userIds[0]) ? [{ id: 'fixture-slack', toolkit: { slug: 'slack' }, status: 'ACTIVE' }] : [], nextCursor: null }));
const { api } = await import('../../server/src/routes.js');
const { cliApi } = await import('../../server/src/cli/routes.js');
const app = new Hono();
app.get('/api/health', c => c.json({ ok: true }));
app.post('/__fixture/connect/:bot', c => {
  const bot = db.prepare('SELECT user_id FROM bots WHERE id=?').get(c.req.param('bot')) as any;
  connected.add(bot.user_id); return c.json({ ok: true });
});
app.post('/__fixture/legacy/:bot', c => {
  const botId = c.req.param('bot'), callId = `old-${botId}`, approvalId = `approval-${botId}`;
  appendRow(botId, 'event', { type: 'event', event: 'voice-call', text: 'Voice call started', call: { id: callId, phase: 'started' } });
  const card = appendRow(botId, 'card', { type: 'card', card: 'approval', approvalId, title: 'Allow a Gmail draft?', detail: 'Review the draft', tool: 'SWARM_APPS_EXECUTE', args: { tool_slug: 'GMAIL_CREATE_EMAIL_DRAFT', arguments: { subject: 'Voice R7' } }, status: 'denied' });
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,?,?,?,?,?)').run(approvalId, botId, card.seq, 'tool-call-fixture', 'SWARM_APPS_EXECUTE', 'denied', Date.now());
  const pill = (id: string, subject: string) => appendRow(botId, 'event', { type: 'event', event: 'voice-call', text: `Voice call ended · 41s. 1 approval from this call is still pending in chat: Gmail draft with subject "${subject}"`, call: { id, phase: 'ended', durationMs: 41000, summary: `Still pending: "${subject}"`, transcript: [{ role: 'assistant', text: 'Still pending' }] } });
  return c.json({ linked: pill(callId, 'Voice R7').seq, unlinked: pill('missing-call', 'Unverified subject').seq });
});
app.route('/api/cli', cliApi); app.route('/api', api);
serve({ fetch: app.fetch, port: Number(process.env.PORT), hostname: '127.0.0.1' });

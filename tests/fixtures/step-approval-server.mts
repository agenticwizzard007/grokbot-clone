// Local synthetic approvals with no pending turn, so no Bot reply can mask a stale step.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
await import('./voice-chat-backends.mjs');
await import('../../server/src/db-config.js');
const { initSubagents } = await import('../../server/src/agent/subagents.js');
const { initRooms } = await import('../../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { db } = await import('../../server/src/db.js');
const { appendRow, updateRow, getRow, getBotRow } = await import('../../server/src/store.js');
const { hub } = await import('../../server/src/lib/hub.js');
const { api } = await import('../../server/src/routes.js');
const app = new Hono();
app.get('/api/health', c => c.json({ ok: true }));
app.post('/api/__fixture/approval/:bot', async c => {
  const botId = c.req.param('bot'), { voice = false } = await c.req.json();
  const approvalId = `approval-${botId}`, callId = `draft-${botId}`;
  appendRow(botId, 'message', { type: 'message', role: 'user', text: 'Prepare a Gmail draft for review.', ...(voice ? { from: { kind: 'voice', id: 'fixture-call', name: 'Voice call' } as const } : {}) });
  const step = appendRow(botId, 'tool-call', { type: 'tool-call', callId, name: 'SWARM_APPS_EXECUTE', label: 'Gmail: Create email draft', args: { tool_slug: 'GMAIL_CREATE_EMAIL_DRAFT' }, status: 'awaiting-approval' });
  const card = appendRow(botId, 'card', { type: 'card', card: 'approval', approvalId, title: 'Allow a Gmail draft?', detail: '', tool: 'SWARM_APPS_EXECUTE', toolkit: 'gmail', toolkitName: 'Gmail', args: { tool_slug: 'GMAIL_CREATE_EMAIL_DRAFT', arguments: { recipient_email: 'review@example.test', subject: 'Draft review', body: 'Please review this local fixture.' } }, status: 'pending' });
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES(?,?,?,?,?,?,?)').run(approvalId, botId, card.seq, callId, 'SWARM_APPS_EXECUTE', 'pending', Date.now());
  if (voice) appendRow(botId, 'event', { type: 'event', event: 'voice-call', text: 'Voice call ended', call: { id: 'fixture-call', phase: 'ended', baseText: 'Voice call ended', approvals: [{ approvalId, botId, generation: card.generation, rowSeq: card.seq, botName: 'Draft fixture', detail: 'Gmail draft for review' }] } });
  return c.json({ approvalId, stepSeq: step.seq, cardSeq: card.seq });
});
app.post('/api/__fixture/expire/:bot/:seq', c => {
  const botId = c.req.param('bot'), seq = Number(c.req.param('seq')), row = getRow(botId, seq)!;
  if (row.body.type !== 'card' || row.body.card !== 'approval') throw Error('Expected approval');
  db.prepare("UPDATE approvals SET status='expired' WHERE id=?").run(row.body.approvalId);
  updateRow(botId, seq, { ...row.body, status: 'expired' });
  return c.json({ ok: true });
});
app.post('/api/__fixture/stale/:bot/:seq', c => {
  const botId = c.req.param('bot'), seq = Number(c.req.param('seq')), row = getRow(botId, seq)!;
  if (row.body.type !== 'tool-call') throw Error('Expected step');
  // Send an old-style execution body with a newer event revision and no approval metadata.
  hub.emit(getBotRow(botId).user_id, { type: 'rows', botId, generation: row.generation, rows: [{ ...row, updatedSeq: row.updatedSeq + 1000, body: { ...row.body, status: 'awaiting-approval', approval: undefined } }] });
  return c.json({ ok: true });
});
app.route('/api', api);
serve({ fetch: app.fetch, port: Number(process.env.PORT), hostname: '127.0.0.1' });

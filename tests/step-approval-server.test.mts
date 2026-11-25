import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'step-approvals-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'local-fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', INKBOX_TUNNEL: '0' });
mock.method(globalThis, 'fetch', async () => { throw Error('Network disabled'); });
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const { createBot } = await import('../server/src/bots.js');
const { appendRow, updateRow, getRow, listRows } = await import('../server/src/store.js');
const { resolveApproval, settleAgentJobs } = await import('../server/src/agent/loop.js');
const { hub } = await import('../server/src/lib/hub.js');
const { api } = await import('../server/src/routes.js');
const { Hono } = await import('hono');
const app = new Hono().route('/api', api);
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'fixture@example.test', 'Fixture', Date.now());
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run('fixture-session', 'owner', Date.now(), Date.now() + 600000);
after(async () => { await settleAgentJobs(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const bot = createBot('owner', { name: 'Draft fixture' });
  const id = `approval-${bot.id}`;
  const step = appendRow(bot.id, 'tool-call', { type: 'tool-call', callId: 'same-call-id', name: 'SWARM_APPS_EXECUTE', label: 'Gmail: Create email draft', status: 'awaiting-approval' });
  const card = appendRow(bot.id, 'card', { type: 'card', card: 'approval', approvalId: id, title: 'Allow a draft?', detail: '', tool: 'SWARM_APPS_EXECUTE', args: {}, status: 'pending' });
  db.prepare('INSERT INTO approvals(id,bot_id,row_seq,call_id,tool,status,created_at) VALUES (?,?,?,?,?,?,?)').run(id, bot.id, card.seq, 'same-call-id', 'SWARM_APPS_EXECUTE', 'pending', Date.now());
  return { bot, id, step, card };
}
for (const [decision, status] of [['deny', 'denied'], ['allow', 'allowed'], ['always', 'always']] as const) {
  test(`R10-1: ${decision} publishes the exact step decision to both clients before resume and persists through stale writes`, async () => {
    const a = fixture(), other = fixture(), clients: any[][] = [[], []];
    const unsub = clients.map(events => hub.subscribe('owner', event => events.push(event)));
    try {
      const response = await app.request(`/api/approvals/${a.id}`, { method: 'POST', headers: { cookie: 'swarm_session=fixture-session', 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, status });
      for (const events of clients) {
        const rowEvents = events.filter(e => e.type === 'rows' && e.botId === a.bot.id).flatMap(e => e.rows);
        assert.ok(rowEvents.some(r => r.seq === a.step.seq && r.body.approval?.status === status));
        assert.ok(rowEvents.some(r => r.seq === a.card.seq && r.body.status === status));
        assert.ok(!rowEvents.some(r => r.body.role === 'assistant'), 'decision does not depend on a reply');
      }
      updateRow(a.bot.id, a.step.seq, a.step.body);
      assert.deepEqual((getRow(a.bot.id, a.step.seq)!.body as any).approval, { id: a.id, status });
      assert.equal((getRow(other.bot.id, other.step.seq)!.body as any).approval.status, 'pending');
      assert.equal(resolveApproval('owner', a.id, 'deny'), status, 'first durable decision wins');
    } finally { unsub.forEach(fn => fn()); }
  });
}

test('R10-1: legacy waiting rows hydrate expired decisions without rewriting history or matching another generation', () => {
  const a = fixture();
  db.prepare("UPDATE approvals SET status='expired' WHERE id=?").run(a.id);
  updateRow(a.bot.id, a.card.seq, { ...a.card.body, status: 'expired' } as any);
  db.prepare('UPDATE rows SET body=? WHERE bot_id=? AND seq=?').run(JSON.stringify(a.step.body), a.bot.id, a.step.seq);
  const before = db.prepare('SELECT body,updated_seq FROM rows WHERE bot_id=? AND seq=?').get(a.bot.id, a.step.seq);
  assert.equal((listRows(a.bot.id).find(r => r.seq === a.step.seq)!.body as any).approval.status, 'expired');
  assert.deepEqual(db.prepare('SELECT body,updated_seq FROM rows WHERE bot_id=? AND seq=?').get(a.bot.id, a.step.seq), before);
  assert.equal(resolveApproval('owner', a.id, 'allow'), 'expired', 'a late click confirms expiry without allowing the action');
  db.prepare('UPDATE rows SET generation=0 WHERE bot_id=? AND seq=?').run(a.bot.id, a.card.seq);
  // Remove the new field to exercise an actual legacy row with a same-call record in another generation.
  db.prepare('UPDATE rows SET body=? WHERE bot_id=? AND seq=?').run(JSON.stringify(a.step.body), a.bot.id, a.step.seq);
  assert.equal((getRow(a.bot.id, a.step.seq)!.body as any).approval, undefined);
});

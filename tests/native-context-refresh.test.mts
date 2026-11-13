import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { after, mock, test } from 'node:test';

const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-context-refresh-'));
Object.assign(process.env, {
  SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', NODE_ENV: 'test',
  DB_PATH: path.join(storage, 'test.db'), FILES_DIR: path.join(storage, 'files'),
  SESSION_SECRET: 'context-refresh-test', COMPUTER_PROVIDER: 'local',
  DIRECT_API_KEY: 'fixture', DIRECT_BASE_URL: 'http://127.0.0.1:9/v1',
  LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', INKBOX_TUNNEL: '0',
});
mock.method(globalThis, 'fetch', async () => { throw new Error('No network in context-refresh tests'); });
const { db } = await import('../server/src/db.js');
(await import('../server/src/agent/subagents.js')).initSubagents();
(await import('../server/src/agent/rooms.js')).initRooms();
const { createBot } = await import('../server/src/bots.js');
const { appendRow } = await import('../server/src/store.js');
const { contextRevision } = await import('../server/src/agent/context-refresh.js');
const memory = await import('../server/src/knowledge/memory.js');
const skills = await import('../server/src/knowledge/skills.js');
const { enqueue, settleAgentJobs } = await import('../server/src/agent/loop.js');
const { nativeToolHandler } = await import('../server/src/cli/native-tools.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { withUsage } = await import('../server/src/usage.js');
const { closeMcpSessions } = await import('../server/src/mcp/client.js');

let sequence = 0;
let model: (body: any) => Promise<any[]> = async () => { throw new Error('Unexpected model generation'); };
const client = withUsage({ userId: 'fixture' }, () => llmClient(360000));
mock.method(client.responses, 'create', async (body: any) => {
  const output = await model(body);
  return (async function* () {
    for (const item of output) {
      yield { type: 'response.output_item.added', item };
      if (item.type === 'message') yield { type: 'response.output_text.delta', delta: item.content[0].text };
      yield { type: 'response.output_item.done', item };
    }
    yield { type: 'response.completed', response: { output, usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 } } };
  })();
});
after(async () => {
  await settleAgentJobs();
  await closeMcpSessions();
  mock.restoreAll();
  db.close();
  fs.rmSync(storage, { recursive: true, force: true });
});

function fixture(label: string) {
  const userId = 'refresh-' + label;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)')
    .run(userId, userId + '@example.test', label, Date.now());
  const receiver = createBot(userId, { name: 'Quinn', isPrimary: true });
  const source = createBot(userId, { name: 'Source' });
  const excluded = createBot(userId, { name: 'Excluded' });
  db.prepare("UPDATE bot_setups SET onboarding_status='active' WHERE bot_id IN (?,?)").run(source.id, excluded.id);
  return { userId, receiver, source, excluded, stamp: () => contextRevision(userId, receiver.id) };
}
function fact(f: ReturnType<typeof fixture>, botId: string, text: string) {
  const row = appendRow(botId, 'message', { type: 'message', role: 'user', text });
  const generation = (db.prepare('SELECT generation FROM bots WHERE id=?').get(botId) as any).generation;
  const saved = memory.saveMemory(f.userId, botId, { text, evidence: [{ botId, generation, seq: row.seq }] }).memory;
  assert.ok(saved);
  return saved;
}
function skill(f: ReturnType<typeof fixture>, botId: string) {
  return skills.createSkill(f.userId, botId, { name: 'Fixture procedure ' + (++sequence), description: 'Approved fixture instructions', body: 'Use the approved fixture procedure.' });
}

test('private sibling knowledge does not invalidate a generation; private own revisions do', () => {
  const f = fixture('private');
  const initial = f.stamp();
  const privateFact = fact(f, f.source.id, 'The sibling prefers heliotrope reports.');
  const privateSkill = skill(f, f.source.id);
  assert.equal(f.stamp(), initial);
  skills.updateSkill(f.userId, privateSkill.id, { body: 'A revised private procedure.' }, privateSkill.revision);
  memory.correctMemory(f.userId, privateFact.id, { text: 'The sibling prefers saffron reports.', expectedRevision: privateFact.revision });
  assert.equal(f.stamp(), initial, 'Unshared sibling edits must remain outside the stamp');
  const ownFact = fact(f, f.receiver.id, 'The receiver prefers concise operational summaries.');
  const ownFactStamp = f.stamp();
  assert.notEqual(ownFactStamp, initial);
  memory.correctMemory(f.userId, ownFact.id, { text: 'The receiver prefers detailed operational summaries.', expectedRevision: ownFact.revision });
  assert.notEqual(f.stamp(), ownFactStamp);
  const ownSkill = skill(f, f.receiver.id), ownSkillStamp = f.stamp();
  skills.updateSkill(f.userId, ownSkill.id, { body: 'Revised receiver instructions.' }, ownSkill.revision);
  assert.notEqual(f.stamp(), ownSkillStamp);
});

test('account publication and edits invalidate only the owning account authorized stamp', () => {
  const f = fixture('account');
  const m = fact(f, f.source.id, 'Account reporting uses the approved nebula ledger.');
  const s = skill(f, f.source.id);
  let before = f.stamp();
  const published = memory.setMemoryScope(f.userId, m.id, { expectedRevision: m.revision, scope: 'account' });
  assert.notEqual(f.stamp(), before);
  before = f.stamp();
  memory.correctMemory(f.userId, m.id, { text: 'Account reporting uses the approved aurora ledger.', expectedRevision: published.revision });
  assert.notEqual(f.stamp(), before);
  before = f.stamp();
  const sharedSkill = skills.setSkillScope(f.userId, s.id, { expectedRevision: s.revision, scope: 'account' });
  assert.notEqual(f.stamp(), before);
  before = f.stamp();
  skills.updateSkill(f.userId, s.id, { body: 'The current approved account procedure.' }, sharedSkill.revision);
  assert.notEqual(f.stamp(), before);
});

test('project grants enter the stamp only for explicit recipients and revocation invalidates it', () => {
  const f = fixture('project');
  const m = fact(f, f.source.id, 'Project reporting uses the approved cobalt ledger.');
  const s = skill(f, f.source.id);
  const initial = f.stamp();
  let sharedMemory = memory.setMemoryScope(f.userId, m.id, { expectedRevision: m.revision, scope: 'project', projectId: 'cobalt', botIds: [f.excluded.id] });
  let sharedSkill = skills.setSkillScope(f.userId, s.id, { expectedRevision: s.revision, scope: 'project', projectId: 'cobalt', botIds: [f.excluded.id] });
  assert.equal(f.stamp(), initial, 'A project name alone must not grant access');
  sharedMemory = memory.setMemoryScope(f.userId, m.id, { expectedRevision: sharedMemory.revision, scope: 'project', projectId: 'cobalt', botIds: [f.receiver.id] });
  const withMemory = f.stamp();
  assert.notEqual(withMemory, initial);
  sharedSkill = skills.setSkillScope(f.userId, s.id, { expectedRevision: sharedSkill.revision, scope: 'project', projectId: 'cobalt', botIds: [f.receiver.id] });
  const withBoth = f.stamp();
  assert.notEqual(withBoth, withMemory);
  memory.setMemoryScope(f.userId, m.id, { expectedRevision: sharedMemory.revision, scope: 'project', projectId: 'cobalt', botIds: [f.excluded.id] });
  const withoutMemory = f.stamp();
  assert.notEqual(withoutMemory, withBoth);
  skills.setSkillScope(f.userId, s.id, { expectedRevision: sharedSkill.revision, scope: 'private' });
  assert.notEqual(f.stamp(), withoutMemory);
  assert.equal(f.stamp(), initial, 'Revoked sources leave no revision fingerprint behind');
});

test('deleted authorized sources invalidate the revision, including a shared memory and skill', () => {
  const f = fixture('deleted');
  const m = fact(f, f.source.id, 'Shared reporting uses the approved emerald ledger.');
  const s = skill(f, f.source.id);
  const published = memory.setMemoryScope(f.userId, m.id, { expectedRevision: m.revision, scope: 'account' });
  const publishedSkill = skills.setSkillScope(f.userId, s.id, { expectedRevision: s.revision, scope: 'account' });
  let before = f.stamp();
  memory.forgetMemory(f.userId, m.id, published.revision);
  assert.notEqual(f.stamp(), before);
  before = f.stamp();
  skills.deleteSkill(f.userId, s.id, publishedSkill.revision);
  assert.notEqual(f.stamp(), before);
});

test('foreign account publication, revision and revocation never enter the local stamp', () => {
  const local = fixture('local-isolation'), foreign = fixture('foreign-isolation');
  const initial = local.stamp();
  const m = fact(foreign, foreign.source.id, 'Foreign reporting uses the approved garnet ledger.');
  const s = skill(foreign, foreign.source.id);
  let sharedMemory = memory.setMemoryScope(foreign.userId, m.id, { expectedRevision: m.revision, scope: 'account' });
  let sharedSkill = skills.setSkillScope(foreign.userId, s.id, { expectedRevision: s.revision, scope: 'account' });
  assert.equal(local.stamp(), initial);
  sharedMemory = memory.correctMemory(foreign.userId, m.id, { text: 'Foreign reporting uses the approved ruby ledger.', expectedRevision: sharedMemory.revision });
  sharedSkill = skills.updateSkill(foreign.userId, s.id, { body: 'Foreign updated instructions.' }, sharedSkill.revision);
  db.prepare("UPDATE bots SET instructions='Foreign DB instructions',generation=generation+1 WHERE id=?").run(foreign.receiver.id);
  assert.equal(local.stamp(), initial);
  memory.setMemoryScope(foreign.userId, sharedMemory.id, { expectedRevision: sharedMemory.revision, scope: 'private' });
  skills.setSkillScope(foreign.userId, s.id, { expectedRevision: sharedSkill.revision, scope: 'private' });
  assert.equal(local.stamp(), initial);
  assert.throws(() => contextRevision(local.userId, foreign.receiver.id), /Not found/);
});

test('DB instruction, generation and setup revisions invalidate even without a filesystem watcher', () => {
  const f = fixture('db-instructions');
  let before = f.stamp();
  db.prepare("UPDATE bots SET instructions='Use the current DB instructions.' WHERE id=?").run(f.receiver.id);
  assert.notEqual(f.stamp(), before);
  before = f.stamp();
  db.prepare('UPDATE bot_setups SET revision=revision+1 WHERE bot_id=?').run(f.receiver.id);
  assert.notEqual(f.stamp(), before);
  before = f.stamp();
  db.prepare('UPDATE bots SET generation=generation+1 WHERE id=?').run(f.receiver.id);
  assert.notEqual(f.stamp(), before);
  before = f.stamp();
  db.prepare('UPDATE bots SET unread=1,updated_at=updated_at+1 WHERE id=?').run(f.receiver.id);
  assert.equal(f.stamp(), before, 'Presentation updates must not restart a generation');
});

test('the native loop rejects a stale action, reloads revoked context and executes only the fresh action', async () => {
  const f = fixture('native-restart');
  const secret = 'The approved dispatch code is MARIGOLD-7281.';
  const m = fact(f, f.source.id, secret);
  const shared = memory.setMemoryScope(f.userId, m.id, { expectedRevision: m.revision, scope: 'account' });
  let generations = 0;
  model = async body => {
    generations++;
    assert.ok(generations <= 2, 'Context refresh must settle after one restart');
    const handler = nativeToolHandler(f.userId);
    assert.ok(handler, 'Use the actual turn-bound native callback');
    assert.equal(nativeToolHandler('another-account'), undefined);
    const prompt = body.input[0].content as string;
    if (generations === 1) {
      assert.ok(prompt.includes(secret), 'First generation must load the authorized source');
      memory.setMemoryScope(f.userId, m.id, { expectedRevision: shared.revision, scope: 'private' });
      const rejected = await handler({ id: 'stale-profile', name: 'update_profile', arguments: { name: 'STALE ACTION EXECUTED' } });
      assert.equal(rejected.stop, true);
      assert.equal(rejected.isError, true);
      assert.match(String(rejected.output), /not executed.*Reload current context/);
      assert.equal((db.prepare('SELECT name FROM users WHERE id=?').get(f.userId) as any).name, 'native-restart');
      const again = await handler({ id: 'after-stale', name: 'update_profile', arguments: { name: 'SECOND STALE ACTION' } });
      assert.equal(again.stop, true);
      assert.equal((db.prepare("SELECT COUNT(*) n FROM rows WHERE bot_id=? AND kind='tool-call'").get(f.receiver.id) as any).n, 0);
      return [];
    }
    assert.ok(!prompt.includes(secret), 'Restarted generation must exclude the revoked source');
    const accepted = await handler({ id: 'fresh-profile', name: 'update_profile', arguments: { name: 'Fresh authorized action' } });
    assert.notEqual(accepted.isError, true, String(accepted.output));
    return [{ type: 'message', id: 'fresh-message', role: 'assistant', content: [{ type: 'output_text', text: 'Completed with current context.' }] }];
  };
  const jobId = enqueue(f.receiver.id, { type: 'user', text: 'Perform the authorized fixture action.' });
  await settleAgentJobs();
  assert.equal(generations, 2);
  assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(jobId) as any).state, 'completed');
  assert.equal((db.prepare('SELECT name FROM users WHERE id=?').get(f.userId) as any).name, 'Fresh authorized action');
  const calls = db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='tool-call'").all(f.receiver.id) as any[];
  assert.equal(calls.length, 1, 'Rejected callbacks must not be journaled as admitted actions');
  assert.equal(JSON.parse(calls[0].body).args.name, 'Fresh authorized action');
});

test('a DB instruction revision arriving during async schema validation fences dispatch and restarts the generation', async () => {
  const f = fixture('validation-race');
  const previousInstruction = 'VALIDATION-OLD: use the original approved fixture procedure.';
  const currentInstruction = 'VALIDATION-CURRENT: use the revised approved fixture procedure.';
  db.prepare('UPDATE bots SET instructions=? WHERE id=?').run(previousInstruction, f.receiver.id);
  let generations = 0, validationBoundary = false, changedDuringValidation = false;
  const originalEmit = Worker.prototype.emit;
  // The real validator is a disposable worker. Change the DB when its success
  // response arrives, after the early context fence and before its await resumes.
  const validationHook = mock.method(Worker.prototype, 'emit', function(this: Worker, event: string, ...args: any[]) {
    if (event === 'message' && args[0]?.ok === true && validationBoundary) {
      validationBoundary = false;
      changedDuringValidation = true;
      db.prepare('UPDATE bots SET instructions=? WHERE id=?').run(currentInstruction, f.receiver.id);
    }
    return originalEmit.call(this, event, ...args);
  });
  try {
    model = async body => {
      generations++;
      assert.ok(generations <= 2, 'The instruction revision must cause exactly one restart');
      const handler = nativeToolHandler(f.userId);
      assert.ok(handler);
      const prompt = body.input[0].content as string;
      if (generations === 1) {
        assert.ok(prompt.includes(previousInstruction));
        validationBoundary = true;
        const rejected = await handler({ id: 'validation-stale', name: 'update_profile', arguments: { name: 'VALIDATION STALE ACTION' } });
        assert.ok(changedDuringValidation, 'Mutation must happen inside the actual async validation boundary');
        assert.equal((db.prepare('SELECT name FROM users WHERE id=?').get(f.userId) as any).name, 'validation-race', 'A stale action must not execute after validation yields');
        assert.equal(rejected.stop, true);
        return [];
      }
      assert.ok(prompt.includes(currentInstruction), 'The next generation must reload DB instructions');
      assert.ok(!prompt.includes(previousInstruction));
      return [{ type: 'message', id: 'validation-refreshed-message', role: 'assistant', content: [{ type: 'output_text', text: 'Refreshed instructions loaded.' }] }];
    };
    const jobId = enqueue(f.receiver.id, { type: 'user', text: 'Perform the authorized fixture action.' });
    await settleAgentJobs();
    assert.ok(changedDuringValidation);
    assert.equal((db.prepare('SELECT name FROM users WHERE id=?').get(f.userId) as any).name, 'validation-race', 'Rejected stale dispatch must have no business side effect');
    assert.equal(generations, 2);
    assert.equal((db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(jobId) as any).state, 'completed');
    assert.equal((db.prepare('SELECT COUNT(*) n FROM tool_dispatches WHERE bot_id=?').get(f.receiver.id) as any).n, 0, 'The stale action must never reach the dispatch journal');
  } finally { validationHook.mock.restore(); }
});

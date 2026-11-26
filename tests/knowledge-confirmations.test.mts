import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-confirmations-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'fixture', SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', NODE_ENV: 'test', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0', DIRECT_API_KEY: 'fixture', LLM_PROVIDER: 'direct' });
mock.method(globalThis, 'fetch', async () => { throw Error('No external requests in confirmation fixtures'); });
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
const learning = await import('../server/src/agent/learning.js');
const skills = await import('../server/src/knowledge/skills.js');
const memory = await import('../server/src/knowledge/memory.js');
const { appendRow } = await import('../server/src/store.js');
const { toolMap } = await import('../server/src/agent/tools.js');
const { knowledgeMutation } = await import('../server/src/agent/knowledge-confirmations.js');
after(() => { learning.configureLearningModelExecutor(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
let serial = 0;
function fixture() {
  const userId = `owner-${++serial}`, botId = `fixture-${serial}`;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,1)').run(userId, `${userId}@example.test`, 'Fixture account');
  db.prepare('INSERT INTO bots(id,user_id,name,model,created_at,updated_at) VALUES(?,?,?,?,1,1)').run(botId, userId, 'Fixture Bot', 'grok-test');
  const source = appendRow(botId, 'message', { type: 'message', role: 'user', text: 'Prefer concise reports, remove the old project, and verify report sources.' });
  const evidence = [{ botId, generation: source.generation, seq: source.seq }];
  const first = memory.saveMemory(userId, botId, { text: 'Prefers detailed reports.', evidence }).memory!;
  const second = memory.saveMemory(userId, botId, { text: 'Works on the old project.', evidence }).memory!;
  const skillSource = appendRow(botId, 'message', { type: 'message', role: 'user', text: 'Verify and cite the original sources in reports.' });
  const skillEvidence = [{ botId, generation: skillSource.generation, seq: skillSource.seq }];
  const skill = skills.createSkill(userId, botId, { name: 'Report sources', description: 'Check sources', body: 'Read sources.' });
  db.prepare('INSERT INTO llm_items(bot_id,generation,idx,item) VALUES(?,1,0,?)').run(botId, JSON.stringify({ role: 'system', content: 'Local refinement fixture.' }));
  return { userId, botId, evidence, skillEvidence, first, second, skill };
}
const call = (name: string, args: unknown) => ({ output: [{ type: 'function_call', name, call_id: 'fixture-call', arguments: JSON.stringify(args) }], usage: { input_tokens: 20, output_tokens: 4 } });
const done = () => ({ output_text: 'Refinement complete.', output: [], usage: { input_tokens: 20, output_tokens: 4 } });

test('R13 plain mutation replies preserve private review proofs across memory batches and repeated skill edits', async () => {
  const f = fixture();
  const review = learning.refineLearning(f.userId, f.botId);
  let step = 0;
  learning.configureLearningModelExecutor(async body => {
    step++;
    if ([2, 4, 6].includes(step)) {
      assert.match(body.input.at(-1).output, /^Saved/);
      assert.doesNotMatch(body.input.at(-1).output, /\b(?:mem|skl)_[A-Za-z0-9_-]+|\brevision\b|\bactivated\b/);
    }
    if (step === 1) return call('manage_memory', { action: 'batch', operations: [
      { action: 'replace', memory_id: f.first.id, expected_revision: 1, text: 'Prefers concise reports.', evidence: f.evidence },
      { action: 'remove', memory_id: f.second.id, expected_revision: 1 },
    ] });
    if (step === 2 || step === 4) return call('read_skill', { skill_id: f.skill.id });
    if (step === 3) return call('manage_skill', { action: 'update', skill_id: f.skill.id, expected_revision: 1, body: 'Verify sources.', reason: 'Requested refinement', evidence: f.skillEvidence });
    if (step === 5) return call('manage_skill', { action: 'patch', skill_id: f.skill.id, expected_revision: 2, old_text: 'Verify', new_text: 'Verify and cite', reason: 'Requested refinement', evidence: f.skillEvidence });
    return done();
  });
  assert.equal((await learning.runLearningReview(review.id))?.status, 'completed');
  assert.equal(step, 6);
  assert.deepEqual(memory.listMemories(f.userId, f.botId).map(m => m.text), ['Prefers concise reports.']);
  assert.equal(skills.getSkill(f.userId, f.skill.id).revision, 3);
  assert.equal(skills.getSkill(f.userId, f.skill.id).body, 'Verify and cite sources.');

  const result = await toolMap.get('remember')!.impl({ text: 'Verify report sources.', evidence: f.skillEvidence }, { userId: f.userId, botId: f.botId, depth: 0, enqueueBotMessage() {} });
  assert.ok((knowledgeMutation(result) as any).memory.id);
  assert.deepEqual(Object.keys(result), ['output']);
  assert.doesNotMatch(JSON.stringify(result), /\bmem_[A-Za-z0-9_-]+|\brevision\b|\bactivated\b/);
});

test('R13 private mutation proofs do not accept concurrent external skill edits as review-owned writes', async () => {
  const f = fixture();
  const review = learning.refineLearning(f.userId, f.botId);
  let step = 0;
  learning.configureLearningModelExecutor(async () => {
    if (++step === 1) return call('manage_memory', { action: 'remove', memory_id: f.second.id, expected_revision: 1 });
    skills.updateSkill(f.userId, f.skill.id, { body: 'Concurrent owner edit.' }, 1);
    return done();
  });
  assert.equal((await learning.runLearningReview(review.id))?.status, 'cancelled');
  assert.equal(step, 2);
  assert.equal(skills.getSkill(f.userId, f.skill.id).body, 'Concurrent owner edit.');
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import crypto from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-native-knowledge-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'native-knowledge-test-only', SWARM_ROLE: 'standalone', NODE_ENV: 'test',
  COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', ADMIN_PHONES: '', INKBOX_TUNNEL: '0',
  DIRECT_API_KEY: 'test-model-key', LLM_PROVIDER: 'direct' });
mock.method(globalThis, 'fetch', async () => { throw new Error('Tests must not call the network'); });
const { db } = await import('../server/src/db.js');
await import('../server/src/db-config.js');
for (const id of ['owner', 'other']) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.com`, id, Date.now());
const insertBot = (id: string, owner = 'owner') => db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, owner, id, Date.now(), Date.now());
insertBot('legacy');
db.prepare('INSERT INTO skills(id,bot_id,name,body,created_at) VALUES(?,?,?,?,?)').run('legacy-skill', 'legacy', 'Old skill', 'Legacy instructions', 1);
db.prepare('INSERT INTO rows VALUES(?,?,?,?,?,?,?)').run('legacy', 1, 1, 1, 'message', JSON.stringify({ type: 'message', role: 'user', text: 'Backfilled evidence' }), 1);
const skills = await import('../server/src/knowledge/skills.js');
const memory = await import('../server/src/knowledge/memory.js');
const sessions = await import('../server/src/knowledge/sessions.js');
const { KnowledgeError } = await import('../server/src/knowledge/common.js');
const { KNOWLEDGE_TOOLS } = await import('../server/src/agent/knowledge-tools.js');
const { knowledgeApi } = await import('../server/src/routes-knowledge.js');
const legacyHistory = skills.listSkillHistory('owner', 'legacy-skill');
const legacySearch = sessions.searchMessages('owner', 'legacy', 'Backfilled');
const seedContent = { name: 'Weekly report', description: 'Prepare weekly reports', body: '1. Gather updates\n2. Cite sources' };
let seq = 0;
function message(text: string, opts: { botId?: string; generation?: number; role?: string; streaming?: boolean } = {}) {
  const botId = opts.botId ?? 'alpha', generation = opts.generation ?? 1, n = ++seq;
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,?,?,?,?,?,?)').run(botId, generation, n, n, 'message', JSON.stringify({ type: 'message', role: opts.role ?? 'user', text, streaming: opts.streaming ?? false }), 1000 + n);
  const body = db.prepare('SELECT body FROM rows WHERE bot_id=? AND generation=? AND seq=?').get(botId, generation, n) as any;
  return { botId, generation, seq: n, contentHash: crypto.createHash('sha256').update(body.body).digest('hex') };
}
function fails(fn: () => unknown, status: number) { assert.throws(fn, (e: any) => e instanceof KnowledgeError && e.status === status); }
beforeEach(() => { db.exec('DELETE FROM bots'); insertBot('alpha'); insertBot('sibling'); insertBot('foreign', 'other'); seq = 0; });
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('import migrations preserve existing skills and index already archived messages', () => {
  assert.equal(legacyHistory[0].action, 'import'); assert.equal(legacyHistory[0].body, 'Legacy instructions');
  assert.equal(legacySearch.messages[0].text, 'Backfilled evidence');
});

test('user CRUD appends immutable snapshots and rejects stale edits', () => {
  const s = skills.createSkill('owner', 'alpha', seedContent);
  assert.equal(s.revision, 1);
  const edited = skills.updateSkill('owner', s.id, { body: 'Changed steps' }, 1);
  assert.equal(edited.revision, 2);
  fails(() => skills.updateSkill('owner', s.id, { body: 'Stale steps' }, 1), 409);
  assert.deepEqual(skills.listSkillHistory('owner', s.id).map(r => [r.revision, r.body]), [[2, 'Changed steps'], [1, seedContent.body]]);
  assert.throws(() => db.prepare('UPDATE knowledge_skill_revisions SET snapshot=? WHERE skill_id=?').run('{}', s.id), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM knowledge_skill_revisions WHERE skill_id=?').run(s.id), /immutable/);
  const deleted = skills.deleteSkill('owner', s.id, 2);
  assert.equal(deleted.revision, 3); assert.equal(skills.listSkills('owner', 'alpha').length, 0);
  const restored = skills.rollbackSkill('owner', s.id, 1, 3);
  assert.equal(restored.revision, 4); assert.equal(restored.body, seedContent.body); assert.equal(restored.deleted, false);
  fails(() => skills.rollbackSkill('owner', s.id, 2, 3), 409);
  assert.equal(skills.listSkillHistory('owner', s.id).length, 4);
});

test('owner checks guard skill reads, edits, history, rollback and source search', () => {
  const s = skills.createSkill('other', 'foreign', seedContent);
  for (const action of [() => skills.getSkill('owner', s.id), () => skills.updateSkill('owner', s.id, {}, 1), () => skills.listSkillHistory('owner', s.id), () => skills.rollbackSkill('owner', s.id, 1, 1), () => skills.listSkills('owner', 'foreign'), () => sessions.searchMessages('owner', 'foreign', '')]) fails(action, 404);
});

test('learned skill remains staged, includes a diff and only approved revision becomes active', () => {
  const ref = message('For weekly reports, always cite original sources.');
  const proposal = skills.stageSkillProposal('owner', 'alpha', { expectedRevision: 0, content: seedContent, reason: 'User taught a repeatable procedure', evidence: [ref] });
  assert.equal(skills.listSkills('owner', 'alpha').length, 0);
  assert.match(proposal.diff, /\+1\. Gather updates/);
  const pending = skills.listSkillProposals('owner', 'alpha')[0]; assert.deepEqual(pending.evidence, [ref]);
  fails(() => skills.resolveSkillProposal('other', proposal.id, 'approve', 0), 404);
  fails(() => skills.resolveSkillProposal('owner', proposal.id, 'approve', 1), 409);
  const approved = skills.resolveSkillProposal('owner', proposal.id, 'approve', 0);
  assert.equal(approved.skill!.revision, 1); assert.equal(skills.listSkills('owner', 'alpha').length, 1);
  fails(() => skills.resolveSkillProposal('owner', proposal.id, 'approve', 0), 409);
});

test('stale approvals never overwrite an owner edit and stale proposals can be rejected', () => {
  const ref = message('Please add a verification step.'); const s = skills.createSkill('owner', 'alpha', seedContent);
  const p = skills.stageSkillProposal('owner', 'alpha', { skillId: s.id, expectedRevision: 1, content: { ...seedContent, body: 'Proposed verification' }, reason: 'Learning', evidence: [ref] });
  skills.updateSkill('owner', s.id, { body: 'Owner edited first' }, 1);
  fails(() => skills.resolveSkillProposal('owner', p.id, 'approve', 1), 409);
  assert.equal(skills.getSkill('owner', s.id).body, 'Owner edited first');
  assert.equal(skills.resolveSkillProposal('owner', p.id, 'reject', 1).status, 'rejected');
});

test('proposals validate sources, scope, generation and run attribution', () => {
  const ref = message('A learned procedure'); const foreignRef = message('Private procedure', { botId: 'foreign' });
  const input = { expectedRevision: 0, content: seedContent, reason: 'Learned', evidence: [ref] };
  fails(() => skills.stageSkillProposal('owner', 'alpha', { ...input, evidence: [foreignRef] }), 422);
  fails(() => skills.stageSkillProposal('owner', 'alpha', { ...input, evidence: [{ ...ref, seq: 999 }] }), 422);
  fails(() => skills.stageSkillProposal('owner', 'alpha', { ...input, runId: 'invented-run' }), 422);
  const p = skills.stageSkillProposal('owner', 'alpha', input);
  db.prepare('UPDATE bots SET generation=2 WHERE id=?').run('alpha');
  fails(() => skills.resolveSkillProposal('owner', p.id, 'approve', 0), 409);
  assert.equal(skills.listSkills('owner', 'alpha').length, 0);
});

test('progressive discovery returns metadata; read exposes only active skills in this bot', async () => {
  const s = skills.createSkill('owner', 'alpha', { ...seedContent, body: 'SECRET-LONG-SKILL-BODY' });
  const sibling = skills.createSkill('owner', 'sibling', seedContent);
  const ctx = { botId: 'alpha', userId: 'owner', depth: 0, enqueueBotMessage() {} };
  const list = await KNOWLEDGE_TOOLS.find(t => t.name === 'list_skills')!.impl({}, ctx);
  assert.doesNotMatch(list.output as string, /SECRET-LONG-SKILL-BODY/);
  assert.doesNotMatch(skills.skillIndexForPrompt('alpha'), /SECRET-LONG-SKILL-BODY/);
  const read = await KNOWLEDGE_TOOLS.find(t => t.name === 'read_skill')!.impl({ skill_id: s.id }, ctx);
  assert.match(read.output as string, /SECRET-LONG-SKILL-BODY/);
  const wrongBot = await KNOWLEDGE_TOOLS.find(t => t.name === 'read_skill')!.impl({ skill_id: sibling.id }, ctx); assert.equal(wrongBot.isError, true);
  assert.ok(!KNOWLEDGE_TOOLS.some(t => /approve|rollback|reject/.test(t.name)), 'Agent cannot approve its own learning');
});

test('archived FTS search returns original messages with stable anchors and bounded windows', () => {
  const ref = message('The deployment codename is silverfin.');
  message('silverfin secret foreign', { botId: 'foreign' });
  message('A nearby response', { role: 'assistant' });
  db.prepare('UPDATE bots SET generation=2 WHERE id=?').run('alpha');
  const result = sessions.searchMessages('owner', 'alpha', 'silverfin');
  assert.equal(result.messages.length, 1); assert.equal(result.messages[0].archived, true);
  assert.equal(result.messages[0].sourceKey, `alpha:1:${ref.seq}`);
  assert.equal(sessions.readMessageWindow('owner', 'alpha', ref).length, 2);
  assert.equal(sessions.searchMessages('owner', 'alpha', 'silverfin', { generation: 2 }).messages.length, 0);
  assert.equal(sessions.searchMessages('owner', 'alpha', 'silverfin', { role: 'assistant' }).messages.length, 0);
  assert.equal(sessions.searchMessages('owner', 'alpha', '" OR * NEAR(foo): \'').messages.length, 0);
});

test('FTS updates with completed streaming messages and deletes; query operators are literal', () => {
  const ref = message('streamingneedle', { streaming: true });
  assert.equal(sessions.searchMessages('owner', 'alpha', 'streamingneedle').messages.length, 0);
  db.prepare('UPDATE rows SET body=? WHERE bot_id=? AND generation=? AND seq=?').run(JSON.stringify({ type: 'message', role: 'assistant', text: 'completedneedle' }), 'alpha', 1, ref.seq);
  assert.equal(sessions.searchMessages('owner', 'alpha', 'completedneedle').messages.length, 1);
  fails(() => sessions.validateEvidence('owner', 'alpha', [{ ...ref, seq: -1 }]), 422);
  db.prepare('DELETE FROM rows WHERE bot_id=?').run('alpha');
  assert.equal(sessions.searchMessages('owner', 'alpha', 'completedneedle').messages.length, 0);
});

test('search has deterministic pagination and caps source text payloads', () => {
  for (let i = 0; i < 6; i++) message(`paginatedneedle ${i} ${'x'.repeat(5000)}`);
  const first = sessions.searchMessages('owner', 'alpha', 'paginatedneedle', { limit: 2 });
  const second = sessions.searchMessages('owner', 'alpha', 'paginatedneedle', { limit: 2, offset: first.nextOffset! });
  assert.equal(first.messages.length, 2); assert.equal(second.messages.length, 2);
  assert.ok(first.messages.every(m => m.text.length <= 4000));
  assert.ok(second.messages.every(m => !first.messages.some(f => f.sourceKey === m.sourceKey)));
});

test('memory correction excludes old facts, preserves evidence, guards ownership and suppresses relearning', () => {
  const oldRef = message('I live in Boston.'); const nextRef = message('I moved to Paris.');
  const saved = memory.saveMemory('owner', 'alpha', { text: 'Lives in Boston.', evidence: [oldRef] }).memory!;
  fails(() => memory.correctMemory('other', saved.id, { text: 'Lives elsewhere', expectedRevision: 1 }), 404);
  const corrected = memory.correctMemory('owner', saved.id, { text: 'Lives in Paris.', expectedRevision: 1, evidence: [nextRef] });
  assert.equal(corrected.supersedes, saved.id); assert.deepEqual(corrected.evidence, [nextRef]);
  assert.deepEqual(memory.recallMemories('owner', 'alpha').map(m => m.text), ['Lives in Paris.']);
  assert.equal(memory.listMemories('owner', 'alpha', true).find(m => m.id === saved.id)!.status, 'superseded');
  assert.equal(memory.saveMemory('owner', 'alpha', { text: 'Lives in Boston.', evidence: [oldRef] }).skipped, 'suppressed');
  fails(() => memory.correctMemory('owner', saved.id, { text: 'Lives in Rome.', expectedRevision: 1 }), 409);
  assert.equal(memory.memoryHistory('owner', saved.id)[0].action, 'supersede');
});

test('forget suppresses prior evidence and duplicate wording even when later messages repeat it', () => {
  const ref = message('Prefers short email summaries.');
  const m = memory.saveMemory('owner', 'alpha', { text: 'Prefers short email summaries.', evidence: [ref] }).memory!;
  fails(() => memory.forgetMemory('other', m.id, 1), 404);
  memory.forgetMemory('owner', m.id, 1);
  assert.equal(memory.recallMemories('owner', 'alpha').length, 0);
  assert.equal(memory.saveMemory('owner', 'alpha', { text: 'Please use concise email.', evidence: [ref] }).skipped, 'suppressed');
  const later = message('Prefers short email summaries.');
  assert.equal(memory.saveMemory('owner', 'alpha', { text: 'Prefers short email summaries!', evidence: [later] }).skipped, 'suppressed');
  assert.equal(memory.listMemories('owner', 'alpha', true)[0].status, 'deleted');
});

test('source forgery, streaming evidence and cross-bot memories fail before publication', () => {
  const ref = message('Unfinished', { streaming: true }); const foreign = message('Private', { botId: 'foreign' });
  for (const evidence of [[], [ref], [foreign]]) fails(() => memory.saveMemory('owner', 'alpha', { text: 'Invented memory', evidence }), 422);
  assert.equal(memory.listMemories('owner', 'alpha').length, 0);
});

function cookie(owner: string) {
  const raw = crypto.randomBytes(32).toString('hex'); const hash = crypto.createHash('sha256').update(raw).digest('hex'); const at = Date.now();
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES(?,?,?,?,?,?)').run(hash, owner, at, at + 60000, at, at);
  return `swarm_session=${raw}`;
}
test('HTTP knowledge routes enforce auth, ownership, expected revisions and suppression', async () => {
  assert.equal((await knowledgeApi.request('/bots/alpha/memories')).status, 401);
  const owner = cookie('owner'), other = cookie('other');
  const ref = message('Prefer concise replies.'); const m = memory.saveMemory('owner', 'alpha', { text: 'Prefers concise replies.', evidence: [ref] }).memory!;
  assert.equal((await knowledgeApi.request(`/memories/${m.id}`, { method: 'DELETE', headers: { cookie: other } })).status, 404);
  assert.equal((await knowledgeApi.request(`/memories/${m.id}?expectedRevision=5`, { method: 'DELETE', headers: { cookie: owner } })).status, 409);
  assert.equal((await knowledgeApi.request(`/memories/${m.id}?expectedRevision=1`, { method: 'DELETE', headers: { cookie: owner } })).status, 200);
  assert.equal(memory.saveMemory('owner', 'alpha', { text: m.text, evidence: [ref] }).skipped, 'suppressed');
  const search = await knowledgeApi.request('/bots/alpha/conversation-search?q=concise', { headers: { cookie: owner } }); assert.equal(search.status, 200); assert.equal(search.headers.get('cache-control'), 'no-store');
  assert.equal((await search.json()).messages.length, 1);
});

test('owner CRUD HTTP routes use revision history rather than overwriting legacy skills', async () => {
  const { configApi } = await import('../server/src/routes-config.js');
  const headers = { cookie: cookie('owner'), 'content-type': 'application/json' };
  const created = await configApi.request('/bots/alpha/skills', { method: 'POST', headers, body: JSON.stringify(seedContent) });
  assert.equal(created.status, 200); const s = (await created.json()).skill;
  assert.equal(s.revision, 1);
  const missing = await configApi.request(`/skills/${s.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body: 'Updated' }) }); assert.equal(missing.status, 400);
  const updated = await configApi.request(`/skills/${s.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body: 'Updated', expectedRevision: 1 }) }); assert.equal(updated.status, 200);
  assert.equal((await configApi.request(`/skills/${s.id}?expectedRevision=2`, { method: 'DELETE', headers })).status, 200);
  assert.deepEqual(skills.listSkillHistory('owner', s.id).map(r => r.action), ['delete', 'edit', 'create']);
});

test('consolidation publishes only cited user facts and rejects stale generation/source results', async t => {
  const { llmClient } = await import('../server/src/lib/llm.js');
  const { consolidateBot, memoriesForPrompt } = await import('../server/src/agent/memory.js');
  const client = llmClient(300000);
  const ref = message('I prefer weekly reports.'); const botRef = message('The user owns a spaceship.', { role: 'assistant' });
  const create = t.mock.method(client.responses, 'create', async () => ({ output_text: JSON.stringify({ memories: [
    { text: 'Prefers weekly reports.', sourceIds: [`1:${ref.seq}`] }, { text: 'Owns a spaceship.', sourceIds: [`1:${botRef.seq}`] }, { text: 'Invented source.', sourceIds: ['1:9999'] },
  ] }) }));
  const result = await consolidateBot('alpha', { upTo: 2000 });
  assert.deepEqual(result.added, ['Prefers weekly reports.']); assert.equal(result.skipped, 2);
  const m = memory.listMemories('owner', 'alpha')[0]; assert.deepEqual(m.evidence, [ref]);
  memory.forgetMemory('owner', m.id, 1); assert.equal(memoriesForPrompt('alpha').lines.length, 0);
  db.prepare('DELETE FROM memory_jobs WHERE bot_id=?').run('alpha');
  create.mock.mockImplementation(async () => { db.prepare('UPDATE bots SET generation=2 WHERE id=?').run('alpha'); return { output_text: JSON.stringify({ memories: [{ text: 'Must not publish stale learning.', sourceIds: [`1:${ref.seq}`] }] }) }; });
  assert.deepEqual((await consolidateBot('alpha', { upTo: 2000 })).added, []);
  assert.equal(memory.listMemories('owner', 'alpha').length, 0);
  assert.equal(db.prepare('SELECT * FROM memory_jobs WHERE bot_id=?').get('alpha'), undefined);
});

test('changed source contents invalidate pending approvals, rather than silently reattaching evidence', () => {
  const ref = message('Follow these original steps.');
  const p = skills.stageSkillProposal('owner', 'alpha', { expectedRevision: 0, content: seedContent, reason: 'Learning', evidence: [ref] });
  db.prepare('UPDATE rows SET body=? WHERE bot_id=? AND seq=?').run(JSON.stringify({ type: 'message', role: 'user', text: 'Those steps were wrong.' }), 'alpha', ref.seq);
  fails(() => skills.resolveSkillProposal('owner', p.id, 'approve', 0), 409);
  assert.equal(skills.listSkills('owner', 'alpha').length, 0);
});

test('legacy text-only remember is grounded in one unique real user source and fails ambiguous or invented facts', async () => {
  const ref = message('Remember that I prefer provider independence.');
  const ctx = { botId: 'alpha', userId: 'owner', depth: 0, enqueueBotMessage() {} };
  const remember = KNOWLEDGE_TOOLS.find(t => t.name === 'remember')!;
  const valid = await remember.impl({ text: 'Prefers provider independence.' }, ctx);
  assert.equal(valid.isError, undefined); assert.deepEqual(JSON.parse(valid.output as string).memory.evidence, [ref]);
  const invented = await remember.impl({ text: 'Owns a private spaceship.' }, ctx); assert.equal(invented.isError, true);
  message('I prefer provider independence.');
  const ambiguous = await remember.impl({ text: 'Prefers provider independence.' }, ctx); assert.equal(ambiguous.isError, true);
  const explicitEmpty = await remember.impl({ text: 'Prefers provider independence.', evidence: [] }, ctx); assert.equal(explicitEmpty.isError, true);
});

test('knowledge router mounted first does not swallow public sign-in routes', async () => {
  const { Hono } = await import('hono');
  const app = new Hono().route('/api', knowledgeApi).get('/api/auth/test', c => c.json({ public: true }));
  const res = await app.request('/api/auth/test'); assert.equal(res.status, 200); assert.deepEqual(await res.json(), { public: true });
});

test('fabricated direct memory calls cannot omit evidence or revision guards', async () => {
  const ref = message('I live in Boston.');
  const saved = memory.saveMemory('owner', 'alpha', { text: 'Lives in Boston.', evidence: [ref] }).memory!;
  const ctx = { botId: 'alpha', userId: 'owner', depth: 0, enqueueBotMessage() {} };
  const correct = KNOWLEDGE_TOOLS.find(t => t.name === 'correct_memory')!;
  for (const evidence of [undefined, []]) {
    const result = await correct.impl({ memory_id: saved.id, text: 'Lives in Paris.', expected_revision: 1, ...(evidence ? { evidence } : {}) }, ctx);
    assert.equal(result.isError, true);
  }
  const forget = KNOWLEDGE_TOOLS.find(t => t.name === 'forget_memory')!;
  const result = await forget.impl({ memory_id: saved.id }, ctx); assert.equal(result.isError, true);
  assert.deepEqual(memory.recallMemories('owner', 'alpha').map(m => m.text), ['Lives in Boston.']);
  assert.equal(memory.listMemories('owner', 'alpha', true).length, 1);
});

test('compaction rewrites model context while preserving original searchable source evidence', async t => {
  const { llmClient } = await import('../server/src/lib/llm.js');
  const { maybeCompact, memoryConfig } = await import('../server/src/agent/memory.js');
  const ref = message('The original source marker is persimmons.');
  const items = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Turn ${i}: ${'context '.repeat(200)}` }));
  const put = db.prepare('INSERT INTO llm_items(bot_id,generation,idx,item) VALUES(?,?,?,?)'); items.forEach((it, i) => put.run('alpha', 1, i, JSON.stringify(it)));
  const method = memoryConfig.compactMethod; memoryConfig.compactMethod = 'summary';
  t.mock.method(llmClient(300000).responses, 'create', async () => ({ output_text: 'A compressed model-only note.' }));
  try {
    const compacted = await maybeCompact('alpha', items, { force: true });
    assert.ok(compacted.length < items.length);
    assert.equal(sessions.searchMessages('owner', 'alpha', 'persimmons').messages[0].seq, ref.seq);
    assert.equal(sessions.searchMessages('owner', 'alpha', 'compressed').messages.length, 0, 'Synthetic summary is not source evidence');
    assert.equal(sessions.validateEvidence('owner', 'alpha', [ref])[0].text, 'The original source marker is persimmons.');
  } finally { memoryConfig.compactMethod = method; }
});

function compactionHistory(botId: string) {
  const items = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Turn ${i}: ${'context '.repeat(200)}` }));
  const put = db.prepare('INSERT INTO llm_items(bot_id,generation,idx,item) VALUES(?,?,?,?)');
  items.forEach((it, i) => put.run(botId, 1, i, JSON.stringify(it)));
  return items;
}

test('compaction rechecks fallback budget and only summary requests accept an output cap', async t => {
  const { llmClient } = await import('../server/src/lib/llm.js');
  const { maybeCompact, memoryConfig } = await import('../server/src/agent/memory.js');
  const items = compactionHistory('alpha'), client = llmClient(300000);
  const method = memoryConfig.compactMethod; memoryConfig.compactMethod = 'auto';
  const requests: any[] = [];
  t.mock.method(client, 'post', async (url: string, options: any) => { requests.push({ url, ...options.body }); return { output: [] }; });
  t.mock.method(client.responses, 'create', async (body: any) => { requests.push(body); return { output_text: 'Fallback summary.' }; });
  let guards = 0;
  try {
    await maybeCompact('alpha', items, { force: true, beforeModel: () => ++guards === 1 ? 321 : 123 });
    assert.equal(guards, 2);
    assert.equal(requests[0].url, '/responses/compact');
    assert.equal(Object.hasOwn(requests[0], 'max_output_tokens'), false, 'Compact endpoint does not support an output cap');
    assert.equal(requests[1].max_output_tokens, 123, 'Fallback uses its freshly checked budget');
  } finally { memoryConfig.compactMethod = method; }
});

test('compaction guard rejection propagates without a provider call or summary workaround', async t => {
  const { llmClient } = await import('../server/src/lib/llm.js');
  const { maybeCompact, memoryConfig } = await import('../server/src/agent/memory.js');
  const items = compactionHistory('alpha'), client = llmClient(300000);
  const method = memoryConfig.compactMethod; memoryConfig.compactMethod = 'auto';
  const post = t.mock.method(client, 'post', async () => { throw new Error('Provider must not be called'); });
  const summary = t.mock.method(client.responses, 'create', async () => { throw new Error('Fallback must not be called'); });
  const stopped = new Error('Workflow stopped'); let guards = 0;
  try {
    await assert.rejects(maybeCompact('alpha', items, { force: true, beforeModel: () => { guards++; throw stopped; } }), error => error === stopped);
    assert.equal(guards, 1); assert.equal(post.mock.callCount(), 0); assert.equal(summary.mock.callCount(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM llm_items WHERE bot_id=?').get('alpha').n, items.length);
  } finally { memoryConfig.compactMethod = method; }
});

test('fallback cannot spend after compaction usage exhausts the guarded budget', async t => {
  const { llmClient } = await import('../server/src/lib/llm.js');
  const { maybeCompact, memoryConfig } = await import('../server/src/agent/memory.js');
  const items = compactionHistory('alpha'), client = llmClient(300000);
  const method = memoryConfig.compactMethod; memoryConfig.compactMethod = 'auto';
  t.mock.method(client, 'post', async () => ({ output: [], id: 'direct-before-budget-recheck', usage: { input_tokens: 10, output_tokens: 2, cost: 0.01 } }));
  const summary = t.mock.method(client.responses, 'create', async () => ({ output_text: 'Must not be generated.' }));
  const exhausted = new Error('Budget exhausted after direct compaction'); let guards = 0;
  try {
    await assert.rejects(maybeCompact('alpha', items, { force: true, beforeModel: () => {
      if (++guards === 1) return 12;
      assert.ok(db.prepare('SELECT 1 FROM usage_events WHERE request_id=?').get('direct-before-budget-recheck'), 'Direct usage must be recorded before fallback admission');
      throw exhausted;
    } }), error => error === exhausted);
    assert.equal(guards, 2); assert.equal(summary.mock.callCount(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM llm_items WHERE bot_id=?').get('alpha').n, items.length);
  } finally { memoryConfig.compactMethod = method; }
});

test('summary compaction guard permits undefined caps and rejects invalid finite budgets', async t => {
  const { llmClient } = await import('../server/src/lib/llm.js');
  const { maybeCompact, memoryConfig } = await import('../server/src/agent/memory.js');
  const items = compactionHistory('alpha'), client = llmClient(300000);
  const method = memoryConfig.compactMethod; memoryConfig.compactMethod = 'summary';
  const summary = t.mock.method(client.responses, 'create', async (body: any) => { assert.equal(Object.hasOwn(body, 'max_output_tokens'), false); return { output_text: 'Uncapped summary.' }; });
  try {
    for (const remaining of [0, -1, Infinity, NaN, 1.5]) await assert.rejects(maybeCompact('alpha', items, { force: true, beforeModel: () => remaining }), /positive safe integer/);
    assert.equal(summary.mock.callCount(), 0);
    let guards = 0;
    await maybeCompact('alpha', items, { force: true, beforeModel: () => { guards++; return undefined; } });
    assert.equal(guards, 1); assert.equal(summary.mock.callCount(), 1);
  } finally { memoryConfig.compactMethod = method; }
});

test('direct compaction, summary and consolidation await asynchronous usage before publishing', async t => {
  const { llmClient } = await import('../server/src/lib/llm.js');
  const { maybeCompact, consolidateBot, memoryConfig } = await import('../server/src/agent/memory.js');
  insertBot('third');
  const directItems = compactionHistory('alpha'), summaryItems = compactionHistory('sibling');
  const ref = message('I prefer detailed weekly reports.', { botId: 'third' });
  const client = llmClient(300000), method = memoryConfig.compactMethod;
  let releasePricing!: () => void, pricingStarted!: () => void;
  const pricingReady = new Promise<void>(resolve => { pricingStarted = resolve; });
  const pricingGate = new Promise<void>(resolve => { releasePricing = resolve; });
  t.mock.method(globalThis, 'fetch', async () => { pricingStarted(); await pricingGate; return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } }); });
  const response = (kind: string) => ({ id: `awaited-memory-${kind}`, usage: { input_tokens: 10, output_tokens: 2 } });
  t.mock.method(client, 'post', async () => ({ ...response('direct'), output: [{ type: 'compaction', encrypted_content: 'compact' }] }));
  t.mock.method(client.responses, 'create', async (body: any) => String(body.input[0].content).startsWith('You maintain')
    ? { ...response('consolidation'), output_text: JSON.stringify({ memories: [{ text: 'Prefers detailed weekly reports.', sourceIds: [`1:${ref.seq}`] }] }) }
    : { ...response('summary'), output_text: 'Summary waiting on accounting.' });
  let completed = 0;
  memoryConfig.compactMethod = 'auto';
  const direct = maybeCompact('alpha', directItems, { force: true }).then(value => { completed++; return value; });
  memoryConfig.compactMethod = 'summary';
  const summary = maybeCompact('sibling', summaryItems, { force: true }).then(value => { completed++; return value; });
  const consolidation = consolidateBot('third', { upTo: 2000 }).then(value => { completed++; return value; });
  const operations = [direct, summary, consolidation];
  try {
    await pricingReady;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, 0, 'No side-model operation may return before its delayed accounting completes');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_events WHERE request_id LIKE 'awaited-memory-%'").get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM llm_items WHERE bot_id=?').get('alpha').n, directItems.length);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM llm_items WHERE bot_id=?').get('sibling').n, summaryItems.length);
    assert.equal(memory.listMemories('owner', 'third').length, 0);
    releasePricing();
    await Promise.all(operations);
    assert.equal(completed, 3);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM usage_events WHERE request_id LIKE 'awaited-memory-%'").get().n, 3);
    assert.equal(memory.listMemories('owner', 'third')[0].text, 'Prefers detailed weekly reports.');
  } finally { releasePricing(); await Promise.allSettled(operations); memoryConfig.compactMethod = method; }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-knowledge-ingestion-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'knowledge-ingestion-test', SWARM_ROLE: 'standalone',
  COMPUTER_PROVIDER: 'local', NODE_ENV: 'test', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0',
});
mock.method(globalThis, 'fetch', async () => { throw new Error('No network allowed in ingestion tests'); });
const { db } = await import('../server/src/db.js');
const { appendRow, updateRow, getRow, onRowChange } = await import('../server/src/store.js');
const { hub } = await import('../server/src/lib/hub.js');
const memory = await import('../server/src/knowledge/memory.js');
const { patchLearningSettings } = await import('../server/src/knowledge/settings.js');
const { createSkill } = await import('../server/src/knowledge/skills.js');
const { PROCEDURE_BODY, PROCEDURE_FILE } = await import('../server/src/knowledge/evaluation.js');
const { KNOWLEDGE_TOOLS } = await import('../server/src/agent/knowledge-tools.js');
const { assembleToolCatalog } = await import('../server/src/agent/tool-catalog.js');
const { runProgram } = await import('../server/src/agent/programs.js');
const { acceptJob } = await import('../server/src/agent/jobs.js');
const { holdLegacyDatabase } = await import('../server/src/platform/legacy-database-fence.js');
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

let serial = 0;
function fixture() {
  const userId = `usr_knowledge_ingestion_${++serial}`, botId = `bot_ingestion_${serial}`;
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${serial}@test.invalid`, 'Owner', 1);
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(botId, userId, 'Analyst', 1, 1);
  const row = appendRow(botId, 'message', { type: 'message', role: 'user', text: 'I prefer weekly reports.' });
  const original = memory.saveMemory(userId, botId, { text: 'Prefers weekly reports.', evidence: [{ botId, generation: row.generation, seq: row.seq }] }).memory!;
  return { userId, botId, original };
}
const active = (f: ReturnType<typeof fixture>) => memory.listMemories(f.userId, f.botId);
function snapshot(f: ReturnType<typeof fixture>) {
  return JSON.stringify({
    bot: db.prepare('SELECT next_seq,rev,updated_at FROM bots WHERE id=?').get(f.botId),
    rows: db.prepare('SELECT * FROM rows WHERE bot_id=? ORDER BY seq').all(f.botId),
    memories: db.prepare('SELECT * FROM memories WHERE bot_id=? ORDER BY id').all(f.botId),
    revisions: db.prepare('SELECT * FROM knowledge_memory_events WHERE bot_id=? ORDER BY id').all(f.botId),
    suppressions: db.prepare('SELECT * FROM knowledge_memory_suppressions WHERE bot_id=?').all(f.botId),
    events: db.prepare('SELECT * FROM native_events WHERE user_id=? ORDER BY seq').all(f.userId),
  });
}

test('web, voice and messaging corrections commit before observers even with learning paused', () => {
  for (const channel of [undefined, 'voice', 'imessage', 'sms', 'whatsapp'] as const) {
    const f = fixture();
    patchLearningSettings(f.userId, { botId: f.botId, expectedRevision: 0, settings: { enabled: false } });
    const observations: string[][] = [];
    const inspect = () => observations.push(active(f).map(m => m.text));
    const unsubscribeHub = hub.subscribe(f.userId, event => { if (event.type === 'rows' || event.type === 'memories') inspect(); });
    const unsubscribeRow = onRowChange((owner, row) => { if (owner === f.userId && row.botId === f.botId) inspect(); });
    let row;
    try {
      row = appendRow(f.botId, 'message', { type: 'message', role: 'user', text: 'I now prefer daily reports.',
        ...(channel ? { from: { kind: channel, id: 'human', name: 'Owner' } } : {}) });
    } finally { unsubscribeHub(); unsubscribeRow(); }
    assert.deepEqual(observations, Array.from({ length: 3 }, () => ['Prefers daily reports.']), channel ?? 'web');
    const replacement = active(f)[0];
    assert.equal(replacement.supersedes, f.original.id);
    assert.equal(replacement.supersededRevision, f.original.revision);
    assert.equal(replacement.evidence[0].seq, row.seq);
    assert.match(replacement.evidence[0].contentHash!, /^[a-f0-9]{64}$/);
    assert.equal(memory.listMemoryChanges(f.userId, f.botId).length, 0);
    assert.equal((db.prepare('SELECT COUNT(*) n FROM agent_jobs WHERE bot_id=?').get(f.botId) as any).n, 0);
  }
});

test('only completed genuine user-audience messages can correct a preference', () => {
  const f = fixture();
  const text = 'I now prefer daily reports.';
  const bodies: any[] = [
    { role: 'assistant', text },
    { role: 'user', text, audience: 'internal' },
    { role: 'user', text, from: { kind: 'bot', id: 'peer', name: 'Peer' } },
    { role: 'user', text, from: { kind: 'system', id: 'routine', name: 'Routine' } },
    { role: 'user', text, streaming: true },
    { role: 'user', text: '   ' },
    { role: 'user', text: 'Tomorrow I prefer daily reports.' },
    { role: 'user', text: 'I prefer daily reports and weekly summaries.' },
    { role: 'user', text: text + ' '.repeat(4100) + 'This is an example, not my preference.' },
  ];
  for (const body of bodies) appendRow(f.botId, 'message', { type: 'message', ...body });
  assert.deepEqual(active(f).map(m => m.id), [f.original.id]);
  assert.equal(memory.listMemoryChanges(f.userId, f.botId).length, 0);
});

test('finishing a human message applies once before update observers and preserves its source revision', () => {
  const f = fixture();
  const body = { type: 'message' as const, role: 'user' as const, text: 'I now prefer daily reports.', streaming: true };
  const row = appendRow(f.botId, 'message', body);
  assert.equal(active(f)[0].id, f.original.id);
  const observations: string[][] = [];
  const stop = onRowChange((_owner, changed) => { if (changed.botId === f.botId) observations.push(active(f).map(m => m.text)); });
  try { updateRow(f.botId, row.seq, { ...body, streaming: false }); } finally { stop(); }
  assert.deepEqual(observations, [['Prefers daily reports.']]);
  const replacement = active(f)[0];
  assert.equal(replacement.evidence[0].seq, row.seq);
  updateRow(f.botId, row.seq, { ...body, streaming: false });
  assert.equal(active(f)[0].id, replacement.id, 'same correction must not create another revision');
});

test('a correction write failure rolls back source, counter, memory and events before fanout', () => {
  const f = fixture(), before = snapshot(f);
  let observed = 0;
  const stop = onRowChange((_owner, row) => { if (row.botId === f.botId) observed++; });
  db.exec("CREATE TEMP TRIGGER reject_ingestion_correction BEFORE INSERT ON memories WHEN NEW.supersedes IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected correction write failure'); END;");
  try {
    assert.throws(() => appendRow(f.botId, 'message', { type: 'message', role: 'user', text: 'I now prefer daily reports.' }), /injected correction write failure/);
    assert.equal(snapshot(f), before);
    assert.equal(observed, 0);
  } finally { db.exec('DROP TRIGGER reject_ingestion_correction'); stop(); }
  const retried = appendRow(f.botId, 'message', { type: 'message', role: 'user', text: 'I now prefer daily reports.' });
  assert.equal(retried.seq, 2);
  assert.equal(active(f)[0].text, 'Prefers daily reports.');
});

test('a failed final-message update retains the unfinished source and original memory', () => {
  const f = fixture();
  const row = appendRow(f.botId, 'message', { type: 'message', role: 'user', text: 'I now prefer daily reports.', streaming: true });
  const before = snapshot(f);
  db.exec("CREATE TEMP TRIGGER reject_ingestion_update BEFORE INSERT ON memories WHEN NEW.supersedes IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected update failure'); END;");
  try {
    assert.throws(() => updateRow(f.botId, row.seq, { type: 'message', role: 'user', text: 'I now prefer daily reports.', streaming: false }), /injected update failure/);
    assert.equal(snapshot(f), before);
    assert.equal((getRow(f.botId, row.seq)!.body as any).streaming, true);
  } finally { db.exec('DROP TRIGGER reject_ingestion_update'); }
});

test('account and Bot boundaries prevent a correction from replacing another memory', () => {
  const f = fixture(), other = fixture();
  const sibling = `${f.botId}_sibling`;
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(sibling, f.userId, 'Sibling', 1, 1);
  appendRow(sibling, 'message', { type: 'message', role: 'user', text: 'I now prefer daily reports.' });
  assert.equal(active(f)[0].id, f.original.id);
  appendRow(other.botId, 'message', { type: 'message', role: 'user', text: 'I now prefer daily reports.' });
  assert.equal(active(f)[0].id, f.original.id);
  assert.equal(active(other)[0].text, 'Prefers daily reports.');
});

test('migration holds reject message and correction together', () => {
  const f = fixture();
  holdLegacyDatabase(db, f.userId, 'knowledge-ingestion-test', '1');
  const before = snapshot(f);
  assert.throws(() => appendRow(f.botId, 'message', { type: 'message', role: 'user', text: 'I now prefer daily reports.' }), /migrat/i);
  assert.equal(snapshot(f), before);
});

test('procedure stays discoverable and program execution retains ownership and exact revision receipts', async () => {
  const f = fixture(), foreign = fixture();
  const skill = createSkill(f.userId, f.botId, { name: 'Report classification', description: 'Classify a report observation', body: PROCEDURE_BODY,
    resources: { [PROCEDURE_FILE]: JSON.stringify({ version: 1, responsibility: 'report_review', rules: [{ when: { overdue: true }, outcome: 'needs_review' }], fallback: 'no_change' }) } });
  const definition = KNOWLEDGE_TOOLS.find(tool => tool.name === 'apply_procedure')!;
  const schema = { type: 'function' as const, name: definition.name, description: definition.description, parameters: definition.parameters };
  const catalog = [schema, ...Array.from({ length: 50 }, (_, i) => ({ type: 'function', name: `mcp_extra_${i}`, parameters: { type: 'object' } }))];
  assert.ok(assembleToolCatalog(catalog).tools.some(tool => tool.name === 'apply_procedure'));
  const job = acceptJob(f.botId, { type: 'user', text: 'Classify the frozen observation.' });
  const ctx: any = { userId: f.userId, botId: f.botId, jobId: job.id, enqueueBotMessage: () => { throw new Error('No business effects'); } };
  const options = { userId: f.userId, botId: f.botId, jobId: job.id, callId: 'procedure_program_ingestion',
    args: { tools: ['apply_procedure'], inputs: { skill_id: skill.id, input: { scope: 'report_review', facts: { overdue: true } } }, code: 'return tools.call("apply_procedure", inputs);' },
    catalog: async () => [schema], dispatch: async (action: any) => definition.impl(action.args, ctx) };
  const result = await runProgram(options);
  assert.equal(result.status, 'completed', result.error);
  assert.equal((result.result as any).outcome, 'needs_review');
  assert.equal((result.result as any).revision, skill.revision);
  await runProgram(options);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM knowledge_procedure_applications WHERE job_id=?').get(job.id) as any).n, 1);
  assert.ok(db.prepare('SELECT 1 FROM native_context_receipts WHERE job_id=? AND source_id=? AND revision=?').get(job.id, skill.id, String(skill.revision)));
  const denied = await definition.impl({ skill_id: skill.id, input: { scope: 'report_review', facts: { overdue: true } } }, { ...ctx, userId: foreign.userId, botId: foreign.botId, jobId: undefined });
  assert.equal(denied.isError, true);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM knowledge_procedure_applications WHERE bot_id=?').get(foreign.botId) as any).n, 0);
});

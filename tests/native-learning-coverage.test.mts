// Maintained regression coverage for native Hermes/Quinn boundary behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';

const serverRoot = process.env.HERMES_SERVER_ROOT ?? path.resolve(import.meta.dirname, '..');
const native = (file: string) => import(pathToFileURL(path.join(serverRoot, 'server/src', file)).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quinn-learning-audit-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'audit.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'isolated-learning-audit', SWARM_ROLE: 'standalone', NODE_ENV: 'test',
  COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', ADMIN_PHONES: '',
  INKBOX_TUNNEL: '0', DIRECT_API_KEY: 'fixture', LLM_PROVIDER: 'direct',
});
mock.method(globalThis, 'fetch', async () => { throw new Error('Audit must not call the network'); });
const { db } = await native('db.ts');
await native('db-config.ts');
const { saveMemory, listMemories } = await native('knowledge/memory.ts');
const { consolidateBot } = await native('agent/memory.ts');
const { llmClient } = await native('lib/llm.ts');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run('owner', 'audit@example.test', 'Audit', 1);
const model = mock.method(llmClient(300000).responses, 'create', async (_body: any) => ({ output_text: '{"memories":[]}' }));
function bot(id: string) {
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, 'owner', id, 1, 1);
}
function message(botId: string, seq: number, createdAt: number, text: string) {
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(botId, 1, seq, seq, 'message', JSON.stringify({ type: 'message', role: 'user', text }), createdAt);
  return { botId, generation: 1, seq };
}
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function coverage(id: string, count: number, stamp: (i: number) => number, body: (i: number) => string) {
  bot(id);
  for (let i = 1; i <= count; i++) message(id, i, stamp(i), body(i));
  const seen = new Set<string>();
  model.mock.mockImplementation(async (request: any) => {
    const transcript = request.input.at(-1).content as string;
    for (const match of transcript.matchAll(/\[source (\d+:\d+)\]/g)) seen.add(match[1]);
    return { output_text: '{"memories":[]}' };
  });
  for (let n = 0; n < 10; n++) {
    const result = await consolidateBot(id, { upTo: 10000 });
    if (result.considered === 0) break;
  }
  return seen.size;
}

test('control: separate timestamps preserve source coverage over multiple review batches', async () => {
  assert.equal(await coverage('control', 75, i => 1000 + i, i => `Preference source ${i}.`), 75);
});

test('learning cursor preserves all sources when a batch shares timestamps', async () => {
  const observed = await coverage('equal-times', 75, () => 1000, i => `Preference source ${i}.`);
  console.log(JSON.stringify({ scenario: 'learning_equal_timestamps', sourcesStored: 75, sourcesPresentedForReview: observed }));
  assert.equal(observed, 75);
});

test('bounded reviews do not permanently checkpoint sources omitted from the model input', async () => {
  const observed = await coverage('bounded-input', 40, i => 1000 + i, i => `Preference source ${i}. ` + 'context '.repeat(250));
  console.log(JSON.stringify({ scenario: 'learning_input_truncation', sourcesStored: 40, sourcesPresentedForReview: observed }));
  assert.equal(observed, 40);
});


test('passive preference correction stages replacement and preserves the active fact', async () => {
  const { listMemoryChanges } = await native('knowledge/memory.ts');
  bot('changed-preference');
  const old = message('changed-preference', 1, 1001, 'I prefer weekly pipeline reports with named owners and source links.');
  const original = saveMemory('owner', 'changed-preference', { text: 'Prefers weekly pipeline reports with named owners and source links.', evidence: [old] }).memory!;
  message('changed-preference', 2, 1002, 'I now prefer daily pipeline reports with named owners and source links.');
  model.mock.mockImplementation(async () => ({ output_text: JSON.stringify({ memories: [{
    text: 'Prefers daily pipeline reports with named owners and source links.', sourceIds: ['1:2'],
  }] }) }));
  await consolidateBot('changed-preference', { upTo: 2000 });
  assert.deepEqual(listMemories('owner', 'changed-preference').map(m => m.text), [original.text], 'unattended replacement must not activate');
  const pending = listMemoryChanges('owner', 'changed-preference').filter(c => c.status === 'pending');
  assert.equal(pending.length, 1, 'changed preference must be staged rather than discarded as a duplicate');
  assert.equal(pending[0].memoryId, original.id);
  assert.equal(pending[0].baseRevision, original.revision);
  assert.equal(pending[0].action, 'replace');
  assert.equal(pending[0].text, 'Prefers daily pipeline reports with named owners and source links.');
  assert.equal(pending[0].evidence[0].seq, 2);
});

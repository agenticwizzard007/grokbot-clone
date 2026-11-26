import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripInternalIds } from '../web/src/lib/stripInternalIds.ts';
import { redactInternalIds } from '../server/src/lib/redact.ts';
import { planLabel } from '../web/src/lib/planLabel.ts';

test('R12 plan labels name Claude Max, Pro and Team and fall back safely for unknown codes and Codex', () => {
  for (const [code, tier] of [['max', 'Max'], ['pro', 'Pro'], ['team', 'Team']]) {
    assert.equal(planLabel('claude-cli', code), `Claude ${tier} plan`);
    assert.equal(planLabel('claude', ` ${code.toUpperCase()} `), `Claude ${tier} plan`);
    assert.equal(planLabel('claude-cli', `Claude ${tier}`), `Claude ${tier} plan`);
    assert.equal(planLabel('claude-cli', `Claude ${tier} plan`), `Claude ${tier} plan`);
  }
  assert.equal(planLabel('claude-cli', 'max_5x'), 'Claude Max plan');
  assert.equal(planLabel('claude-cli', 'Claude Ultra'), 'Claude Ultra plan');
  for (const code of [null, '', 'unknown_subscription', 'an unrecognized plan', '__proto__', 'constructor']) assert.equal(planLabel('claude-cli', code), 'Claude plan');
  for (const code of [null, 'plus', 'pro', 'team']) assert.equal(planLabel('codex-cli', code), 'Codex plan');
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-mm-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'db'), FILES_DIR: path.join(root, 'files'), SWARM_ROLE: 'standalone', SESSION_SECRET: 'fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', DIRECT_API_KEY: '', OPENROUTER_API_KEY: '' });
mock.method(globalThis, 'fetch', async () => { throw Error('No external requests in tool copy fixtures'); });
const { db } = await import('../server/src/db.js');
const { createBot } = await import('../server/src/bots.js');
const { toolMap } = await import('../server/src/agent/tools.js');
const { unscheduleRoutine } = await import('../server/src/routines.js');
const { listArtifacts, readArtifact } = await import('../server/src/deliverables/index.js');
const { appendRow } = await import('../server/src/store.js');
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('fixture', 'fixture@example.test', 'Fixture account', Date.now());
const bot = createBot('fixture', { name: 'Fixture Bot', isPrimary: true });
const other = createBot('fixture', { name: 'Other Bot' });
const ctx = { userId: 'fixture', botId: bot.id, depth: 0, enqueueBotMessage() {} };
const run = (name: string, args: any) => toolMap.get(name)!.impl(args, ctx);
after(async () => {
  for (const row of db.prepare('SELECT id FROM routines').all() as { id: string }[]) await unscheduleRoutine(row.id);
  mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test('R12 task mutations return plain titles without IDs and cannot claim a missing task was updated', async () => {
  const made = await run('create_task', { title: 'Task fixture 1' });
  const task = db.prepare('SELECT * FROM tasks WHERE bot_id=?').get(bot.id) as any;
  assert.equal(made.output, `Created the task "Task fixture 1".`);
  assert.doesNotMatch(String(made.output), /\bID\b|revision|^\{/);
  for (const [state, label] of [['working', 'Working'], ['needs_input', 'Needs input'], ['done', 'Done']]) {
    const updated = await run('update_task', { task_id: task.id, state });
    assert.equal(updated.output, `Updated the task "Task fixture 1". Status: ${label}.`);
    assert.equal((db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id) as any).state, state);
  }
  assert.equal((await run('update_task', { task_id: 'task_missing', state: 'done' })).isError, true);
  const denied = await toolMap.get('update_task')!.impl({ task_id: task.id, state: 'working' }, { ...ctx, botId: other.id });
  assert.equal(denied.isError, true);
  assert.equal((db.prepare('SELECT state FROM tasks WHERE id=?').get(task.id) as any).state, 'done');
});

test('R12 routine and check-in mutations return plain confirmations with schedule or paused state', async () => {
  const made = await run('create_routine', { name: 'Routine fixture', prompt: 'Summarize fixture notes', schedule: '0 9 * * *', timezone: 'UTC' });
  const routine = db.prepare('SELECT * FROM routines WHERE bot_id=?').get(bot.id) as any;
  assert.equal(made.output, `Created the routine "Routine fixture". Schedule: Every day at 9:00 AM (UTC).`);
  const changed = await run('update_routine', { routine_id: routine.id, name: 'Paused fixture', enabled: false });
  assert.equal(changed.output, `Updated the routine "Paused fixture". The routine is paused.`);
  assert.equal((await run('set_checkins', { enabled: false })).output, 'Check-ins are off.');
  assert.equal((await run('set_checkins', { enabled: true, times: ['09:00'], timezone: 'UTC' })).output, 'Check-ins are on at 09:00 (UTC).');
});

test('R13 saved files return a Library link and filename while list_deliverables retains delivery handles', async () => {
  const saved = await run('save_file', { filename: 'fixture report.md', content: '# Fixture report' });
  assert.match(String(saved.output), /^Saved fixture_report.md to your Library\. \[View saved files\]\(http:\/\/localhost:5173\/#reports\)$/);
  assert.doesNotMatch(String(saved.output), /\/api\/deliverables|\bID\b|revision/);
  assert.equal(stripInternalIds(String(saved.output)), saved.output);
  assert.equal(redactInternalIds(String(saved.output)), saved.output);
  const artifact = listArtifacts(ctx.userId, bot.id).find(a => a.filename === 'fixture_report.md')!;
  assert.equal(readArtifact(ctx.userId, artifact.id).content.toString(), '# Fixture report');
  const listed = JSON.parse(String((await run('list_deliverables', {})).output));
  assert.ok(listed.artifacts.some((a: any) => a.id === artifact.id));
});

test('R13 memory confirmations distinguish saved, duplicate, forgotten and suppressed facts without handles', async () => {
  const source = appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'My fixture color is green.' });
  const args = { text: 'My fixture color is green.', evidence: [{ botId: bot.id, generation: source.generation, seq: source.seq }] };
  assert.equal((await run('remember', args)).output, 'Saved to memory: My fixture color is green.');
  assert.equal((await run('remember', args)).output, 'This fact is already saved in memory.');
  const { memories } = JSON.parse(String((await run('recall', { query: 'fixture color' })).output));
  assert.equal((await run('forget_memory', { memory_id: memories[0].id, expected_revision: memories[0].revision })).output, 'Forgot the saved memory.');
  assert.equal((await run('remember', args)).output, 'This fact was not saved because it was previously forgotten or replaced.');
});

test('R13 display redaction reproduces legacy placeholders and leaves plain task confirmations intact', async () => {
  assert.equal(stripInternalIds('Its ID is task_AbCdEf123456.'), 'Its ID is task.');
  assert.equal(stripInternalIds('(ID skl_AbCdEf123456, revision 1)'), '(ID skill, revision 1)');
  assert.equal(stripInternalIds('/api/deliverables/artifacts/artifact_AbCdEf123456/download'), '/api/deliverables/artifacts/file/download');
  const { output } = await run('create_task', { title: 'Readable fixture task' });
  assert.equal(stripInternalIds(String(output)), output);
  assert.equal(redactInternalIds(String(output)), output);
});

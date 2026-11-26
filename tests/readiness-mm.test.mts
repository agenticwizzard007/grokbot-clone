import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('fixture', 'fixture@example.test', 'Fixture account', Date.now());
const bot = createBot('fixture', { name: 'Fixture Bot', isPrimary: true });
const other = createBot('fixture', { name: 'Other Bot' });
const ctx = { userId: 'fixture', botId: bot.id, depth: 0, enqueueBotMessage() {} };
const run = (name: string, args: any) => toolMap.get(name)!.impl(args, ctx);
after(async () => {
  for (const row of db.prepare('SELECT id FROM routines').all() as { id: string }[]) await unscheduleRoutine(row.id);
  mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true });
});

test('R12 task mutations return plain titles and full IDs and cannot claim a missing task was updated', async () => {
  const made = await run('create_task', { title: 'Task fixture 1' });
  const task = db.prepare('SELECT * FROM tasks WHERE bot_id=?').get(bot.id) as any;
  assert.equal(made.output, `Created the task "Task fixture 1". Task ID: ${task.id}.`);
  assert.doesNotMatch(String(made.output), /\(ID task\)|^\{/);
  for (const [state, label] of [['working', 'Working'], ['needs_input', 'Needs input'], ['done', 'Done']]) {
    const updated = await run('update_task', { task_id: task.id, state });
    assert.equal(updated.output, `Updated the task "Task fixture 1". Status: ${label}. Task ID: ${task.id}.`);
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
  assert.equal(made.output, `Created the routine "Routine fixture". Routine ID: ${routine.id}. Schedule: 0 9 * * * (UTC).`);
  const changed = await run('update_routine', { routine_id: routine.id, name: 'Paused fixture', enabled: false });
  assert.equal(changed.output, `Updated the routine "Paused fixture". Routine ID: ${routine.id}. The routine is paused.`);
  assert.equal((await run('set_checkins', { enabled: false })).output, 'Check-ins are off.');
  assert.equal((await run('set_checkins', { enabled: true, times: ['09:00'], timezone: 'UTC' })).output, 'Check-ins are on at 09:00 (UTC).');
});

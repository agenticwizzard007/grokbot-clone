import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserRecovery, browserBlocker } from '../server/src/agent/browser-recovery.js';
import { waitForBrowserAccess } from '../server/src/agent/browser-access.js';
import type { BrowserResult } from '../server/src/computers/types.js';

const page = (body: string, url = 'https://example.test/account'): BrowserResult => ({
  isError: false, content: [{ type: 'text', text: `### Page\n- Page URL: ${url}\n### Snapshot\n\`\`\`yaml\n${body}\n\`\`\`` }],
});
const login = page('- heading "Sign in" [level=1]\n- textbox "Email" [ref=e1]\n- textbox "Password" [ref=e2]\n- button "Continue" [ref=e3]');
const dashboard = page('- heading "Dashboard" [level=1]\n- button "Export report" [ref=e10]');
const failure: BrowserResult = { isError: true, content: [{ type: 'text', text: '### Error\nTimeout waiting for element' }] };
const args = { target: 'e3', element: 'Continue' };

test('recognizes access gates and dialogs without mistaking ordinary sign-in links or article text', () => {
  assert.equal(browserBlocker(login), 'login');
  assert.equal(browserBlocker(page('- textbox "Verification code" [ref=e4]')), 'verification');
  assert.equal(browserBlocker(page('- heading "Check your phone" [level=1]')), 'verification');
  assert.equal(browserBlocker(page('- dialog "Cookie preferences" [ref=e5]\n  - button "Reject optional"')), 'dialog');
  assert.equal(browserBlocker({ isError: false, content: [{ type: 'text', text: '### Modal state\n- ["confirm" dialog with message "Delete?"]: can be handled by browser_handle_dialog' }] }), 'dialog');
  assert.equal(browserBlocker(page('- heading "Password security guide"\n- paragraph: Sign in with your password.\n- link "Sign in"')), null);
  assert.equal(browserBlocker({ isError: false, content: [{ type: 'text', text: '### Ran Playwright code\nheading "Sign in" textbox "Password"' }] }), null);
  assert.equal(browserBlocker({ ...dashboard, captcha: { kind: 'reCAPTCHA', url: 'https://example.test' } }), 'captcha');
});

test('bounds identical ineffective actions, ignores changing labels/refs, and resets on actual page progress', () => {
  const recovery = new BrowserRecovery();
  recovery.observe('browser_snapshot', {}, login);
  assert.equal(recovery.observe('browser_click', args, login).replan, true);
  recovery.observe('browser_click', { ...args, element: 'Try again' }, page('- heading "Sign in" [level=1]\n- textbox "Email" [ref=e11]\n- textbox "Password" [ref=e12]\n- button "Continue" [ref=e13]'));
  assert.equal(recovery.blocked('browser_click', args), true);
  for (let i = 0; i < 5; i++) recovery.observe('browser_snapshot', {}, login);
  assert.equal(recovery.blocked('browser_click', args), true);
  assert.equal(recovery.blocked('browser_snapshot', {}), false);
  recovery.observe('browser_snapshot', {}, dashboard);
  assert.equal(recovery.blocked('browser_click', args), false);
});

test('failed actions stay bounded across successful observations of an unchanged page', () => {
  const recovery = new BrowserRecovery();
  recovery.observe('browser_snapshot', {}, dashboard);
  recovery.observe('browser_click', args, failure);
  recovery.observe('browser_snapshot', {}, dashboard);
  recovery.observe('browser_click', args, failure);
  recovery.observe('browser_snapshot', {}, dashboard);
  assert.equal(recovery.blocked('browser_click', args), true);
  assert.equal(new BrowserRecovery().blocked('browser_click', args), false, 'budgets are per turn/Bot');
});

test('access monitoring ignores errors and blank pages and requires two clear observations', async () => {
  const sequence = [login, dashboard, failure, page('', 'about:blank'), dashboard, dashboard];
  let reads = 0, notices = 0;
  const result = await waitForBrowserAccess({ read: async () => sequence[reads++]!, onWaiting: () => notices++, timeoutMs: 1000, pollMs: 1, resumeWhen: 'Dashboard' });
  assert.equal(result.status, 'cleared');
  assert.equal(reads, 6);
  assert.equal(notices, 1);
});

test('a wrong destination never satisfies the expected completion marker', async () => {
  let reads = 0;
  const result = await waitForBrowserAccess({ read: async () => reads++ ? page('- heading "Public home page"') : login, onWaiting() {}, timeoutMs: 35, pollMs: 1, resumeWhen: 'Dashboard' });
  assert.equal(result.status, 'timeout');
});

test('unrecognized screens ask for an explicit completion condition; one can monitor unfamiliar auth', async () => {
  const unfamiliar = page('- heading "Use your security key"');
  let notices = 0, reads = 0;
  const first = await waitForBrowserAccess({ read: async () => unfamiliar, onWaiting: () => notices++, timeoutMs: 100 });
  assert.equal(first.status, 'unrecognized');
  assert.equal(notices, 0);
  const second = await waitForBrowserAccess({ read: async () => reads++ ? dashboard : unfamiliar, onWaiting: () => notices++, timeoutMs: 1000, pollMs: 1, resumeWhen: 'Dashboard' });
  assert.equal(second.status, 'cleared');
  assert.equal(notices, 1);
});

test('stopping cancels an in-flight browser observation and cannot report success', async () => {
  const controller = new AbortController();
  let reads = 0;
  const pending = waitForBrowserAccess({ read: async () => {
    if (!reads++) return login;
    controller.abort();
    return new Promise<BrowserResult>(() => {});
  }, onWaiting() {}, signal: controller.signal, timeoutMs: 1000, pollMs: 1 });
  assert.equal((await pending).status, 'aborted');
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-browser-recovery-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'isolated-browser-recovery',
  COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', DIRECT_API_KEY: 'test', OPENROUTER_API_KEY: '',
  BROWSER_ACCESS_WAIT_MIN: '0.001', CAPTCHA_AUTOPASS_SEC: '0', CAPTCHA_WAIT_MIN: '0',
});
const { computers } = await import('../server/src/computers/index.js');
const { TOOLS } = await import('../server/src/agent/tools.js');
const { db } = await import('../server/src/db.js');
const { createBot } = await import('../server/src/bots.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
const { listRows, loadHistory, getLive } = await import('../server/src/store.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { enqueue, settleAgentJobs } = await import('../server/src/agent/loop.js');
initSubagents(); initRooms();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('recovery-owner', 'recovery@example.test', 'Recovery', Date.now());
const bot = () => createBot('recovery-owner', { name: 'Recover', isPrimary: true });
const ctx = (id: string) => ({ userId: 'recovery-owner', botId: id, depth: 0, enqueueBotMessage() {}, recovery: new BrowserRecovery() });
after(async () => { await settleAgentJobs(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('tool skips a third ineffective click, but rechecks and allows it after external progress', async t => {
  let current = login;
  const calls: string[] = [];
  const computer = mock.method(computers, 'screen', async () => ({ browser: async (name: string) => { calls.push(name); return current; } }) as any);
  t.after(() => computer.mock.restore());
  const click = TOOLS.find(t => t.name === 'browser_click')!;
  const context = ctx(bot().id);
  await click.impl(args, context); await click.impl(args, context);
  const skipped = await click.impl(args, context);
  assert.match(String(skipped.output), /Skipped an action/);
  assert.deepEqual(calls, ['browser_click', 'browser_click', 'browser_snapshot']);
  current = dashboard;
  await click.impl(args, context);
  assert.deepEqual(calls.slice(-2), ['browser_snapshot', 'browser_click']);
});

test('login handoff saves a checkpoint and link, times out once, and releases waiting state', async t => {
  const calls: string[] = [];
  const computer = mock.method(computers, 'screen', async () => ({ browser: async (name: string) => { calls.push(name); return login; } }) as any);
  t.after(() => computer.mock.restore());
  const b = bot();
  const result = await TOOLS.find(t => t.name === 'wait_for_browser_access')!.impl({ reason: 'Please sign in to the reports account.', checkpoint: 'Collected sources; next export the report.' }, ctx(b.id));
  assert.equal(result.endTurn, true);
  assert.equal(getLive(b.id).awaiting, null);
  const messages = listRows(b.id).map(r => (r.body as any).text ?? '').join('\n');
  assert.match(messages, /\?screen=bot_/);
  assert.match(messages, /Collected sources; next export the report/);
  assert.match(messages, /reply here to continue/);
  assert.ok(calls.every(name => name === 'browser_snapshot'));
});

const call = (id: string, name: string, args: unknown) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
async function runBatch(t: any, output: any[], browser: (name: string) => Promise<BrowserResult>) {
  const b = bot();
  let rounds = 0;
  const computer = mock.method(computers, 'screen', async () => ({ browser }) as any);
  const provider = mock.method(llmClient(360_000).responses, 'create', async () => (async function* () {
    yield { type: 'response.completed', response: { output: rounds++ ? [] : output } };
  })());
  t.after(() => { computer.mock.restore(); provider.mock.restore(); });
  enqueue(b.id, { type: 'user', text: 'Export the report, recover from interruptions if needed.' });
  await settleAgentJobs();
  return { id: b.id, rounds, rows: listRows(b.id), history: loadHistory(b.id) };
}

test('a login redirect drops queued stale actions and gives the model the new page', async t => {
  const actions: string[] = [];
  const run = await runBatch(t, [call('navigate', 'browser_navigate', { url: 'https://example.test/report' }), call('stale', 'browser_click', args)], async name => { actions.push(name); return login; });
  assert.deepEqual(actions, ['browser_navigate']);
  assert.equal(run.rounds, 2, 'the model gets another turn to recover');
  assert.match(String(run.history.find((item: any) => item.type === 'function_call_output' && item.call_id === 'stale')?.output), /fresh plan/);
});

test('ask_user ends the whole batch, preventing later actions and further model calls', async t => {
  const actions: string[] = [];
  const run = await runBatch(t, [call('question', 'ask_user', { question: 'Which account?', options: ['Work', 'Personal'] }), call('stale', 'browser_click', args)], async name => { actions.push(name); return dashboard; });
  assert.deepEqual(actions, []);
  assert.equal(run.rounds, 1);
  assert.equal(run.rows.filter(r => r.body.type === 'card' && r.body.card === 'question').length, 1);
});

test('browser RPC failures discard stale follow-up submissions', async t => {
  const actions: string[] = [];
  const run = await runBatch(t, [call('first', 'browser_click', args), call('second', 'browser_click', { target: 'e4' })], async name => { actions.push(name); throw new Error('Browser disconnected'); });
  assert.deepEqual(actions, ['browser_click']);
  assert.equal(run.rounds, 2);
});

test('an access-monitor failure also cancels preplanned actions', async t => {
  const actions: string[] = [];
  const run = await runBatch(t, [call('wait', 'wait_for_browser_access', { reason: 'Sign in.', checkpoint: 'Sources saved; export next.' }), call('stale', 'browser_click', args)], async name => { actions.push(name); throw new Error('Browser disconnected'); });
  assert.deepEqual(actions, ['browser_snapshot']);
  assert.equal(run.rounds, 2);
});

test('an unresolved CAPTCHA ends the turn and never executes queued actions', async t => {
  const b = bot();
  const computer = mock.method(computers, 'screen', async () => ({ browser: async () => ({ ...login, captcha: { kind: 'reCAPTCHA', url: 'https://example.test' } }), captcha: async () => ({ kind: 'reCAPTCHA', url: 'https://example.test' }) }) as any);
  t.after(() => computer.mock.restore());
  const result = await TOOLS.find(t => t.name === 'browser_navigate')!.impl({ url: 'https://example.test' }, ctx(b.id));
  assert.equal(result.endTurn, true);
  assert.equal(result.replan, true);
  assert.equal(getLive(b.id).awaiting, null);
});

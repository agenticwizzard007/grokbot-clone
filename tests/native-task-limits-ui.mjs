// Run from the repository root: node tests/native-task-limits-ui.mjs
// Reuses the maintained Hermes seed, actual API/server, Vite UI and local provider.
// Application APIs are never intercepted. No real provider or delivery credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import Database from 'better-sqlite3';

const root = process.cwd();
const evidence = process.env.TASK_LIMITS_EVIDENCE_DIR ?? path.join(root, '.context/task-limits-final/browser');
fs.mkdirSync(evidence, { recursive: true });
for (const file of ['failure.png', 'failure.html', 'result.json']) fs.rmSync(path.join(evidence, file), { force: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-limits-ui-'));
const children = [], logs = [], modelRequests = [], apiEvidence = [], createdIds = [];
let browser, modelServer, evidenceDb;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const result = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return result;
}
const apiPort = await port(), uiPort = await port(), modelPort = await port(), fallbackPort = await port();
const apiBase = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${uiPort}`;
const fixtureFile = path.join(temp, 'fixture.json');
const env = {
  ...process.env, HERMES_SERVER_ROOT: root, HERMES_FIXTURE_FILE: fixtureFile,
  SWARM_ROLE: 'standalone', NODE_ENV: 'test', DB_PATH: path.join(temp, 'app.db'),
  FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'task-limits-browser-only',
  COMPUTER_PROVIDER: 'local', DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: base, SERVER_URL: base,
  DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
  OPENROUTER_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', COMPOSIO_API_KEY: '',
  LLM_PROVIDER: 'direct', SWARM_NO_SCHEDULER: '0', WHATSAPP_DISABLED: '1',
  ADMIN_EMAILS: '', ADMIN_PHONES: '', INKBOX_TUNNEL: '0',
};
function start(args, cwd = root, extra = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => logs.push(String(chunk)));
  return child;
}
async function run(args) {
  const child = start(args);
  assert.equal(await new Promise(resolve => child.on('exit', resolve)), 0, args.join(' '));
}
async function until(fn, label) {
  for (let i = 0; i < 300; i++) { if (await fn()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const cookie = 'swarm_session=experience-owner-token';
async function api(url, method = 'GET', body) {
  const response = await fetch(apiBase + '/api' + url, {
    method, headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${url}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
const dbGoals = () => evidenceDb.prepare('SELECT * FROM native_goals ORDER BY id').all();
const dbGoal = id => evidenceDb.prepare('SELECT * FROM native_goals WHERE id=?').get(id);
try {
  await run(['--import', 'tsx', 'tests/fixtures/hermes-experience.seed.mts']);
  // Store representative previous finite budgets before server startup. Both
  // provenance-unknown old defaults and explicit limits must survive startup.
  await run(['--import', 'tsx', '--input-type=module', '--eval', `
    import fs from 'node:fs';
    import { db } from './server/src/db.ts';
    import { createGoal, controlGoal } from './server/src/agent/goals.ts';
    const f = JSON.parse(fs.readFileSync(process.env.HERMES_FIXTURE_FILE, 'utf8'));
    f.legacyGoals = [10,23].map((maxTurns, i) => {
      const goal = createGoal(f.owner, f.quinn.id, {
        title: i ? 'Existing explicit finite budget' : 'Existing provenance-unknown finite budget',
        maxTurns, maxTokens: 12345, maxSpendUsd: 4,
        criteria: [{id:'retained',description:'Existing evidence criterion',kind:'row'}],
      });
      controlGoal(f.owner, goal.id, 'pause', 'Existing saved goal; preserve its budget.');
      db.prepare('UPDATE native_goals SET turns_used=? WHERE id=?').run(i+2,goal.id);
      return {id:goal.id,maxTurns};
    });
    fs.writeFileSync(process.env.HERMES_FIXTURE_FILE, JSON.stringify(f)); db.close();
  `]);
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  evidenceDb = new Database(env.DB_PATH, { readonly: true });
  const legacyBefore = dbGoals();
  start(['tests/mock-provider.mjs', String(fallbackPort)]);
  await until(() => fetch(`http://127.0.0.1:${fallbackPort}/v1/models`).then(r => r.ok).catch(() => false), 'local model');
  // Deterministic model decision uses the real ask_user tool to park each UI
  // goal at a human decision after one actual runtime turn, with no infinite
  // continuation loop. All other model endpoints reuse the maintained fixture.
  let seq = 0;
  modelServer = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const body = raw.length ? JSON.parse(raw.toString()) : {};
      const latest = [...(Array.isArray(body.input) ? body.input : [])].reverse().find(i => i.role === 'user');
      if (request.url.startsWith('/v1/responses') && JSON.stringify(latest?.content).includes('Work toward this native persistent goal.')) {
        assert.ok(body.tools?.some(t => t.name === 'ask_user'), 'real runtime advertises ask_user');
        modelRequests.push({ model: body.model, stream: body.stream, input: latest.content, tool: 'ask_user' });
        const item = { type: 'function_call', id: `fc_budget_${++seq}`, call_id: `call_budget_${seq}`, name: 'ask_user', arguments: JSON.stringify({ question: 'Budget qualification checkpoint: wait for the user.', options: ['Continue'] }), status: 'completed' };
        const result = { id: `resp_budget_${seq}`, object: 'response', model: body.model, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
        if (body.stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
          event('response.created', { response: { ...result, status: 'in_progress', output: [] } });
          event('response.output_item.added', { output_index: 0, item });
          event('response.output_item.done', { output_index: 0, item });
          event('response.completed', { response: result }); response.end();
        } else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result)); }
        return;
      }
      const upstream = await fetch(`http://127.0.0.1:${fallbackPort}${request.url}`, { method: request.method, headers: { 'content-type': 'application/json', authorization: 'Bearer mock-key' }, ...(raw.length ? { body: raw } : {}) });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers)); response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: String(error) } })); }
  });
  await new Promise(resolve => modelServer.listen(modelPort, '127.0.0.1', resolve));
  let server = start(['--import', 'tsx', 'server/src/index.ts']);
  await until(() => fetch(apiBase + '/api/health').then(r => r.ok).catch(() => false), 'real server');
  assert.deepEqual(dbGoals(), legacyBefore, 'startup preserves previous finite goals exactly');
  const criteria = [{ id: 'check', description: 'Budget acceptance evidence', kind: 'row' }];
  const omittedBody = { botId: fixture.quinn.id, title: 'API omitted turn budget', criteria, start: false };
  assert.equal(Object.hasOwn(omittedBody, 'maxTurns'), false);
  const omitted = (await api('/workflows/goals', 'POST', omittedBody)).goal;
  createdIds.push(omitted.id);
  assert.equal(omitted.maxTurns, 0); assert.equal(dbGoal(omitted.id).max_turns, 0);
  apiEvidence.push({ source: 'API omission', request: omittedBody, response: omitted, db: dbGoal(omitted.id) });
  console.log('PASS omitted API budget defaults to maxTurns=0 in response and real DB');
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort)], path.join(root, 'web'), { SWARM_API: apiBase });
  await until(() => fetch(base).then(r => r.ok).catch(() => false), 'actual UI');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'swarm_session', value: 'experience-owner-token', url: base }]);
  const page = await context.newPage(), errors = [], external = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => { if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url()); });
  page.setDefaultTimeout(15000);
  await page.goto(base);
  await page.locator('.sidebar').getByRole('button', { name: 'Tasks', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Goals and workflows', exact: true });
  const card = title => panel.locator('.workflow-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  for (const existing of fixture.legacyGoals) {
    const goal = (await api('/workflows')).goals.find(g => g.id === existing.id);
    assert.equal(goal.maxTurns, existing.maxTurns);
    await card(goal.title).getByText(`${goal.turnsUsed} / ${goal.maxTurns} turns`, { exact: false }).waitFor();
  }
  const cases = [
    { title: 'Untouched optional turn budget', bot: fixture.quinn, expected: 0 },
    { title: 'Explicit finite turn budget', bot: fixture.nia, expected: 7 },
    { title: 'Cleared optional turn budget', bot: fixture.ellis, expected: 0, clear: true },
  ];
  for (const entry of cases) {
    await panel.getByRole('button', { name: 'New goal', exact: true }).click();
    const field = panel.getByLabel('Maximum turns (optional)', { exact: true });
    assert.equal(await field.inputValue(), '', 'next form never inherits previous finite value');
    assert.equal(await field.getAttribute('placeholder'), 'No limit');
    assert.equal(await field.evaluate(el => el.required), false);
    assert.equal(await field.evaluate(el => el.checkValidity()), true, 'empty optional field passes native validation');
    await panel.getByRole('combobox', { name: /^Agent/ }).selectOption(entry.bot.id);
    await panel.getByLabel('Goal', { exact: true }).fill(entry.title);
    await panel.getByLabel('Acceptance checks', { exact: true }).fill('Budget acceptance evidence');
    if (entry.expected) await field.fill(String(entry.expected));
    if (entry.clear) { await field.fill('13'); await field.fill(''); }
    if (entry.expected) {
      await field.fill('0'); assert.equal(await field.evaluate(el => el.checkValidity()), false, 'explicit zero is below UI minimum');
      await field.fill(String(entry.expected));
    }
    await page.setViewportSize(entry.clear ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
    await page.locator(entry.clear ? '.app.is-mobile' : '.app:not(.is-mobile)').waitFor();
    await until(() => panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'goal UI fits viewport after responsive layout settles');
    await panel.locator('.workflow-create').screenshot({ path: path.join(evidence, entry.clear ? 'optional-form-mobile.png' : entry.expected ? 'finite-form-desktop.png' : 'optional-form-desktop.png'), animations: 'disabled' });
    const createdResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/workflows/goals' && r.request().method() === 'POST');
    await panel.getByRole('button', { name: 'Create and start', exact: true }).click();
    const response = await createdResponse;
    assert.equal(response.status(), 201);
    const payload = response.request().postDataJSON(), created = (await response.json()).goal;
    createdIds.push(created.id);
    assert.equal(payload.maxTurns, entry.expected); assert.equal(created.maxTurns, entry.expected);
    assert.equal(dbGoal(created.id).max_turns, entry.expected);
    await until(() => evidenceDb.prepare("SELECT 1 FROM native_workflow_runs WHERE goal_id=? AND status='waiting'").get(created.id), 'actual goal reaches real question tool');
    const saved = (await api('/workflows')).goals.find(g => g.id === created.id);
    assert.equal(saved.maxTurns, entry.expected); assert.equal(saved.turnsUsed, 1);
    await card(entry.title).getByText(entry.expected ? /1 \/ 7 turns/ : /1 turns · No turn limit/).waitFor();
    apiEvidence.push({ source: entry.title, request: payload, response: created, saved, db: dbGoal(created.id) });
    console.log(`PASS UI ${entry.title}: request/API/DB/display maxTurns=${entry.expected}, actual runtime turn=1`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.locator('.sidebar').getByRole('button', { name: 'Tasks', exact: true }).click();
  await panel.getByRole('heading', { name: cases[1].title, exact: true }).waitFor();
  await card(cases[1].title).getByText(/1 \/ 7 turns/).waitFor();
  await card(cases[2].title).getByText(/No turn limit/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.app.is-mobile').waitFor();
  await until(() => panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'saved goal cards fit mobile after responsive layout settles');
  await card(cases[1].title).screenshot({ path: path.join(evidence, 'saved-finite-mobile.png'), animations: 'disabled' });
  await card(cases[2].title).screenshot({ path: path.join(evidence, 'saved-unlimited-mobile.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await card(cases[1].title).screenshot({ path: path.join(evidence, 'saved-finite-desktop.png'), animations: 'disabled' });
  assert.deepEqual(legacyBefore.map(g => dbGoal(g.id)), legacyBefore, 'new omitted/blank goals leave existing finite rows unchanged');
  // Restart exercises the real schema/startup path and durable budget reads.
  const beforeRestart = dbGoals().map(g => ({ id: g.id, max_turns: g.max_turns }));
  server.kill(); await new Promise(resolve => server.on('exit', resolve));
  server = start(['--import', 'tsx', 'server/src/index.ts']);
  await until(() => fetch(apiBase + '/api/health').then(r => r.ok).catch(() => false), 'server restart');
  assert.deepEqual(dbGoals().map(g => ({ id: g.id, max_turns: g.max_turns })), beforeRestart);
  const afterRestart = (await api('/workflows')).goals;
  for (const expected of beforeRestart) assert.equal(afterRestart.find(g => g.id === expected.id).maxTurns, expected.max_turns);
  assert.deepEqual(legacyBefore.map(g => dbGoal(g.id)), legacyBefore);
  assert.equal(modelRequests.length, 3, 'exactly one deterministic real model turn per UI goal');
  assert.deepEqual(errors, [], 'no browser runtime errors');
  assert.deepEqual(external, [], 'browser makes no external network requests');
  const cleanup = [];
  for (const id of createdIds) {
    const stopped = (await api(`/workflows/goals/${id}/control`, 'POST', { action: 'stop', reason: 'Task-limit browser qualification finished; stop unfinished fixture work.' })).goal;
    assert.equal(stopped.status, 'cancelled');
    assert.equal(stopped.maxTurns, beforeRestart.find(g => g.id === id).max_turns);
    cleanup.push({ id, status: stopped.status, maxTurns: stopped.maxTurns });
  }
  assert.equal(evidenceDb.prepare("SELECT count(*) AS n FROM native_workflow_runs WHERE goal_id IN (SELECT id FROM native_goals WHERE status='cancelled') AND status IN ('queued','running','waiting')").get().n, 0, 'Stop settles unfinished runs');
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ status: 'passed', root, checks: ['API omission -> zero', 'untouched UI blank -> zero', 'typed then cleared -> zero', 'positive explicit seven -> API/DB/display', 'finite-to-blank form reset', 'existing finite ten and twenty-three unchanged', 'durable budgets after server restart', 'real ask_user execution', 'desktop and mobile', 'explicit Stop cleanup of all created goals'], apiEvidence, legacyBefore, beforeRestart, afterRestart, modelRequests, errors, external, cleanup }, null, 2));
  console.log('PASS real-server task-limit browser acceptance; existing finite budgets survive creation, reload and restart');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(evidence, 'failure.html'), await page.content());
  }
  console.error(logs.join('').slice(-7000)); throw error;
} finally {
  // A failed assertion must also stop accepted fixture goals before process/DB
  // disposal. Success checks the same controls and run settlement above.
  for (const id of createdIds) await api(`/workflows/goals/${id}/control`, 'POST', { action: 'stop', reason: 'Browser fixture cleanup.' }).catch(error => logs.push(`Cleanup ${id}: ${error}\n`));
  fs.writeFileSync(path.join(evidence, 'server.log'), logs.join(''));
  await browser?.close();
  evidenceDb?.close();
  for (const child of children) child.kill();
  modelServer?.closeAllConnections(); modelServer?.close();
  await sleep(300); fs.rmSync(temp, { recursive: true, force: true });
}

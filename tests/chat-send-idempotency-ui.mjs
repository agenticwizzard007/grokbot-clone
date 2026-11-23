// P-02: local Vite app, temporary SQLite, DEV_LOGIN, and synthetic model/toolkit backends.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const root = await mkdtemp(path.join(os.tmpdir(), 'chat-retry-ui-'));
const children = [];
let logs = '', browser, db;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
function start(args, env = {}, cwd = new URL('..', import.meta.url)) {
  const child = spawn(process.execPath, args, {
    cwd, env: { PATH: process.env.PATH, NODE_ENV: 'development', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
}
async function until(fn) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (children.some(child => child.exitCode !== null)) throw new Error(logs);
    if (await fn()) return;
    await delay(100);
  }
  throw new Error('Local chat retry test timed out');
}

try {
  const apiPort = await port(), mockPort = await port(), webPort = await port();
  const backend = `http://127.0.0.1:${apiPort}`, origin = `http://127.0.0.1:${webPort}`;
  start(['tests/mock-provider.mjs', String(mockPort)]);
  start(['--import', 'tsx', 'server/src/index.ts'], {
    SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'),
    SESSION_SECRET: 'chat-retry-test-only', DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local',
    PORT: String(apiPort), APP_URL: origin, SERVER_URL: backend,
    DIRECT_API_KEY: 'mock-key', DIRECT_BASE_URL: `http://127.0.0.1:${mockPort}/v1`,
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/api/v1`, COMPOSIO_API_KEY: '',
    LLM_PROVIDER: 'direct', SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1',
    MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', INKBOX_TUNNEL: '0',
  });
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
    { SWARM_API: backend }, new URL('../web', import.meta.url));
  await until(() => fetch(`${backend}/api/health`).then(r => r.ok, () => false));
  await until(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { errors.push('Unexpected external browser request'); return route.abort(); }
    if (url.pathname === '/api/apps') return route.fulfill({ json: { apps: [], connected: [], categories: [], total: 0 } });
    return route.continue();
  });
  async function api(url, method = 'GET', data) {
    const response = await page.request.fetch(`${origin}/api${url}`, { method, data });
    assert.equal(response.ok(), true, `${method} ${url}: ${response.status()}`);
    return response.json();
  }
  await api('/auth/dev', 'POST', { email: 'chat-retry@example.test', name: 'Retry QA' });
  db = new Database(path.join(root, 'test.db'));
  const members = [];
  for (const name of ['Receipt Bot', 'Support Bot']) {
    const { bot } = await api('/bots', 'POST', { name, avatarShape: 'blob', avatarColor: 'blue', mode: 'personal' });
    // Only the temporary fixture database is edited, to avoid setup model work in this test.
    db.prepare("UPDATE bot_setups SET onboarding_status='active', confirmed_at=? WHERE bot_id=?").run(Date.now(), bot.id);
    members.push(bot);
  }
  const room = await api('/rooms', 'POST', { name: 'Receipt group', botIds: members.map(bot => bot.id) });
  const fixtures = [members[0], { id: room.id, name: 'Receipt group' }];
  const userCount = id => db.prepare("SELECT count(*) n FROM rows WHERE bot_id=? AND json_extract(body,'$.role')='user'").get(id).n;
  const jobCount = id => db.prepare("SELECT count(*) n FROM agent_jobs WHERE (bot_id=? AND json_extract(trigger,'$.type')='user') OR json_extract(trigger,'$.roomId')=?").get(id, id).n;
  await page.goto(origin);

  for (const fixture of fixtures) {
    await page.locator('.bot-row').filter({ has: page.getByText(fixture.name, { exact: true }) }).click();
    const composer = page.getByRole('textbox', { name: `Message ${fixture.name}`, exact: true });
    const text = 'Summarize these local fixture notes.';
    const beforeRows = userCount(fixture.id), beforeJobs = jobCount(fixture.id);
    const endpoint = `**/api/bots/${fixture.id}/messages`;
    const bodies = [], receipts = [];
    let loseResponse = true;
    await page.route(endpoint, async route => {
      bodies.push(route.request().postDataJSON());
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      receipts.push(await response.json());
      if (loseResponse) return route.abort('failed');
      return route.fulfill({ response });
    });
    const submit = async () => { await composer.press('Enter'); };
    await composer.fill(text);
    await submit();
    await page.locator('.composer__error').waitFor();
    assert.equal(await composer.inputValue(), text);
    // Retry once without a reload, losing that response too.
    await submit();
    await until(async () => receipts.length === 2 && await page.locator('.composer__error').isVisible());
    assert.equal(bodies[0].submissionId, bodies[1].submissionId);
    // A reload must restore both the draft and its original ID.
    await page.reload();
    await page.locator('.bot-row').filter({ has: page.getByText(fixture.name, { exact: true }) }).click();
    await composer.waitFor();
    assert.equal(await composer.inputValue(), text);
    loseResponse = false;
    await submit();
    await until(async () => receipts.length === 3 && await composer.inputValue() === '');
    assert.equal(bodies[0].submissionId, bodies[2].submissionId);
    assert.deepEqual(receipts[1], receipts[0]);
    assert.deepEqual(receipts[2], receipts[0]);
    await until(() => Promise.resolve(db.prepare("SELECT count(*) n FROM agent_jobs WHERE state IN ('queued','running')").get().n === 0));
    assert.equal(userCount(fixture.id) - beforeRows, 1);
    assert.equal(jobCount(fixture.id) - beforeJobs, fixture.id === room.id ? 2 : 1);
    // After acknowledgement, identical text is a new intentional submission.
    await composer.fill(text);
    await submit();
    await until(async () => receipts.length === 4 && await composer.inputValue() === '');
    assert.notEqual(bodies[3].submissionId, bodies[0].submissionId);
    assert.equal(userCount(fixture.id) - beforeRows, 2);
    assert.equal(jobCount(fixture.id) - beforeJobs, fixture.id === room.id ? 4 : 2);
    await page.unroute(endpoint);
    await until(() => Promise.resolve(db.prepare("SELECT count(*) n FROM agent_jobs WHERE state IN ('queued','running')").get().n === 0));
  }
  assert.deepEqual(errors, []);
  console.log('P-02 browser checks passed for ordinary and group sends, lost responses, reloads and intentional repeated text.');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  db?.close();
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    const stopped = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([stopped, delay(3000)]);
    if (child.exitCode === null) { child.kill('SIGKILL'); await stopped; }
  }
  await rm(root, { recursive: true, force: true });
}

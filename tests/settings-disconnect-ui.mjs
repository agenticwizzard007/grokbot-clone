// Run: node tests/settings-disconnect-ui.mjs
// QA SO E-02: local Vite app, real API/auth, temporary SQLite, mocked providers only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const root = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-disconnect-'));
const evidence = path.join(root, '.context/settings-disconnect');
fs.mkdirSync(evidence, { recursive: true });
const children = [], logs = [];
let browser, db;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = net.createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
const apiPort = await port(), uiPort = await port();
const apiBase = `http://127.0.0.1:${apiPort}`, base = `http://127.0.0.1:${uiPort}`;
// Deliberately omit inherited provider credentials and deployment configuration.
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', SWARM_ROLE: 'standalone',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  SESSION_SECRET: 'disconnect-test-only', DEV_LOGIN: '1', COMPUTER_PROVIDER: 'local',
  COMPOSIO_API_KEY: 'mock-toolkit-only', DIRECT_API_KEY: 'mock-model-only',
  DIRECT_BASE_URL: 'http://model.invalid/v1', LLM_PROVIDER: 'direct',
  SWARM_NO_SCHEDULER: '1', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0',
  PORT: String(apiPort), APP_URL: base, SERVER_URL: base, SWARM_API: apiBase,
};
function start(args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data)));
}
async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    assert.ok(children.every(child => child.exitCode === null), 'fixture process exited');
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}
const ids = ['fixture-gmail-1', 'fixture-gmail-2'];
const records = () => db.prepare('SELECT id FROM fixture_accounts ORDER BY id').all().map(row => row.id);
const deletes = () => db.prepare('SELECT id FROM fixture_deletes').all().map(row => row.id);
try {
  start(['--import', 'tsx', 'tests/fixtures/settings-disconnect.server.mts']);
  await until(() => fetch(`${apiBase}/api/health`).then(r => r.ok, () => false), 'API startup');
  db = new Database(env.DB_PATH);
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'));
  await until(() => fetch(base).then(r => r.ok, () => false), 'Vite startup');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 1024, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email: 'disconnect@example.test', name: 'Test account' } });
    assert.equal(login.status(), 200);
    const { user } = await (await context.request.get(`${base}/api/auth/me`)).json();
    db.exec('DELETE FROM fixture_accounts; DELETE FROM fixture_deletes; UPDATE fixture_control SET fail = 0, hold = 0;');
    for (const id of ids) db.prepare('INSERT INTO fixture_accounts VALUES (?, ?)').run(id, user.id);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'DELETE') requests.push(new URL(request.url()).pathname); });
    await page.goto(`${base}/#settings/apps`);
    const accounts = page.getByRole('region', { name: 'Your connected accounts', exact: true });
    const row = id => accounts.locator('.cfg-row').filter({ has: page.getByTitle(`Connection ID: ${id}`, { exact: true }) });
    const button = (id, name) => row(id).getByRole('button', { name, exact: true });
    await button(ids[0], 'Disconnect').focus();
    await page.keyboard.press('Enter');
    await button(ids[0], 'Confirm disconnect').waitFor();
    await button(ids[0], 'Cancel').waitFor();
    assert.equal(await button(ids[0], 'Confirm disconnect').evaluate(element => element === document.activeElement), true, 'confirmation retains keyboard focus');
    assert.deepEqual(requests, [], 'first click sends no DELETE');
    assert.deepEqual(deletes(), []);
    assert.deepEqual(records(), ids);
    await page.keyboard.press('Tab');
    assert.equal(await button(ids[0], 'Cancel').evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    await button(ids[0], 'Disconnect').waitFor();
    assert.equal(await button(ids[0], 'Disconnect').evaluate(element => element === document.activeElement), true, 'Cancel restores focus to Disconnect');
    assert.deepEqual(requests, [], 'Cancel sends no DELETE');
    assert.deepEqual(records(), ids, 'Cancel preserves both accounts');

    // Moving to another row or leaving for the catalog must not retain an old confirmation.
    await button(ids[0], 'Disconnect').click();
    await button(ids[1], 'Disconnect').click();
    assert.equal(await accounts.getByRole('button', { name: 'Confirm disconnect', exact: true }).count(), 1);
    await button(ids[0], 'Disconnect').waitFor();
    await button(ids[1], 'Cancel').click();
    await button(ids[0], 'Disconnect').click();
    await page.getByRole('button', { name: 'Manage apps', exact: true }).click();
    await page.getByRole('button', { name: 'Back to connected accounts', exact: true }).click();
    await button(ids[0], 'Disconnect').waitFor();
    assert.deepEqual(requests, []);

    // A default-account request cancels pending disconnect confirmation.
    let releaseDefault;
    const defaultGate = new Promise(resolve => { releaseDefault = resolve; });
    await page.route('**/api/apps/connections/*/default', async route => {
      await defaultGate;
      await route.fulfill({ json: { ok: true } });
    });
    await button(ids[0], 'Disconnect').click();
    await button(ids[1], 'Use by default').click();
    await button(ids[0], 'Disconnect').waitFor();
    assert.equal(await accounts.getByRole('button', { name: 'Disconnecting…', exact: true }).count(), 0);
    assert.equal(await button(ids[0], 'Disconnect').isDisabled(), true);
    releaseDefault();
    await until(async () => !await button(ids[0], 'Disconnect').isDisabled(), 'default request completion');
    assert.deepEqual(requests, []);

    // Failure keeps the account, reports an error, and requires a new confirmation to retry.
    db.exec('UPDATE fixture_control SET fail = 1;');
    await button(ids[0], 'Disconnect').click();
    await button(ids[0], 'Confirm disconnect').click();
    await page.locator('.access-apps-settings').getByRole('alert').waitFor();
    await button(ids[0], 'Disconnect').waitFor();
    assert.deepEqual(deletes(), [ids[0]]);
    assert.deepEqual(records(), ids);
    db.exec('UPDATE fixture_control SET fail = 0, hold = 1;');
    await button(ids[0], 'Disconnect').click();
    assert.deepEqual(deletes(), [ids[0]], 'retry also requires confirmation');
    await button(ids[0], 'Confirm disconnect').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `confirm-${width}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // Dispatch two immediate clicks to exercise the existing in-flight request guard.
    await button(ids[0], 'Confirm disconnect').evaluate(element => { element.click(); element.click(); });
    await until(() => deletes().length === 2, 'confirmed delete');
    assert.equal(await button(ids[0], 'Disconnecting…').isDisabled(), true);
    assert.equal(await button(ids[0], 'Cancel').isDisabled(), true);
    assert.equal(await button(ids[1], 'Disconnect').isDisabled(), true);
    assert.deepEqual(records(), ids, 'held request has not removed anything');
    db.exec('UPDATE fixture_control SET hold = 0;');
    await row(ids[0]).waitFor({ state: 'hidden' });
    await button(ids[1], 'Disconnect').waitFor();
    assert.deepEqual(records(), [ids[1]], 'only the confirmed account is removed');
    assert.deepEqual(deletes(), [ids[0], ids[0]], 'one failed attempt and one successful attempt');
    assert.deepEqual(requests, [`/api/apps/connections/${ids[0]}`, `/api/apps/connections/${ids[0]}`]);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS QA SO E-02 at ${width}px: confirm, cancel, row switching, navigation, failure, retry, duplicate guard, exact account deletion`);
  }
} catch (error) {
  fs.writeFileSync(path.join(evidence, 'server.log'), logs.join(''));
  const page = browser?.contexts().flatMap(context => context.pages())[0];
  await page?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  }
  db?.close();
  fs.rmSync(temp, { recursive: true, force: true });
}

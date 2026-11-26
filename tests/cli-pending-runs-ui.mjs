// Official CLI binaries against local model/app fixtures and the real Settings rows.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-pending-ui-'));
const evidence = path.join(root, '.context/cli-pending-runs'); await fs.mkdir(evidence, { recursive: true });
async function port() { const s = http.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const n = s.address().port; await new Promise(r => s.close(r)); return n; }
const apiPort = await port(), uiPort = await port(), origin = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, SWARM_TEST_REAL_CLI: '1', NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, XAI_API_KEY: 'fixture', XAI_BASE_URL: 'https://model.fixture/v1', DIRECT_API_KEY: '', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: 'fixture', INKBOX_TUNNEL: '0' };
const children = [], logs = []; let browser, page;
function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const s of [child.stdout, child.stderr]) s.on('data', b => logs.push(String(b))); }
async function until(fn) { for (let n = 0; n < 600; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Fixture did not become ready'); }
try {
  start(['--import', 'tsx', 'tests/fixtures/cli-apps-server.mts']);
  await until(() => fetch(`http://127.0.0.1:${apiPort}/api/health`).then(r => r.ok, () => false));
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` });
  await until(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const provider of ['codex', 'claude']) for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    const request = async (url, data) => {
      const response = data === undefined ? await context.request.get(`${origin}/api${url}`) : await context.request.post(`${origin}/api${url}`, { data });
      assert.equal(response.status(), 200, await response.text()); return response.json();
    };
    await request('/auth/dev', { email: `${provider}-${width}-${theme}@example.test`, name: 'Fixture account' });
    const { bots } = await request('/bots'); const bot = bots.find(b => b.isPrimary);
    await request('/fixture/cli', { botId: bot.id, provider });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ id, theme }) => { localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.detailsOpen', '0'); localStorage.setItem('swarm.theme', theme); }, { id: bot.id, theme });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    if (width === 390) await page.locator('.pinned__tile').click();
    await request(`/bots/${bot.id}/messages`, { text: 'Create a draft in Gmail.' });
    const approval = page.locator('.approval-card'); await approval.waitFor();
    await until(async () => (await request('/cli')).runsByProvider[provider]?.lastToolRun?.result === 'pending_approval');
    const before = (await request('/cli')).runsByProvider[provider];
    const internal = await request('/fixture/internal', { botId: bot.id });
    assert.equal(internal.result, 'completed'); assert.equal(internal.last_tool, 'create_task');
    assert.deepEqual((await request('/cli')).runsByProvider[provider], before);
    const open = async () => {
      await page.evaluate(async provider => (await import('/src/configStore.ts')).useConfigUI.getState().openAppSettings('subscriptions', provider), provider);
      const details = page.locator('.subscription-settings__context');
      await details.locator('summary').click(); return details;
    };
    const close = () => page.evaluate(async () => (await import('/src/configStore.ts')).useConfigUI.getState().closeAppSettings());
    let details = await open();
    await details.getByText('Approval requested', { exact: true }).first().waitFor();
    assert.equal(await details.getByText('Approval requested', { exact: true }).count(), 2);
    assert.match(await details.innerText(), /Last CLI run[\s\S]*SWARM_APPS_EXECUTE[\s\S]*Approval requested[\s\S]*Last tool run[\s\S]*SWARM_APPS_EXECUTE[\s\S]*Approval requested/);
    assert.doesNotMatch(await details.innerText(), /Running|create_task/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await details.evaluate(e => e.scrollWidth <= e.clientWidth), true);
    await details.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `${provider}-${width}-${theme}-pending.png`), fullPage: true });
    await details.screenshot({ path: path.join(evidence, `${provider}-${width}-${theme}-rows.png`) });
    await close();
    const decision = theme === 'light' ? "Don't allow" : 'Allow';
    await approval.getByRole('button', { name: decision, exact: true }).click();
    await until(async () => { const r = (await request('/cli')).runsByProvider[provider].latest; return r.trigger === 'approval_decision' && r.result !== 'running'; });
    details = await open();
    await details.getByText('Reply after your decision', { exact: true }).waitFor();
    assert.doesNotMatch(await details.innerText(), /Running/);
    await details.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `${provider}-${width}-${theme}-decided.png`), fullPage: true });
    await close();
    await request('/fixture/internal', { botId: bot.id });
    const later = (await request('/cli')).runsByProvider[provider];
    assert.equal(later.latest.result, 'completed'); assert.equal(later.lastToolRun.lastTool, 'create_task');
    details = await open();
    await details.getByText('Completed', { exact: true }).first().waitFor();
    assert.equal(await details.getByText('Completed', { exact: true }).count(), 2);
    assert.doesNotMatch(await details.innerText(), /Approval requested|Running/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log(`PASS R13 ${provider} ${width} ${theme}: pending after internal completion, ${decision}, decision reply, later runs released`);
    await context.close();
  }
} catch (error) {
  console.error(logs.join('').slice(-8000));
  if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-5000)); await page.screenshot({ path: path.join(evidence, 'failure.png') }); }
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
  await fs.rm(tmp, { recursive: true, force: true });
}

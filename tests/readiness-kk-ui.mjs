// Local app, persisted rows and SSE. SWARM_TEST_REAL_CLI=1 uses official binaries
// with a local mock model endpoint. No live login or external app execution.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-apps-ui-'));
const evidence = path.join(root, '.context/readiness-kk'); await fs.mkdir(evidence, { recursive: true });
async function port() { const s = http.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const n = s.address().port; await new Promise(r => s.close(r)); return n; }
const apiPort = await port(), uiPort = await port(), origin = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, SWARM_TEST_REAL_CLI: '1', NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, XAI_API_KEY: 'fixture', XAI_BASE_URL: 'https://model.fixture/v1', DIRECT_API_KEY: '', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: 'fixture', INKBOX_TUNNEL: '0' };
const children = [], logs = []; let browser, page;
function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const s of [child.stdout, child.stderr]) s.on('data', b => logs.push(String(b))); return child; }
async function until(fn) { for (let n = 0; n < 300; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Fixture did not become ready'); }
try {
  start(['--import', 'tsx', 'tests/fixtures/cli-apps-server.mts']);
  await until(() => fetch(`http://127.0.0.1:${apiPort}/api/health`).then(r => r.ok, () => false));
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` });
  await until(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    assert.equal((await context.request.post(`${origin}/api/auth/dev`, { data: { email: `cli-${width}-${theme}@example.test`, name: 'Fixture account' } })).status(), 200);
    const { bots } = await (await context.request.get(`${origin}/api/bots`)).json();
    const bot = bots.find(b => b.isPrimary);
    await context.request.patch(`${origin}/api/bots/${bot.id}`, { data: { name: 'CLI fixture' } });
    bot.name = 'CLI fixture';
    await context.request.post(`${origin}/api/bots/${bot.id}/setup/skip`);
    const provider = 'codex';
    assert.equal((await context.request.post(`${origin}/api/fixture/cli`, { data: { botId: bot.id, provider } })).status(), 200);
    page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ id, theme }) => { localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.detailsOpen', '0'); localStorage.setItem('swarm.theme', theme); }, { id: bot.id, theme });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    if (width === 390) await page.locator('.pinned__tile').click();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const send = async text => assert.equal((await context.request.post(`${origin}/api/bots/${bot.id}/messages`, { data: { text } })).status(), 200);
    for (const [name, request] of [['remember', 'I prefer fixture memory checks. Remember this.'], ['save_file', 'Save a fixture file.'], ['create_task', 'Create a fixture task.']]) {
      await send(request);
      await until(async () => {
        const rows = (await (await context.request.get(`${origin}/api/bots/${bot.id}/rows`)).json()).rows ?? [];
        return rows.some(row => row.body.name === name && row.body.status === 'done');
      });
      assert.equal(await page.locator('.approval-card').count(), 0, `${name} must not ask`);
    }
    for (const [kind, request] of [['draft', 'Create a draft in Gmail.'], ['write', 'Do a fixture app write.']]) {
      await send(request);
      const approval = page.locator('.approval-card').filter({ has: page.getByRole('button', { name: "Don't allow", exact: true }) });
      await approval.waitFor();
      await approval.getByRole('button', { name: 'Always allow', exact: true }).waitFor();
      assert.equal(await approval.count(), 1);
      await approval.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(evidence, `${kind}-${width}-${theme}.png`), fullPage: true });
      await approval.getByRole('button', { name: "Don't allow", exact: true }).click();
      await until(async () => await page.locator('.approval-card').filter({ hasText: 'Not allowed' }).count() === (kind === 'draft' ? 1 : 2));
    }
    for (const scenario of ['active', 'expired', 'zero']) {
      await context.request.post(`${origin}/api/fixture/connections`, { data: { scenario } });
      await page.reload();
      await page.waitForFunction(async () => !!(await import('/src/store.ts')).useStore.getState().user);
      await page.evaluate(async () => (await import('/src/configStore.ts')).useConfigUI.getState().openAppSettings('apps'));
      const settings = page.locator('.access-apps-settings');
      await settings.getByText(scenario === 'zero' ? 'No apps connected yet' : '1 app connected', { exact: true }).waitFor();
      const snapshot = await (await context.request.get(`${origin}/api/apps/connections`)).json();
      assert.equal(snapshot.connectedCount, scenario === 'zero' ? 0 : 1);
      assert.equal(snapshot.connections.length, scenario === 'zero' ? 0 : scenario === 'expired' ? 2 : 1);
      if (scenario === 'expired') {
        await settings.getByText('Expired connections (1)', { exact: true }).click();
        await settings.getByText('Needs reconnecting', { exact: true }).waitFor();
      } else assert.equal(await settings.getByText('Needs reconnecting', { exact: true }).count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(evidence, `settings-${scenario}-${width}-${theme}.png`), fullPage: true });
      if (scenario === 'expired') {
        await settings.getByText('Needs reconnecting', { exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, `settings-expired-status-${width}-${theme}.png`), fullPage: true });
      }
    }
    await context.request.post(`${origin}/api/fixture/connections`, { data: { scenario: 'all' } });
    const state = await (await context.request.get(`${origin}/api/fixture/state`)).json();
    assert.deepEqual(state.executions, []); assert.deepEqual(state.external, []); assert.deepEqual(errors, []);
    console.log(`PASS Codex ${width} ${theme}: memory/file/task free, draft/write cards, Active/expired/zero Settings counts`);
    await context.close();
  }
} catch (error) { console.error(logs.join('').slice(-6000)); if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-3000)); await page.screenshot({ path: path.join(evidence, 'failure.png') }); } throw error; }
finally { await browser?.close(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } await fs.rm(tmp, { recursive: true, force: true }); }

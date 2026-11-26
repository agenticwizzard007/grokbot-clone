import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'api-approval-ui-'));
const evidence = path.join(root, '.context/api-approval-ui'); await fs.mkdir(evidence, { recursive: true });
async function port() { const server = http.createServer().listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(r => server.close(r)); return value; }
const apiPort = await port(), uiPort = await port(), origin = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, DIRECT_API_KEY: 'fixture', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: 'fixture', INKBOX_TUNNEL: '0' };
const children = [], logs = []; let browser, page;
function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', b => logs.push(String(b))); return child; }
async function until(fn) { for (let n = 0; n < 300; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Fixture did not become ready'); }
try {
  start(['--import', 'tsx', 'tests/fixtures/api-approval-server.mts']);
  await until(() => fetch(`http://127.0.0.1:${apiPort}/api/health`).then(r => r.ok, () => false));
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` });
  await until(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    assert.equal((await context.request.post(`${origin}/api/auth/dev`, { data: { email: `fixture-${width}-${theme}@example.test`, name: 'Fixture account' } })).status(), 200);
    const { bots } = await (await context.request.get(`${origin}/api/bots`)).json();
    const bot = bots.find(b => b.isPrimary);
    await context.request.post(`${origin}/api/bots/${bot.id}/setup/skip`);
    page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ id, theme }) => { localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.detailsOpen', '0'); localStorage.setItem('swarm.theme', theme); }, { id: bot.id, theme });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    if (width === 390) await page.locator('.pinned__tile').click();
    const settings = async section => { await page.evaluate(async section => (await import('/src/configStore.ts')).useConfigUI.getState().openAppSettings(section), section); await page.getByLabel('API approval level', { exact: true }).waitFor(); };
    const closeSettings = () => page.evaluate(async id => { const ui = await import('/src/configStore.ts'); ui.useConfigUI.getState().closeAppSettings(); ui.openConversation(id); }, bot.id);
    const state = async () => (await context.request.get(`${origin}/api/fixture/state`)).json();
    const send = async text => assert.equal((await context.request.post(`${origin}/api/bots/${bot.id}/messages`, { data: { text } })).status(), 200);
    const select = () => page.getByLabel('API approval level', { exact: true });
    await settings('permissions'); await until(() => select().isEnabled());
    assert.equal(await select().inputValue(), 'standard');
    await select().selectOption('every_action'); await until(async () => (await (await context.request.get(`${origin}/api/account/preferences`)).json()).apiApprovalLevel === 'every_action');
    await page.getByText('Every action asks first', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidence, `permissions-${width}-${theme}.png`), fullPage: true });
    await settings('subscriptions'); await until(async () => await select().inputValue() === 'every_action');
    await select().scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(evidence, `models-${width}-${theme}.png`), fullPage: true });
    await closeSettings();
    const before = await state();
    for (const text of ['JJ memory: My fixture color preference is green.', 'JJ file', 'JJ app']) {
      await send(text);
      const pending = page.locator('.approval-card').filter({ has: page.getByRole('button', { name: "Don't allow", exact: true }) });
      await pending.waitFor();
      assert.equal((await state()).files, before.files); assert.equal((await state()).memories, before.memories); assert.equal((await state()).executions, before.executions);
      await pending.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(evidence, `card-${text.split(' ')[1].replace(':', '')}-${width}-${theme}.png`), fullPage: true });
      await pending.getByRole('button', { name: "Don't allow", exact: true }).click();
      await until(async () => (await state()).pending === 0);
    }
    await send('JJ search the web'); await page.getByText('Provider search is unavailable while Ask before every action is on.', { exact: false }).first().waitFor();
    assert.deepEqual(await state(), before, 'all denied actions remain undone');
    await settings('permissions'); await select().selectOption('standard'); await until(async () => (await (await context.request.get(`${origin}/api/account/preferences`)).json()).apiApprovalLevel === 'standard'); await closeSettings();
    await send('JJ memory: My fixture breakfast preference is oats.'); await until(async () => (await state()).memories > before.memories);
    await send('JJ file'); await until(async () => (await state()).files > before.files);
    await send('JJ app'); await until(async () => (await state()).executions > before.executions);
    assert.equal((await state()).pending, 0);
    await context.request.post(`${origin}/api/fixture/cli`, { data: { botId: bot.id, provider: theme === 'light' ? 'codex' : 'claude' } });
    for (const section of ['permissions', 'subscriptions']) {
      await settings(section); await page.getByText('This applies when you use API providers.', { exact: false }).waitFor(); assert.equal(await select().isDisabled(), true); await closeSettings();
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${width} ${theme}: both settings, max cards, denied actions unchanged, search disabled, Standard automatic, CLI disabled`);
    await context.close();
  }
} catch (error) { console.error(logs.join('').slice(-6000)); if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-4000)); await page.screenshot({ path: path.join(evidence, 'failure.png') }); } throw error; }
finally { await browser?.close(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } await fs.rm(tmp, { recursive: true, force: true }); }

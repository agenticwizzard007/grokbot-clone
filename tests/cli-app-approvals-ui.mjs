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
import { emailBody } from './fixtures/cli-apps-runner.mjs';
const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-apps-ui-'));
const evidence = path.join(root, '.context/cli-apps-ui'); await fs.mkdir(evidence, { recursive: true });
async function port() { const s = http.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const n = s.address().port; await new Promise(r => s.close(r)); return n; }
const apiPort = await port(), uiPort = await port(), origin = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, SWARM_TEST_REAL_CLI: process.env.SWARM_TEST_REAL_CLI ?? '0', NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, XAI_API_KEY: 'fixture', XAI_BASE_URL: 'https://model.fixture/v1', DIRECT_API_KEY: '', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: 'fixture', INKBOX_TUNNEL: '0' };
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
    const provider = theme === 'light' ? 'codex' : 'claude';
    assert.equal((await context.request.post(`${origin}/api/fixture/cli`, { data: { botId: bot.id, provider } })).status(), 200);
    page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ id, theme }) => { localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.detailsOpen', '0'); localStorage.setItem('swarm.theme', theme); }, { id: bot.id, theme });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(origin);
    if (width === 390) await page.locator('.pinned__tile').click();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const send = async text => assert.equal((await context.request.post(`${origin}/api/bots/${bot.id}/messages`, { data: { text } })).status(), 200);
    await send('Return a plain reply with 16 lines.');
    const plain = page.locator('.md p').filter({ hasText: 'Email line 1\n' });
    await plain.waitFor();
    assert.equal(await plain.innerText(), emailBody);
    assert.equal((await plain.innerText()).split('\n').length, 16);
    assert.ok(await plain.evaluate(e => e.getBoundingClientRect().height >= parseFloat(getComputedStyle(e).lineHeight) * 16 - 1), 'All 16 lines occupy separate rendered lines');
    await send('Create a draft in Gmail with 16 lines.');
    const approval = page.locator('.approval-card'); await approval.waitFor();
    assert.equal(await approval.count(), 1);
    const body = approval.locator('.tool-preview__text');
    assert.equal(await body.textContent(), emailBody);
    await approval.getByRole('button', { name: 'Show full', exact: true }).click();
    assert.equal(await body.innerText(), emailBody);
    assert.ok(await body.evaluate(e => e.getBoundingClientRect().height >= parseFloat(getComputedStyle(e).lineHeight) * 16 - 1));
    assert.equal(await body.evaluate(e => e.scrollHeight <= e.clientHeight + 1), true);
    assert.equal(await approval.locator('details').getAttribute('open'), null);
    assert.ok((await approval.innerText()).includes('test@example.com'));
    await approval.locator('summary').click();
    assert.ok((await approval.locator('pre').innerText()).includes('GMAIL_CREATE_EMAIL_DRAFT'));
    await approval.locator('summary').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await approval.evaluate(e => e.scrollWidth <= e.clientWidth), true);
    await approval.evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(evidence, `pending-${width}-${theme}.png`), fullPage: true });
    await approval.screenshot({ path: path.join(evidence, `card-${width}-${theme}.png`) });
    await approval.getByRole('button', { name: "Don't allow", exact: true }).click();
    await approval.getByText('Not allowed', { exact: true }).waitFor();
    await page.reload();
    if (width === 390 && await page.locator('.pinned__tile').isVisible()) await page.locator('.pinned__tile').click();
    await approval.getByText('Not allowed', { exact: true }).waitFor();
    assert.equal(await approval.count(), 1);
    const state = await (await context.request.get(`${origin}/api/fixture/state`)).json();
    assert.deepEqual(state.executions, []); assert.deepEqual(state.external, []); assert.deepEqual(errors, []);
    console.log(`PASS ${provider} ${width} ${theme}: CLI card via SSE, 16 chat and preview lines, Details, denial, reload, no overflow`);
    await context.close();
  }
} catch (error) { console.error(logs.join('').slice(-6000)); if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-3000)); await page.screenshot({ path: path.join(evidence, 'failure.png') }); } throw error; }
finally { await browser?.close(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } await fs.rm(tmp, { recursive: true, force: true }); }

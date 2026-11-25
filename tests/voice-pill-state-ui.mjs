// Real local chat persistence, SSE, approvals and voice controller. Fake providers only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-pill-ui-'));
const evidence = path.join(root, '.context/voice-pill-state'); await fs.mkdir(evidence, { recursive: true });
async function port() { const s = http.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const n = s.address().port; await new Promise(r => s.close(r)); return n; }
const apiPort = await port(), uiPort = await port(), origin = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, XAI_API_KEY: 'fixture', XAI_BASE_URL: 'https://model.fixture/v1', DIRECT_API_KEY: 'fixture', DIRECT_BASE_URL: 'https://model.fixture/v1', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: 'fixture', INKBOX_TUNNEL: '0' };
const children = [], logs = []; let browser, page;
function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const s of [child.stdout, child.stderr]) s.on('data', b => logs.push(String(b))); return child; }
async function until(fn) { for (let n = 0; n < 250; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Fixture did not become ready'); }
try {
  start(['--import', 'tsx', 'tests/fixtures/voice-chat-server.mts']);
  await until(() => fetch(`http://127.0.0.1:${apiPort}/api/health`).then(r => r.ok, () => false));
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` });
  await until(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' });
    const api = async (url, data) => {
      const response = await context.request.post(`${origin}/api${url}`, { data });
      assert.equal(response.status(), 200, `${url}: ${await response.text()}`); return response.json();
    };
    await api('/auth/dev', { email: `fixture-${width}-${theme}@example.test`, name: 'Fixture account' });
    const { bot } = await api('/bots', { name: 'Voice fixture' });
    await api(`/bots/${bot.id}/setup/skip`);
    const errors = [];
    await context.addInitScript(({ id, theme }) => { localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.detailsOpen', '0'); localStorage.setItem('swarm.theme', theme); }, { id: bot.id, theme });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    page = await context.newPage(); page.setDefaultTimeout(20000);
    const second = await context.newPage(); second.setDefaultTimeout(20000);
    for (const client of [page, second]) {
      client.on('pageerror', error => errors.push(error.message));
      await client.goto(`${origin}/#bot/${bot.id}`);
      if (width === 390 && await client.locator('.bot-row').filter({ hasText: bot.name }).isVisible()) await client.locator('.bot-row').filter({ hasText: bot.name }).click();
      await client.locator('.composer__input').waitFor();
    }
    const call = await api('/voice/session', { botId: bot.id });
    await api('/voice/tool', { botId: bot.id, callId: call.callId, name: 'send_task', args: { request: 'Prepare an email draft for review.' }, toolCallId: 'pill-email' });
    await page.locator('.approval-card').waitFor();
    const ended = await api('/voice/end', { botId: bot.id, callId: call.callId });
    const selector = `.system-event[data-row-seq="${ended.seq}"]`;
    for (const client of [page, second]) await client.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('still pending'), selector);
    await page.locator(selector).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(evidence, `pending-${width}-${theme}.png`) });
    await page.locator('.approval-card').getByRole('button', { name: "Don't allow", exact: true }).click();
    for (const client of [page, second]) {
      await client.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('was not allowed'), selector);
      assert.doesNotMatch(await client.locator(selector).innerText(), /pending/);
      assert.match(await client.locator(selector).innerText(), /Release review/);
    }
    await page.reload();
    if (width === 390 && await page.locator('.bot-row').filter({ hasText: bot.name }).isVisible()) await page.locator('.bot-row').filter({ hasText: bot.name }).click();
    await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('was not allowed'), selector);
    await page.locator(selector).scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth), true);
    await page.screenshot({ path: path.join(evidence, `denied-${width}-${theme}.png`) });
    assert.deepEqual(errors, []);
    console.log(`PASS ${width} ${theme}: pending at call end, denial updates both SSE clients, reload persists, no overflow`);
    await context.close();
  }
} catch (error) { console.error(logs.join('').slice(-6000)); if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-3000)); await page.screenshot({ path: path.join(evidence, 'failure.png') }); } throw error; }
finally { await browser?.close(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } await fs.rm(tmp, { recursive: true, force: true }); }

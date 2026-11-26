import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'saved-file-link-'));
const evidence = path.join(root, '.context/saved-file-link'); await fs.mkdir(evidence, { recursive: true });
async function port() { const server = http.createServer().listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(r => server.close(r)); return value; }
const apiPort = await port(), uiPort = await port(), origin = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', DEV_LOGIN: '1', DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, DIRECT_API_KEY: 'fixture', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: 'fixture', INKBOX_TUNNEL: '0' };
const children = [], logs = []; let browser, page;
function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', b => logs.push(String(b))); }
async function until(fn) { for (let n = 0; n < 300; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Fixture did not become ready'); }
try {
  start(['--import', 'tsx', 'tests/fixtures/saved-file-link-server.mts']);
  await until(() => fetch(`http://127.0.0.1:${apiPort}/api/health`).then(r => r.ok, () => false));
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` });
  await until(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    const request = async (url, data) => {
      const response = data === undefined ? await context.request.get(`${origin}/api${url}`) : await context.request.post(`${origin}/api${url}`, { data });
      assert.equal(response.status(), 200, await response.text()); return response.json();
    };
    await request('/auth/dev', { email: `file-${width}-${theme}@example.test`, name: 'Fixture account' });
    const { bots } = await request('/bots'), primary = bots.find(bot => bot.isPrimary);
    const { bot } = await request('/bots', { name: 'QA-Temp-1' });
    assert.equal(bot.isPrimary, false);
    await request(`/bots/${bot.id}/setup/skip`, {});
    const { output } = await request('/fixture/file', { botId: bot.id, absolute: theme === 'dark' });
    assert.match(output, /Saved library-fixture.md/);
    page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = [], lists = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/api/deliverables/bots/')) lists.push(request.url()); });
    await page.addInitScript(({ id, theme }) => { localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.theme', theme); }, { id: primary.id, theme });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/#bot/${bot.id}`);
    const link = page.getByRole('link', { name: 'View saved files', exact: true });
    await link.waitFor();
    const href = await link.getAttribute('href');
    const hash = href.startsWith('#') ? href : new URL(href).hash;
    assert.match(hash, /^#bot\/qa-temp-1~[a-z0-9]+\/reports$/);
    assert.equal(await link.getAttribute('target'), null);
    assert.equal(await page.getByRole('link', { name: 'Fixture reference', exact: true }).getAttribute('target'), '_blank');
    await link.click();
    const report = page.getByRole('heading', { name: 'library-fixture.md', exact: true });
    await report.waitFor();
    assert.equal(context.pages().length, 1);
    assert.ok(page.url().endsWith(hash));
    assert.match(await page.locator('.work-heading').innerText(), /QA-Temp-1/);
    assert.equal(await page.getByRole('heading', { name: 'No saved reports yet', exact: true }).count(), 0);
    assert.ok(lists.some(url => new URL(url).pathname === `/api/deliverables/bots/${bot.id}`));
    assert.equal(lists.some(url => new URL(url).pathname === `/api/deliverables/bots/${primary.id}`), false);
    assert.equal(await report.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const download = page.getByRole('link', { name: 'Download report', exact: true });
    const bytes = await context.request.get(new URL(await download.getAttribute('href'), origin).href);
    assert.equal(bytes.status(), 200); assert.equal(await bytes.text(), '# Saved fixture report');
    await page.screenshot({ path: path.join(evidence, `${width}-${theme}-reports.png`), fullPage: true });
    await page.goBack(); await link.waitFor();
    // A copied link resolves on first load even when the remembered Bot is primary.
    await page.goto(origin + '/' + hash); await report.waitFor();
    assert.match(await page.locator('.work-heading').innerText(), /QA-Temp-1/);
    // A foreign or deleted Bot never falls back to the primary Bot.
    await page.goto(`${origin}/#bot/unavailable~0000000000000/reports`);
    await page.getByText('This Bot is no longer available.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'No saved reports yet', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(`PASS R14 saved file ${width} ${theme}: non-primary scope, same tab, Back to chat, copied link, unavailable scope`);
    await context.close();
  }
} catch (error) { console.error(logs.join('').slice(-5000)); if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-4000)); await page.screenshot({ path: path.join(evidence, 'failure.png') }); } throw error; }
finally { await browser?.close(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } await fs.rm(tmp, { recursive: true, force: true }); }

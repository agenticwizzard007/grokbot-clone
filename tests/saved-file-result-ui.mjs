import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'saved-file-result-'));
const evidence = path.join(root, '.context/saved-file-result'); await fs.mkdir(evidence, { recursive: true });
async function port() { const server = http.createServer().listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(r => server.close(r)); return value; }
const apiPort = await port(), uiPort = await port(), origin = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', DEV_LOGIN: '1', DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, XAI_API_KEY: 'fixture', XAI_BASE_URL: 'https://model.fixture/v1', DIRECT_API_KEY: '', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: 'fixture', INKBOX_TUNNEL: '0' };
const children = [], logs = []; let browser, page;
function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', b => logs.push(String(b))); }
async function until(fn) { for (let n = 0; n < 600; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Fixture did not become ready'); }
try {
  start(['--import', 'tsx', 'tests/fixtures/saved-file-result-server.mts']);
  await until(() => fetch(`http://127.0.0.1:${apiPort}/api/health`).then(r => r.ok, () => false));
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` });
  await until(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const provider of ['claude', 'codex']) for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    const request = async (url, data) => {
      const response = data === undefined ? await context.request.get(`${origin}/api${url}`) : await context.request.post(`${origin}/api${url}`, { data, timeout: 60000 });
      assert.equal(response.status(), 200, await response.text()); return response.json();
    };
    await request('/auth/dev', { email: `save-${provider}-${width}-${theme}@example.test`, name: 'Fixture account' });
    const { bots } = await request('/bots'), primary = bots.find(bot => bot.isPrimary);
    assert.equal((await context.request.patch(`${origin}/api/bots/${primary.id}`, { data: { name: 'Primary fixture' } })).status(), 200);
    const { bot } = await request('/bots', { name: provider === 'codex' ? 'QA-Temp-1' : 'QA-Temp-2' });
    await request(`/bots/${bot.id}/setup/skip`, {});
    await request('/fixture/cli', { botId: bot.id, provider });
    page = await context.newPage(); page.setDefaultTimeout(60000);
    const errors = [], lists = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/api/deliverables/bots/')) lists.push(request.url()); });
    await page.addInitScript(({ id, theme }) => { localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.detailsOpen', '0'); }, { id: primary.id, theme });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(`${origin}/#bot/${bot.id}`);
    for (const repeated of [false, true]) {
      const filename = repeated ? 'repeated-fixture.txt' : 'saved-fixture.txt';
      await request(`/bots/${bot.id}/messages`, { text: repeated ? 'Save a fixture file and repeat link.' : 'Save a fixture file. Reply without a markdown link.' });
      const result = page.locator('.saved-file-result').filter({ hasText: filename });
      const link = result.getByRole('link', { name: 'View saved files', exact: true });
      await link.waitFor();
      assert.equal(await page.locator('.bubble.is-agent').filter({ hasText: filename }).count(), 0, 'Tool result is visible before the model reply');
      const saved = await request('/fixture/reply', { botId: bot.id, provider, filename });
      const tool = saved.rows.find(row => row.body.name === 'save_file' && row.body.savedFile?.filename === filename);
      assert.equal(tool.body.status, 'done');
      assert.equal(tool.body.savedFile.filename, filename);
      const reply = saved.rows.find(row => row.body.type === 'message' && row.body.role === 'assistant' && row.body.text.includes(filename));
      assert.ok(reply); assert.equal(reply.body.jobId, tool.body.jobId);
      if (repeated) assert.match(reply.body.text, /\[View saved files\]/);
      else assert.doesNotMatch(reply.body.text, /\]\(|#bot\/|\/api\//);
      assert.ok(saved.events.length > 0); assert.ok(saved.args.length > 0);
      await page.locator('.bubble.is-agent .md').filter({ hasText: filename }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'View saved files', exact: true }).count(), repeated ? 2 : 1);
      assert.equal(await page.locator('.bubble.is-agent').getByRole('link', { name: 'View saved files', exact: true }).count(), 0);
      assert.equal(await result.locator('a').getAttribute('target'), null);
      const hash = await link.getAttribute('href');
      assert.equal(hash, tool.body.savedFile.href);
      assert.match(hash, /^#bot\/qa-temp-[12]~[a-z0-9]+\/reports$/);
      assert.equal(await page.locator('.steps__toggle').last().getAttribute('aria-expanded'), 'false');
      await page.locator('.steps__toggle').last().click();
      assert.equal(await result.getByRole('link').count(), 1);
      await page.locator('.steps__toggle').last().click();
      await page.reload(); await link.waitFor();
      await page.locator('.bubble.is-agent .md').filter({ hasText: filename }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'View saved files', exact: true }).count(), repeated ? 2 : 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await result.evaluate(el => el.scrollWidth <= el.clientWidth), true);
      await result.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(evidence, `${provider}-${width}-${theme}-${repeated ? 'repeated' : 'plain'}-chat.png`), fullPage: true });
      await link.click();
      const report = page.getByRole('heading', { name: filename, exact: true }); await report.waitFor();
      assert.equal(context.pages().length, 1); assert.ok(page.url().endsWith(hash));
      assert.ok((await page.locator('.work-heading').innerText()).includes(bot.name));
      assert.ok(lists.some(url => new URL(url).pathname === `/api/deliverables/bots/${bot.id}`));
      assert.equal(lists.some(url => new URL(url).pathname === `/api/deliverables/bots/${primary.id}`), false);
      const download = page.locator('.work-row__body--report').filter({ has: report }).getByRole('link', { name: 'Download report', exact: true });
      const bytes = await context.request.get(new URL(await download.getAttribute('href'), origin).href);
      assert.equal(bytes.status(), 200); assert.equal(await bytes.text(), 'Local saved file fixture.');
      await page.screenshot({ path: path.join(evidence, `${provider}-${width}-${theme}-${repeated ? 'repeated' : 'plain'}-reports.png`), fullPage: true });
      await page.goBack(); await link.waitFor();
      await fs.writeFile(path.join(evidence, `${provider}-${width}-${theme}-${repeated ? 'repeated' : 'plain'}.json`), JSON.stringify({ versions: saved.versions, tool, reply, args: saved.args }, null, 2));
      console.log(`PASS R15 ${saved.versions[provider]} ${width} ${theme} ${repeated ? 'repeated link' : 'no model link'}: tool result via SSE, reload, same tab, saving Bot Reports, download, no duplicate`);
    }
    assert.deepEqual(errors, []); await context.close();
  }
} catch (error) { console.error(logs.join('').slice(-7000)); if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-4000)); await page.screenshot({ path: path.join(evidence, 'failure.png') }); } throw error; }
finally { await browser?.close(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } await fs.rm(tmp, { recursive: true, force: true }); }

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'central-setup-browser-'));
const evidence = path.join(root, '.context/central-setup-browser'); fs.mkdirSync(evidence, { recursive: true });
const children = [], logs = []; let browser;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const apiPort = await port(), uiPort = await port(), base = `http://127.0.0.1:${uiPort}`, apiBase = `http://127.0.0.1:${apiPort}`;
const fixtureFile = path.join(temp, 'fixture.json');
const env = { ...process.env, SETUP_FIXTURE_FILE: fixtureFile, DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), SWARM_ROLE: 'standalone', NODE_ENV: 'test', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'central-browser-test', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0', DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: base, SERVER_URL: base, DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', WHATSAPP_DISABLED: '1' };
function start(args, cwd = root, extra = {}) { const p = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(p); for (const stream of [p.stdout, p.stderr]) stream.on('data', d => logs.push(String(d))); return p; }
async function until(fn, name) { for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(100); } throw new Error('Timed out: ' + name); }
async function seed(mode) { const child = start(['--import', 'tsx', 'tests/fixtures/central-setup.seed.mts', ...(mode ? [mode] : [])]); assert.equal(await new Promise(r => child.on('exit', r)), 0, logs.join('')); }
async function api(url, method = 'GET', body, token = 'central-browser-token') { return fetch(apiBase + '/api' + url, { method, headers: { cookie: 'swarm_session=' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
try {
  await seed(); const f = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  start(['--import', 'tsx', 'server/src/index.ts']);
  await until(() => fetch(apiBase + '/api/health').then(r => r.ok).catch(() => false), 'server');
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort)], path.join(root, 'web'), { SWARM_API: apiBase });
  await until(() => fetch(base).then(r => r.ok).catch(() => false), 'web');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'swarm_session', value: 'central-browser-token', url: base }]);
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(String(e))); page.setDefaultTimeout(15000);
  await page.goto(base);
  await page.getByRole('article', { name: 'Nia setup' }).waitFor();
  const card = page.getByRole('article', { name: 'Nia setup' });
  await card.getByRole('button', { name: 'Review Nia configuration' }).click();
  await card.getByRole('button', { name: 'Activate Nia · revision 1' }).waitFor();
  await card.getByText('Original user answers').click();
  await card.getByText('Prepare Nia to summarize my supplied notes into three bullets. Return results here. No external actions.', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'review-desktop.png'), fullPage: true });
  // Canonical service in a second process changes the revision while this review stays open.
  await seed('revise');
  // A second-process journal producer cannot push this process's SSE hub. Reload
  // the roster through a genuine API metadata update to invalidate setup here.
  const patch = await api(`/bots/${f.worker.id}`, 'PATCH', { label: 'Notes specialist' }); assert.ok(patch.ok);
  await card.getByText('The configuration changed. Review the latest revision before activating.').waitFor();
  assert.equal(await card.getByRole('button', { name: 'Activate Nia · revision 1' }).isDisabled(), true);
  assert.equal((await api(`/bots/${f.worker.id}/setup/activate`, 'POST', { revision: 1, coordinatorId: f.chief.id })).status, 409);
  await card.getByRole('button', { name: 'Review latest revision' }).click();
  const latest = await (await api(`/bots/${f.worker.id}/setup`)).json();
  await card.getByText('Summarize supplied notes in four bullets', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('button.pinned__tile[title="Quinn"]').click();
  assert.ok(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'review fits phone');
  await page.screenshot({ path: path.join(evidence, 'review-mobile.png'), fullPage: true });
  assert.equal((await api(`/bots/${f.chief.id}/coworker-setups`, 'GET', undefined, 'central-browser-other-token')).status, 404);
  await card.getByRole('button', { name: `Activate Nia · revision ${latest.onboarding.revision}` }).click();
  await until(async () => (await (await api(`/bots/${f.worker.id}/setup`)).json()).onboarding.status === 'active', 'exact revision activation');
  assert.equal((await (await api('/bots')).json()).bots.find(b => b.id === f.chief.id).isPrimary, true);
  assert.equal(await page.locator('.chat__pill-name').innerText(), 'Quinn');
  const rows = await (await api(`/bots/${f.worker.id}/rows`)).json();
  assert.ok(!JSON.stringify(rows).includes('"role":"user"'), 'no synthetic specialist answers');
  assert.deepEqual(errors, []);
  console.log('PASS central setup browser: original sources, stale review, exact revision activation in Quinn, ownership, mobile layout, no fabricated specialist answers');
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, revision: latest.onboarding.revision }));
} catch (error) {
  fs.writeFileSync(path.join(evidence, 'server.log'), logs.join(''));
  if (browser) { const pages = browser.contexts().flatMap(c => c.pages()); if (pages[0]) await pages[0].screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {}); }
  throw error;
} finally { await browser?.close(); for (const child of children.reverse()) child.kill('SIGTERM'); fs.rmSync(temp, { recursive: true, force: true }); }

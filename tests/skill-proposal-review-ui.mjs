import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-proposal-review-'));
const evidence = path.join(root, '.context/skill-proposal-review'); await fs.mkdir(evidence, { recursive: true });
async function port() { const server = http.createServer().listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(r => server.close(r)); return value; }
const apiPort = await port(), uiPort = await port(), origin = `http://127.0.0.1:${uiPort}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', DEV_LOGIN: '1', DB_PATH: path.join(tmp, 'db'), FILES_DIR: path.join(tmp, 'files'), CLI_PROFILES_DIR: path.join(tmp, 'profiles'), SESSION_SECRET: 'local-only', COMPUTER_PROVIDER: 'local', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, DIRECT_API_KEY: 'fixture', LLM_PROVIDER: 'direct', COMPOSIO_API_KEY: 'fixture', INKBOX_TUNNEL: '0' };
const children = [], logs = []; let browser, page;
function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', b => logs.push(String(b))); }
async function until(fn) { for (let n = 0; n < 300; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Fixture did not become ready'); }
try {
  start(['--import', 'tsx', 'tests/fixtures/cli-skill-panel-server.mts']);
  await until(() => fetch(`http://127.0.0.1:${apiPort}/api/health`).then(r => r.ok, () => false));
  start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: `http://127.0.0.1:${apiPort}` });
  await until(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const provider of ['claude', 'codex']) for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    assert.equal((await context.request.post(`${origin}/api/auth/dev`, { data: { email: `${provider}-${width}-${theme}@example.test`, name: 'Fixture account' } })).status(), 200);
    const { bots } = await (await context.request.get(`${origin}/api/bots`)).json(), bot = bots.find(b => b.isPrimary);
    assert.equal((await context.request.patch(`${origin}/api/bots/${bot.id}`, { data: { name: 'Skills fixture' } })).status(), 200);
    await context.request.post(`${origin}/api/bots/${bot.id}/setup/skip`);
    const later = await context.request.post(`${origin}/api/fixture/skill`, { data: { botId: bot.id, provider, name: 'source-check-later' } });
    assert.equal((await later.json()).activated, true);
    page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ id, theme }) => { localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.theme', theme); }, { id: bot.id, theme });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const open = async () => {
      await page.goto(origin);
      await page.evaluate(async id => (await import('/src/configStore.ts')).useConfigUI.getState().openBotSettings(id, 'skills'), bot.id);
      await page.getByText('1 pending review.', { exact: true }).waitFor();
      await page.locator('summary').filter({ hasText: 'Learned skill changes' }).click();
    };
    const seed = async (name, extra = {}) => {
      const r = await context.request.post(`${origin}/api/fixture/legacy-skill`, { data: { botId: bot.id, provider, name, ...extra } });
      assert.equal(r.status(), 200); return (await r.json()).proposal;
    };
    const proposals = async () => (await (await context.request.get(`${origin}/api/bots/${bot.id}/skill-proposals`)).json()).proposals;
    const shot = async name => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: path.join(evidence, `${provider}-${name}-${width}-${theme}.png`), fullPage: true });
    };
    for (const decision of ['Approve', 'Dismiss']) {
      const name = `source-check-original-${decision.toLowerCase()}`, proposal = await seed(name);
      await open();
      // Actions must be visible without opening the diff or scrolling past it.
      assert.equal(await page.getByRole('button', { name: 'Approve', exact: true }).isVisible(), true, 'Review changes exposes approval before opening the proposal diff');
      const row = page.getByRole('article', { name: `${name} proposal`, exact: true });
      assert.equal(await row.getByRole('button', { name: 'Approve', exact: true }).isVisible(), true);
      assert.equal(await row.getByRole('button', { name: 'Dismiss', exact: true }).isVisible(), true);
      assert.equal(await row.getByLabel('Proposed skill diff').isVisible(), false);
      assert.equal((await proposals()).filter(p => p.status === 'pending').length, 1);
      await shot(`pending-${decision.toLowerCase()}`);
      const response = page.waitForResponse(r => r.url().endsWith(`/skill-proposals/${proposal.id}/review`) && r.request().method() === 'POST');
      await row.getByRole('button', { name: decision, exact: true }).click(); assert.equal((await response).status(), 200);
      await page.getByText('No pending proposals.', { exact: true }).waitFor();
      const rows = await proposals(); assert.equal(rows.filter(p => p.status === 'pending').length, 0);
      assert.equal(rows.find(p => p.id === proposal.id).status, decision === 'Approve' ? 'approved' : 'rejected');
      if (decision === 'Approve') await page.getByRole('button', { name: `Edit ${name}`, exact: true }).waitFor();
      else assert.equal(await page.getByRole('button', { name: `Edit ${name}`, exact: true }).count(), 0);
      await page.locator('summary').filter({ hasText: 'Earlier skill proposals' }).click();
      await page.locator('summary').filter({ hasText: `${name} · New skill · ${decision === 'Approve' ? 'approved' : 'rejected'}` }).waitFor();
      assert.equal(await row.getByRole('button', { name: 'Approve', exact: true }).count(), 0);
      await shot(decision === 'Approve' ? 'approved' : 'dismissed');
    }
    const blocked = await seed('source-check-unavailable', { unavailableEvidence: true }); await open();
    const row = page.getByRole('article', { name: 'source-check-unavailable proposal', exact: true });
    const failure = page.waitForResponse(r => r.url().endsWith(`/skill-proposals/${blocked.id}/review`) && r.request().method() === 'POST');
    await row.getByRole('button', { name: 'Approve', exact: true }).click(); assert.equal((await failure).status(), 422);
    await row.getByRole('alert').filter({ hasText: 'You can dismiss it or ask your Bot for a fresh proposal.' }).waitFor();
    await page.getByText('1 pending review.', { exact: true }).waitFor(); await shot('unavailable-source');
    await row.getByRole('button', { name: 'Refresh skill changes', exact: true }).click();
    await page.getByText('1 pending review.', { exact: true }).waitFor();
    assert.equal(await row.getByRole('alert').count(), 0);
    await row.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.getByText('No pending proposals.', { exact: true }).waitFor();
    assert.equal((await proposals()).find(p => p.id === blocked.id).status, 'rejected');
    assert.deepEqual(errors, []);
    console.log(`PASS legacy proposal review ${provider} ${width} ${theme}: visible actions, approve, dismiss, earlier proposals, unavailable source recovery`);
    await context.close();
  }
} catch (error) {
  console.error(logs.join('').slice(-5000));
  if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-4000)); await page.screenshot({ path: path.join(evidence, 'failure.png') }); }
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
  await fs.rm(tmp, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
const root = process.cwd(), tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-skill-panel-'));
const evidence = path.join(root, '.context/cli-skill-panel'); await fs.mkdir(evidence, { recursive: true });
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
  for (const provider of ['codex', 'claude']) for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: 'reduce' });
    assert.equal((await context.request.post(`${origin}/api/auth/dev`, { data: { email: `${provider}-${width}-${theme}@example.test`, name: 'Fixture account' } })).status(), 200);
    const { bots } = await (await context.request.get(`${origin}/api/bots`)).json(), bot = bots.find(b => b.isPrimary);
    await context.request.post(`${origin}/api/bots/${bot.id}/setup/skip`);
    page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(({ id, theme }) => { localStorage.setItem('swarm.selectedBot', id); localStorage.setItem('swarm.theme', theme); }, { id: bot.id, theme });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const open = async tab => { await page.evaluate(async ({ id, tab }) => (await import('/src/configStore.ts')).useConfigUI.getState().openBotSettings(id, tab), { id: bot.id, tab }); };
    const shot = async name => { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: path.join(evidence, `${provider}-${name}-${width}-${theme}.png`), fullPage: true }); };
    const seed = async (name, extra = {}) => { const r = await context.request.post(`${origin}/api/fixture/skill`, { data: { botId: bot.id, provider, name, ...extra } }); assert.equal(r.status(), 200); const body = await r.json(); assert.equal(body.ok, true); return body; };
    await page.goto(origin); await open('skills');
    await page.getByText('No skills yet.', { exact: false }).waitFor(); await shot('empty');
    const active = await seed('source-check'); assert.equal(active.activated, true);
    await page.reload(); await open('skills'); await page.getByRole('button', { name: 'Edit source-check', exact: true }).waitFor();
    await page.getByText('No pending proposals.', { exact: true }).waitFor();
    assert.equal(await page.getByText('No skills yet.', { exact: false }).count(), 0);
    assert.equal(await page.locator('.approval-card').count(), 0); await shot('active');
    await open('learning');
    const toggle = page.getByRole('checkbox', { name: 'Require approval for skill changes', exact: true }); await toggle.waitFor(); assert.equal(await toggle.isChecked(), false);
    await page.getByText('Off: on a connected Claude or OpenAI plan', { exact: false }).waitFor(); await toggle.scrollIntoViewIfNeeded(); await shot('setting');
    await toggle.check(); await page.getByRole('button', { name: 'Save Bot overrides', exact: true }).click();
    await until(async () => (await (await context.request.get(`${origin}/api/learning/settings?botId=${bot.id}`)).json()).settings.skillApproval);
    const pending = await seed('reviewed-source-check'); assert.equal(pending.activated, false);
    const update = await seed('source-check', { skillId: active.skill.id, revision: active.skill.revision }); assert.equal(update.activated, false);
    await open('skills'); await page.getByText('2 pending review.', { exact: true }).waitFor();
    await page.locator('summary').filter({ hasText: 'Learned skill changes' }).click();
    await page.locator('summary').filter({ hasText: 'reviewed-source-check' }).click();
    await page.getByText('This new skill will be active after you approve it.', { exact: true }).waitFor(); await shot('pending-new');
    await page.locator('summary').filter({ hasText: 'source-check · Base revision' }).click();
    await page.getByText('The current skill stays active until you approve this change.', { exact: true }).waitFor(); await shot('pending-update');
    // A newer proposal for the same name replaces the older pending candidate.
    await seed('reviewed-source-check');
    await page.reload(); await open('skills');
    await page.getByText('2 pending review.', { exact: true }).waitFor();
    await open('learning'); await toggle.uncheck();
    await page.getByRole('button', { name: 'Save Bot overrides', exact: true }).click();
    await until(async () => !(await (await context.request.get(`${origin}/api/learning/settings?botId=${bot.id}`)).json()).settings.skillApproval);
    await seed('reviewed-source-check');
    await seed('source-check', { skillId: active.skill.id, revision: active.skill.revision });
    await page.reload(); await open('skills');
    await page.getByText('No pending proposals.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Edit reviewed-source-check', exact: true }).waitFor();
    await page.locator('summary').filter({ hasText: 'Learned skill changes' }).click();
    await page.locator('summary').filter({ hasText: 'Earlier skill proposals' }).click();
    assert.equal(await page.locator('summary').filter({ hasText: 'superseded' }).count(), 3);
    assert.equal(await page.getByRole('button', { name: 'Approve', exact: true }).count(), 0);
    await shot('superseded');
    const saved = await context.request.post(`${origin}/api/fixture/file`, { data: { botId: bot.id } });
    assert.equal(saved.status(), 200);
    const { output } = await saved.json();
    assert.match(output, /Saved library-fixture.md to your Library/);
    assert.ok(!output.includes('/api/deliverables/'));
    await page.goto(`${origin}/#bot/${bot.id}`);
    const link = page.getByRole('link', { name: 'View saved files', exact: true });
    await link.waitFor(); assert.ok((await link.getAttribute('href')).startsWith(origin));
    await shot('file-reply');
    const opened = context.waitForEvent('page'); await link.click();
    const library = await opened; library.setDefaultTimeout(15000); page = library;
    await library.getByRole('heading', { name: 'library-fixture.md', exact: true }).waitFor();
    const download = library.getByRole('link', { name: 'Download report', exact: true });
    const bytes = await context.request.get(new URL(await download.getAttribute('href'), origin).href);
    assert.equal(bytes.status(), 200); assert.equal(await bytes.text(), '# Saved fixture report');
    await library.close();
    assert.deepEqual(errors, []);
    console.log(`PASS ${provider} ${width} ${theme}: active skill, accurate new/update review copy, newer proposals and normal activation supersede stale proposals`);
    await context.close();
  }
} catch (error) { console.error(logs.join('').slice(-5000)); if (page && !page.isClosed()) { console.error((await page.locator('body').innerText()).slice(-4000)); await page.screenshot({ path: path.join(evidence, 'failure.png') }); } throw error; }
finally { await browser?.close(); for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } await fs.rm(tmp, { recursive: true, force: true }); }

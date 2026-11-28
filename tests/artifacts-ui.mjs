import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-ui-'));
const evidence = path.join(root, '.context/artifacts'); await fs.mkdir(evidence, { recursive: true });
async function freePort() { const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening'); const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port; }
const apiPort = await freePort(), uiPort = await freePort(), base = `http://127.0.0.1:${uiPort}`, apiBase = `http://127.0.0.1:${apiPort}`;
const env = { PATH: process.env.PATH, NODE_ENV: 'test', SWARM_ROLE: 'standalone', DEV_LOGIN: '1', DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'), SESSION_SECRET: 'artifact-ui-local-only', PORT: String(apiPort), APP_URL: base, SERVER_URL: base, COMPUTER_PROVIDER: 'local', SWARM_NO_SCHEDULER: '1', MEMORY_CONSOLIDATE_IDLE_MINUTES: '0', WHATSAPP_DISABLED: '1', INKBOX_TUNNEL: '0', COMPOSIO_API_KEY: '', OPENROUTER_API_KEY: '', DIRECT_API_KEY: '' };
const children = [], logs = [];
let browser;
function start(args, cwd = root, extra = {}) { const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data))); return child; }
async function ready(url, child) { for (let attempt = 0; attempt < 300; attempt++) { assert.equal(child.exitCode, null, logs.join('')); if (await fetch(url).then(r => r.ok, () => false)) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(logs.join('')); }
async function count(locator, expected) { await locator.first().waitFor(); assert.equal(await locator.count(), expected); }
try {
  await ready(`${apiBase}/api/health`, start(['--import', 'tsx', 'server/src/index.ts']));
  await ready(base, start(['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase }));
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const owner = await browser.newContext({ viewport: { width: 1440, height: 1250 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  const teammate = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  for (const [context, email, name] of [[owner, 'owner@example.test', 'Alex Morgan'], [teammate, 'teammate@example.test', 'Jordan Lee']]) {
    const login = await context.request.post(`${base}/api/auth/dev`, { data: { email, name } }); assert.equal(login.status(), 200);
    await context.addInitScript(() => { if (window.top === window) localStorage.setItem('swarm.theme', 'light'); });
  }
  const { bots } = await (await owner.request.get(`${base}/api/bots`)).json(); const bot = bots.find(b => b.isPrimary);
  await owner.request.patch(`${base}/api/bots/${bot.id}`, { data: { name: 'LinkedIn Brand Manager' } });
  const seeder = path.join(temp, 'seed.mjs');
  await fs.writeFile(seeder, `
import { db } from ${JSON.stringify(path.join(root, 'server/src/db.ts'))};
import { recordArtifact } from ${JSON.stringify(path.join(root, 'server/src/deliverables/artifacts.ts'))};
const bot = db.prepare('SELECT * FROM bots WHERE id=?').get(${JSON.stringify(bot.id)});
const documents = [
 ['linkedin-content-studio.html', '<style>body{font:15px system-ui;margin:0;color:#192d3a;background:#f6f8fc}header{padding:36px;background:#1b3646;color:white}small{color:#c4dae8;text-transform:uppercase;letter-spacing:2px}h1{font-size:32px;margin:15px 0}main{padding:30px}article{padding:22px;background:white;border:1px solid #dde4eb;border-radius:12px;margin:12px 0}p{line-height:1.8}b{color:#1c7790}</style><header><small>LinkedIn · Brand workspace</small><h1>Your next conversation starts here.</h1><p>A content studio for ideas worth sharing.</p></header><main><b>THIS WEEK’S CONTENT PLAN</b><article><strong>01 / Share what you learned</strong><p>Turn a customer insight into a conversation your audience can contribute to.</p></article><article><strong>02 / Build in the open</strong><p>Show the thinking behind the work, and invite your community into the process.</p></article></main><script>window.parent.artifactUnsafe=true</script>'],
 ['brand-voice-guidelines.md', '# Brand voice guidelines\\n\\nOur voice is thoughtful, direct, and human.\\n\\n## Writing principles\\n\\n- Lead with a useful idea.\\n- Make room for a conversation.\\n- Show your work with concrete examples.\\n\\n## Before you publish\\n\\nAsk: would I say this to a teammate?'],
 ['november-performance.csv', 'Week,Impressions,Engagements\\n1,24000,840\\n2,31500,1102\\n3,38200,1413'],
 ['content-calendar.json', '{"campaign":"Community stories","month":"December","posts":12}'],
 ['audience-research.md', '# Audience research\\n\\n## What we heard\\n\\nPeople want practical advice they can use today.\\n\\n## Next steps\\n\\nInterview five customers and test two content formats.'],
 ['campaign-launch-checklist.txt', 'Launch checklist\\n\\n1. Review creative\\n2. Confirm posting schedule\\n3. Share launch notes with the team']
];
for(const [filename,content] of documents) recordArtifact({userId:bot.user_id,botId:bot.id,filename,content});
db.close();`);
  const seed = start(['--import', 'tsx', seeder]); const [exit] = await once(seed, 'exit'); assert.equal(exit, 0, logs.join(''));
  const page = await owner.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(20000);
  await page.goto(`${base}/#reports`);
  await count(page.locator('.artifact-card'), 6);
  await page.screenshot({ path: path.join(evidence, 'library-desktop.png'), fullPage: true });
  await page.getByRole('textbox', { name: 'Search artifacts' }).fill('brand-voice'); await count(page.locator('.artifact-card'), 1);
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await page.getByRole('combobox', { name: 'Artifact type' }).selectOption('web'); await count(page.locator('.artifact-card'), 1);
  await page.getByRole('combobox', { name: 'Artifact type' }).selectOption('all');
  await page.getByRole('button', { name: 'List view', exact: true }).click(); await count(page.locator('.artifact-grid.is-list .artifact-card'), 6);
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  const a11yLibrary = await new AxeBuilder({ page }).include('.artifact-library').withTags(['wcag2a', 'wcag2aa']).analyze();
  assert.deepEqual(a11yLibrary.violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
  await page.getByRole('button', { name: 'Preview linkedin-content-studio.html', exact: true }).click();
  await page.frameLocator('.artifact-html-preview').getByRole('heading', { name: 'Your next conversation starts here.' }).waitFor();
  assert.equal(await page.evaluate(() => window.artifactUnsafe), undefined, 'HTML scripts remain sandboxed');
  await page.screenshot({ path: path.join(evidence, 'preview-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByLabel('Add a teammate', { exact: true }).fill('teammate@example.test');
  await page.getByRole('button', { name: 'Add teammate', exact: true }).click();
  await page.getByText('Jordan Lee', { exact: true }).waitFor();
  const link = await page.getByLabel('Artifact link', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), link);
  await page.screenshot({ path: path.join(evidence, 'sharing-desktop.png'), fullPage: true });
  const a11yShare = await new AxeBuilder({ page }).include('.artifact-dialog').withTags(['wcag2a', 'wcag2aa']).analyze();
  assert.deepEqual(a11yShare.violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
  const signedOut = await browser.newContext();
  const signInPage = await signedOut.newPage();
  await signInPage.goto(link);
  await signInPage.getByRole('textbox', { name: 'Email', exact: true }).fill('teammate@example.test');
  await signInPage.getByRole('button', { name: 'Continue with email', exact: true }).click();
  await signInPage.getByRole('tab', { name: 'Preview', exact: true }).waitFor();
  assert.equal(signInPage.url(), link, 'sign-in retains the shared artifact destination');
  await signInPage.evaluate(() => sessionStorage.setItem('swarm.artifactReturn', location.pathname));
  await signInPage.goto(`${base}/?signed_in=1`);
  await signInPage.waitForURL(link);
  await signedOut.close();
  const sharedLibrary = await teammate.newPage();
  await sharedLibrary.goto(`${base}/#reports`);
  await sharedLibrary.getByRole('button', { name: /Shared with me/ }).click();
  await count(sharedLibrary.locator('.artifact-card'), 1);
  await sharedLibrary.close();
  const sharedPage = await teammate.newPage(); sharedPage.on('pageerror', error => errors.push(error.message));
  await sharedPage.goto(link); await sharedPage.getByRole('tab', { name: /Discussion/ }).click();
  await sharedPage.getByLabel('Add to the discussion').fill('The direction looks great. Can we add a customer story to week two?');
  await sharedPage.getByRole('button', { name: 'Post comment' }).click();
  await sharedPage.getByText('The direction looks great. Can we add a customer story to week two?', { exact: true }).waitFor();
  await sharedPage.reload(); await sharedPage.getByRole('tab', { name: /Discussion/ }).click();
  await sharedPage.getByText('The direction looks great. Can we add a customer story to week two?', { exact: true }).waitFor();
  await page.getByRole('tab', { name: /Discussion/ }).click(); await page.getByRole('button', { name: 'Refresh artifact', exact: true }).click();
  await page.getByText('The direction looks great. Can we add a customer story to week two?', { exact: true }).waitFor();
  await page.getByLabel('Add to the discussion').fill('Absolutely. I’ll update the next version with a customer spotlight.');
  await page.getByRole('button', { name: 'Post comment' }).click();
  await page.getByText('Absolutely. I’ll update the next version with a customer spotlight.', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, 'discussion-desktop.png'), fullPage: true });
  await page.getByRole('tab', { name: /Sharing/ }).click();
  await page.getByRole('combobox', { name: 'Permission for Jordan Lee' }).selectOption('viewer');
  await sharedPage.reload(); await sharedPage.getByRole('tab', { name: /Discussion/ }).click();
  await sharedPage.getByText(/You have view-only access/).waitFor();
  assert.equal(await sharedPage.getByRole('button', { name: 'Post comment' }).count(), 0);
  await page.getByRole('button', { name: 'Close artifact', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.artifact-card').first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(evidence, 'library-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Share linkedin-content-studio.html', exact: true }).click();
  assert.equal(await page.locator('.artifact-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  await page.screenshot({ path: path.join(evidence, 'sharing-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Remove access for Jordan Lee' }).click();
  await page.getByText('Access removed.', { exact: true }).waitFor();
  await sharedPage.reload(); await sharedPage.getByRole('heading', { name: 'Artifact unavailable' }).waitFor();
  await page.getByRole('button', { name: 'Close artifact', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1250 });
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
  await page.locator('.tasks-view__scroll').evaluate(el => el.scrollTop = 0);
  await page.screenshot({ path: path.join(evidence, 'library-dark.png'), fullPage: true });
  const a11yDark = await new AxeBuilder({ page }).include('.artifact-library').withTags(['wcag2a', 'wcag2aa']).analyze();
  assert.deepEqual(a11yDark.violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
  await page.setViewportSize({ width: 320, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Share linkedin-content-studio.html', exact: true }).click();
  assert.equal(await page.locator('.artifact-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true);

  assert.deepEqual(errors, []);
  console.log('PASS: real account sharing, comments, persistence, view-only access, revocation, sandboxed HTML, search, filters, grid/list, clipboard, mobile and accessibility.');
} catch (error) { await fs.writeFile(path.join(evidence, 'server.log'), logs.join('')); throw error; }
finally { await browser?.close(); for (const child of children) child.kill('SIGTERM'); await fs.rm(temp, { recursive: true, force: true }); }

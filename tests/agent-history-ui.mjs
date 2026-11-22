import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-browser-'));
const evidence = path.join(root, '.context/agent-history-browser'); fs.mkdirSync(evidence, { recursive: true });
const children = [], logs = []; let browser;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const apiPort = await port(), uiPort = await port(), base = `http://127.0.0.1:${uiPort}`, apiBase = `http://127.0.0.1:${apiPort}`;
const fixtureFile = path.join(temp, 'fixture.json');
const env = { ...process.env, HISTORY_FIXTURE_FILE: fixtureFile, DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), SWARM_ROLE: 'standalone', NODE_ENV: 'test', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'history-browser-test', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0', DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: base, SERVER_URL: base, DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', WHATSAPP_DISABLED: '1' };
function start(args, cwd = root, extra = {}) { const p = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(p); for (const stream of [p.stdout, p.stderr]) stream.on('data', d => logs.push(String(d))); return p; }
async function until(fn, name) { for (let i = 0; i < 200; i++) { if (await fn()) return; await sleep(100); } throw new Error('Timed out: ' + name); }
async function seed(mode) { const child = start(['--import', 'tsx', 'tests/fixtures/agent-history.seed.mts', ...(mode ? [mode] : [])]); assert.equal(await new Promise(r => child.on('exit', r)), 0, logs.join('')); }
async function api(url, method = 'GET', body, token = 'history-browser-token') { return fetch(apiBase + '/api' + url, { method, headers: { cookie: 'swarm_session=' + token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); }
try {
  await seed(); const f = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  start(['--import', 'tsx', 'server/src/index.ts']);
  await until(() => fetch(apiBase + '/api/health').then(r => r.ok).catch(() => false), 'server');
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort)], path.join(root, 'web'), { SWARM_API: apiBase });
  await until(() => fetch(base).then(r => r.ok).catch(() => false), 'web');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: 'swarm_session', value: 'history-browser-token', url: base }]);
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(String(e))); page.setDefaultTimeout(15000);
  await page.goto(base);
  await page.locator('.chat__pill-name').waitFor();
  const show=page.getByRole('button',{name:'Show details',exact:true});if(await show.isVisible())await show.click();
  await page.getByRole('navigation',{name:'Conversation details sections'}).getByRole('button',{name:'Setup',exact:true}).click();
  await page.getByRole('tab',{name:'History',exact:true}).click();
  const history=page.getByRole('region',{name:'Agent change history',exact:true});
  await history.getByText(/skill proposal · pending/).click();
  await history.getByText('A proposal is not an active revision.',{exact:false}).waitFor();
  await history.getByText('Proposed procedure awaiting review.',{exact:true}).waitFor();
  const applied=history.locator('.agent-history__entry').filter({has:page.locator('summary').filter({hasText:/skill · edit · skill revision 36$/})});
  await applied.locator('summary').first().click();
  await applied.getByRole('region',{name:'Before body',exact:true}).getByText('Accepted procedure 34: lead with overdue work.',{exact:true}).waitFor();
  await applied.getByRole('region',{name:'After body',exact:true}).getByText('Accepted procedure 35: lead with overdue work.',{exact:true}).waitFor();
  await page.screenshot({path:path.join(evidence,'history-desktop.png'),fullPage:true});
  await history.getByRole('button',{name:'Load older changes',exact:true}).click();
  await history.getByText(/skill · create · skill revision 1$/).waitFor();
  await seed('revise');
  await page.evaluate(()=>window.dispatchEvent(new Event('online')));
  await history.getByText('New changes are available. Refresh history to include them.',{exact:true}).waitFor();
  await history.getByRole('button',{name:'Refresh history',exact:true}).click();
  await history.getByText(/skill · edit · skill revision 37$/).click();
  await history.getByText('New accepted procedure after the history page opened.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Back to chat',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  const pinned = page.locator('button.pinned__tile[title="Quinn"]');
  if (await pinned.isVisible()) await pinned.click();
  await page.getByRole('button',{name:'Show details',exact:true}).click();
  await page.getByRole('navigation',{name:'Conversation details sections'}).getByRole('button',{name:'Setup',exact:true}).click();
  await page.getByRole('tab',{name:'History',exact:true}).click();
  await history.getByText(/skill · edit · skill revision 37$/).click();
  await history.getByText('New accepted procedure after the history page opened.',{exact:true}).waitFor();
  assert.ok(await history.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'history fits phone');
  await page.screenshot({path:path.join(evidence,'history-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  const result={passed:true,checks:['authenticated real-server history','pending versus applied changes','exact before/after','older history pagination','new changes and refresh','390px layout'],errors};
  fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(result,null,2));
  console.log('PASS agent history browser: before/after, proposals, paging, refresh and mobile layout');
} catch (error) {
  fs.writeFileSync(path.join(evidence, 'server.log'), logs.join(''));
  if (browser) { const pages = browser.contexts().flatMap(c => c.pages()); if (pages[0]) await pages[0].screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {}); }
  throw error;
} finally { await browser?.close(); for (const child of children.reverse()) child.kill('SIGTERM'); fs.rmSync(temp, { recursive: true, force: true }); }

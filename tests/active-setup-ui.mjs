import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = process.cwd(), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'active-setup-browser-'));
const evidence = path.join(root, '.context/active-setup');
fs.mkdirSync(evidence, { recursive: true });
const children = [], logs = [];
let browser;
async function port() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
const apiPort = await port(), uiPort = await port(), origin = `http://127.0.0.1:${uiPort}`, backend = `http://127.0.0.1:${apiPort}`;
const env = { ...process.env, DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), DEV_LOGIN: '1', SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', NODE_ENV: 'test', SESSION_SECRET: 'active-setup-fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'fixture', DIRECT_API_KEY: 'fixture', OPENROUTER_API_KEY: '', LLM_PROVIDER: 'direct', INKBOX_TUNNEL: '0', PORT: String(apiPort), APP_URL: origin, SERVER_URL: origin, SWARM_API: backend };
function start(args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', value => logs.push(String(value)));
}
async function until(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('Local fixture did not become ready. ' + logs.join('').slice(-4000));
}
try {
  start(['--import', 'tsx', 'tests/fixtures/active-setup-server.mts']);
  await until(() => fetch(backend + '/api/bots', { headers: { cookie: 'swarm_session=active-setup-token' } }).then(r => r.ok, () => false));
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'));
  await until(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addCookies([{ name: 'swarm_session', value: 'active-setup-token', url: origin }]);
    const page = await context.newPage(), errors = [], held = [];
    let recover = false;
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { errors.push('External browser request attempted'); return route.abort(); }
      if (url.pathname === '/src/main.tsx') return route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import { SetupBanner } from '/src/components/SetupBanner.tsx';
import { SuggestedIntegrations } from '/src/components/SuggestedIntegrations.tsx';
import { AgentConfiguration } from '/src/components/config/AgentConfiguration.tsx';
import { useStore } from '/src/store.ts';
import '/src/styles/tokens.css'; import '/src/styles/base.css'; import '/src/styles/config.css';
const { bots } = await (await fetch('/api/bots')).json();
const stale = { ...bots[0], onboarding: { status: 'interviewing', revision: 31 } };
useStore.setState({ user: { id: 'owner', name: 'Test account' }, bots: [stale] });
window.refreshConnections = () => useStore.getState().handleEvent({ type: 'connections' });
window.replayStaleRoster = () => useStore.getState().handleEvent({ type: 'bot', bot: stale });
window.currentBot = () => useStore.getState().bots[0];
function Harness() {
  const bot = useStore(state => state.bots[0]);
  return React.createElement('main', { style: { maxWidth: 700, margin: 'auto', padding: 20 } },
    React.createElement(SetupBanner, { bot }),
    React.createElement(SuggestedIntegrations, { botId: bot.id, description: bot.description, instructions: bot.instructions }),
    React.createElement(AgentConfiguration, { bot }));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));` });
      if (url.pathname.endsWith('/suggested-apps') && !recover) { held.push(route); return; }
      return route.continue();
    });
    await page.goto(origin);
    await page.getByText('Active configuration · Revision 32', { exact: true }).waitFor();
    await page.waitForFunction(() => window.currentBot().onboarding.status === 'active');
    assert.equal(await page.getByRole('button', { name: 'Skip setup', exact: true }).count(), 0);
    await page.evaluate(() => window.replayStaleRoster());
    assert.equal(await page.getByRole('region', { name: 'Active Bot setup' }).count(), 0);
    await until(() => held.length > 0);
    await page.clock.install();
    // Repeated refresh events must not reset the total loading deadline.
    for (let i = 0; i < 5; i++) {
      await page.clock.runFor(3000);
      await page.evaluate(() => window.refreshConnections());
    }
    await page.clock.runFor(1000);
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    const suggestions = page.getByRole('region', { name: 'Suggested integrations' });
    assert.equal(await suggestions.getAttribute('aria-busy'), 'false');
    assert.equal(await page.getByText('Finding relevant apps…', { exact: true }).count(), 0);
    await page.screenshot({ path: path.join(evidence, `timeout-${width}.png`) });
    recover = true;
    for (const route of held) await route.fulfill({ json: { suggestions: [] } }).catch(() => {});
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.clock.runFor(500);
    await page.getByText('No matching additional apps for this Bot right now.', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(evidence, `repaired-${width}.png`) });
    const bot = await page.evaluate(() => window.currentBot());
    const rows = await (await context.request.get(`${origin}/api/bots/${bot.id}/rows`)).json();
    assert.equal(rows.rows.find(row => row.body.card === 'question').body.status, 'dismissed');
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS R1: active revision repairs stale roster and interview cards; suggestions time out under refreshes and retry to a clear empty state.');
} finally {
  await browser?.close();
  for (const child of children.reverse()) child.kill('SIGTERM');
  fs.rmSync(temp, { recursive: true, force: true });
}

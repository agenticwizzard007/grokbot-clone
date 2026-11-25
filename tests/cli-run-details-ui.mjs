import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from '../web/node_modules/vite/dist/node/index.js';
const vite = await createServer({ root: `${process.cwd()}/web`, server: { host: '127.0.0.1', port: 0 } });
await vite.listen();
const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
await mkdir('.context/r6-z-ui', { recursive: true });
const user = { id: 'fixture', email: 'account@example.test', role: 'user' };
const run = { startedAt: Date.now(), provider: 'codex', runtime: 'server', toolsOffered: 0, lastTool: null, result: 'no_tool_call', errorCode: null };
const toolRun = { ...run, startedAt: Date.now() - 20_000, toolsOffered: 12, lastTool: 'SWARM_APPS_EXECUTE', result: 'pending_approval' };
const claudeRun = { ...run, provider: 'claude', runtime: 'bridge', toolsOffered: 4, result: 'error', errorCode: 'timeout' };
const status = { runtime: 'server', serverLoginAvailable: true, selected: 'codex', connected: true, device: 'Swarm server',
  providers: { codex: { installed: true, authenticated: true, subscription: true }, claude: { installed: true, authenticated: true, subscription: true } },
  lastRun: run, runsByProvider: { codex: { latest: run, lastToolRun: toolRun }, claude: { latest: claudeRun, lastToolRun: claudeRun } } };
try {
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      if (route.request().method() !== 'GET') writes.push(route.request().method());
      const p = new URL(route.request().url()).pathname;
      return route.fulfill({ json: p === '/api/cli' ? status : p === '/api/auth/me' ? { user } : p === '/api/models' ? { provider: 'codex-cli', billing: 'plan', models: [], favourites: [] } : {} });
    });
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {AppSettings} from '/src/components/config/AppSettings.tsx';
import {useStore} from '/src/store.ts';
import {useConfigUI} from '/src/configStore.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/mobile.css';
document.documentElement.dataset.theme=${JSON.stringify(theme)};
useStore.setState({user:${JSON.stringify(user)},mobile:innerWidth<760});
useConfigUI.getState().openAppSettings('subscriptions');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(AppSettings)));
` }));
    await page.goto(origin);
    await page.getByRole('tab', { name: 'Codex', exact: true }).click();
    const details = page.locator('.subscription-settings__context');
    await details.locator('summary').click();
    await details.getByText('Reply without tools', { exact: true }).waitFor();
    assert.match(await details.innerText(), /Last tool run[\s\S]*Request with tools[\s\S]*SWARM_APPS_EXECUTE[\s\S]*Pending approval/);
    assert.doesNotMatch(await details.innerText(), /timeout/);
    await details.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `.context/r6-z-ui/${width}-${theme}-codex-runs.png` });
    await page.getByRole('tab', { name: 'Claude Code', exact: true }).click();
    if (!await details.evaluate(el => el.open)) await details.locator('summary').click();
    assert.doesNotMatch(await details.innerText(), /SWARM_APPS_EXECUTE|Reply without tools|Pending approval/);
    assert.match(await details.innerText(), /Error code[\s\S]*timeout/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []); assert.deepEqual(writes, []);
    await page.close();
    console.log(`PASS provider run details and retained tool run ${width} ${theme}`);
  }
} finally { await browser.close(); await vite.close(); }

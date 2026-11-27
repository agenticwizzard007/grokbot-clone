// Real Settings components, local HTTP fixtures only. No sign-in or connection mutations.
// Run: node tests/model-access-status-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const port = server.address().port; server.close(() => resolve(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: `${process.cwd()}/web`, stdio: 'ignore' });
const signedIn = { installed: true, authenticated: true, subscription: true };
const signedOut = { installed: true, authenticated: false, subscription: false };
const fixtures = [
  { name: 'claude-never-set-up', selected: 'codex', claude: false, codex: true, claudeHealth: { ...signedOut, hasSavedState: false } },
  { name: 'claude-missing', selected: 'codex', claude: false, codex: true, claudeHealth: { ...signedOut, installed: false, error: 'CLI executable is not installed.' } },
  { name: 'claude-signed-out', selected: 'codex', claude: false, codex: true, claudeHealth: { ...signedOut, hasSavedState: true } },
  { name: 'claude-probe-error', selected: 'codex', claude: false, codex: true, claudeHealth: { ...signedOut, hasSavedState: true, error: 'Status unavailable. Retry.' } },
  { name: 'codex-only', selected: 'codex', claude: false, codex: true },
  { name: 'claude-only', selected: 'claude', claude: true, codex: false },
  { name: 'both-codex', selected: 'codex', claude: true, codex: true },
  { name: 'both-claude', selected: 'claude', claude: true, codex: true },
  { name: 'neither', selected: null, claude: false, codex: false },
  { name: 'api', selected: null, claude: true, codex: true },
  { name: 'bridge-offline', selected: 'codex', claude: false, codex: false, runtime: 'bridge', connected: false },
  { name: 'selected-not-connected', selected: 'claude', claude: false, codex: true },
  { name: 'status-unavailable', selected: 'codex', claude: true, codex: true, statusUnavailable: true },
];
await mkdir('.context/model-access-status', { recursive: true });
let browser;
try {
  for (let i = 0; i < 100; i++) {
    if (await fetch(origin).then(r => r.ok, () => false)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) for (const fixture of fixtures) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = [], mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    const user = { id: 'models-access-fixture', email: 'models@example.test', role: 'user' };
    const status = { runtime: fixture.runtime ?? 'server', serverLoginAvailable: true, connected: fixture.connected ?? true,
      selected: fixture.selected, device: 'Fixture computer', statusUnavailable: fixture.statusUnavailable,
      providers: { claude: fixture.claudeHealth ?? (fixture.claude ? signedIn : signedOut), codex: fixture.codex ? signedIn : signedOut } };
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') mutations.push(`${request.method()} ${path}`);
      let json = {};
      if (path === '/api/cli') json = status;
      if (path === '/api/cli/reset') { status.selected = null; status.providers = {claude:signedOut,codex:signedOut}; json=status; }
      if (path === '/api/cli/refresh' && fixture.name === 'claude-probe-error') return route.fulfill({ status: 503, json: { error: 'Status unavailable. Retry.' } });
      if (path === '/api/cli/login') json = { id: 'fixture-login', provider: 'claude', state: 'running', output: 'Complete official sign-in.', cursor: 1, reset: false };
      if (path === '/api/cli/login/fixture-login') json = { id: 'fixture-login', provider: 'claude', state: 'running', output: '', cursor: 1, reset: false };
      if (path === '/api/auth/me') json = { user };
      if (path === '/api/models') json = {
        provider: fixture.selected ? `${fixture.selected}-cli` : 'openrouter', billing: fixture.selected ? 'plan' : 'api',
        models: [], favourites: [], plan: fixture.selected === 'claude' ? 'max' : null,
        usage: { available: false, windows: [], checkedAt: Date.now() },
      };
      await route.fulfill({ json });
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
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AppSettings));
` }));
    await page.goto(`${origin}/#settings/subscriptions`);
    const surface = page.locator('.subscription-settings');
    await surface.locator('[data-provider="claude"] [role="status"]').filter({hasNotText:/^Checking$/}).waitFor();
    for (const provider of ['claude', 'codex']) {
      const name = provider === 'claude' ? 'Claude' : 'ChatGPT';
      const row = surface.locator(`[data-provider="${provider}"]`);
      const connected = fixture[provider] && !fixture.statusUnavailable && status.connected;
      const probeError = provider === 'claude' && fixture.name === 'claude-probe-error';
      const expected = fixture.statusUnavailable || probeError || !status.connected ? 'Status unavailable' : connected ? 'Connected' : 'Not connected';
      assert.equal(await row.getByRole('status').innerText(), expected, `${fixture.name}: ${name} owns its status`);
      const saved = fixture[provider] || status.providers[provider].hasSavedState;
      if (saved || connected) {
        if (connected) {
          await row.getByRole('button', {name: `Manage ${name}`, exact: true}).click();
          assert.equal(await page.getByRole('menuitem', {name:'Disconnect', exact:true}).count(), Number(fixture.selected === provider));
          await page.getByRole('menuitem', {name:'Connection details', exact:true}).click();
        } else await row.getByRole('button',{name:'Connect',exact:true}).click();
        const sheet = page.getByRole('dialog');
        await sheet.locator('summary').filter({hasText:'Learn more'}).click();
        const detail = await sheet.innerText();
        if (fixture.statusUnavailable) assert.match(detail,/could not be verified/);
        else if (fixture.selected && (!fixture[fixture.selected] || !status.connected)) assert.match(detail,/connection is not ready/);
        else if (!fixture.selected) assert.match(detail,/Your Bots currently use API providers/);
        else assert.match(detail,new RegExp(`Your Bots currently use your ${fixture.selected === 'claude' ? 'Claude' : 'ChatGPT'} plan`));
        assert.equal(await sheet.locator('.provider-icon').first().evaluate(el=>el.getBoundingClientRect().width),16);
        await sheet.getByRole('button',{name:'Close',exact:true}).click();
      } else assert.equal(await row.getByRole('button',{name:'Connect',exact:true}).count(),1);
      assert.equal(await surface.evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
    }
    assert.deepEqual(mutations, [], 'viewing status and details never changes billing or signs in');
    if (fixture.name === 'claude-never-set-up' || fixture.name === 'claude-missing') {
      await surface.locator('[data-provider="claude"]').getByRole('button',{name:'Connect',exact:true}).click();
      assert.deepEqual(mutations, [], 'opening the sheet does not start sign-in');
      await page.getByRole('dialog').getByRole('button',{name:'Sign in',exact:true}).click();
      await page.getByLabel('Claude Code login terminal input').waitFor();
      assert.ok(mutations.includes('POST /api/cli/login'));
      assert.equal(mutations.includes('PUT /api/cli'),false,'authentication precedes route switching');
    }
    if (fixture.name === 'claude-probe-error') {
      await surface.locator('[data-provider="claude"]').getByRole('button',{name:'Connect',exact:true}).click();
      const sheet = page.getByRole('dialog');
      await sheet.locator('summary').filter({hasText:'Learn more'}).click();
      await sheet.getByRole('button',{name:'Manage saved connection',exact:true}).click();
      await page.getByRole('menuitem',{name:'Refresh status',exact:true}).click();
      await sheet.getByRole('button',{name:'Close',exact:true}).click();
      await page.getByRole('button',{name:'Retry',exact:true}).waitFor();
    }
    if(fixture.name==='both-codex') {
      await surface.getByRole('button',{name:'Manage Claude',exact:true}).click();
      await page.getByRole('menuitem',{name:'Reset connection',exact:true}).click();
      await page.getByRole('button',{name:'Confirm reset',exact:true}).waitFor();
      assert.deepEqual(mutations,[],'reset requires explicit confirmation');
      await page.getByRole('button',{name:'Cancel',exact:true}).click();
      assert.deepEqual(mutations,[],'cancelling reset changes nothing');
      await surface.getByRole('button',{name:'Manage Claude',exact:true}).click();
      await page.getByRole('menuitem',{name:'Reset connection',exact:true}).click();
      await page.getByRole('button',{name:'Confirm reset',exact:true}).click();
      await surface.getByText('Connections reset. Sign in to reconnect.',{exact:true}).waitFor();
      assert.ok(mutations.includes('POST /api/cli/reset'));
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${width}px ${theme} ${fixture.name}: provider rows, own status, route details, actions and overflow`);
  }
} finally {
  await browser?.close(); vite.kill();
  await new Promise(resolve => vite.exitCode !== null ? resolve() : vite.once('exit', resolve));
}

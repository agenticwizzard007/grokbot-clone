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
    const connection = page.getByRole('region', { name: 'Plan connection', exact: true });
    await connection.getByRole('status').filter({ hasNotText: 'Checking' }).waitFor();
    for (const provider of ['claude', 'codex']) {
      const cli = provider === 'claude' ? 'Claude Code' : 'Codex';
      const plan = provider === 'claude' ? 'Claude plan' : 'ChatGPT plan';
      await page.getByRole('tab', { name: cli, exact: true }).click();
      const panel = page.getByRole('tabpanel', { name: cli, exact: true });
      const connected = fixture[provider] && !fixture.statusUnavailable && status.connected;
      const active = connected && fixture.selected === provider;
      const probeError = provider === 'claude' && fixture.name === 'claude-probe-error';
      const expected = fixture.statusUnavailable || probeError ? 'Status unavailable' : connected ? `Connected${active ? ' · Currently in use' : ''}` : 'Not connected';
      assert.equal(await connection.getByRole('status').innerText(), expected, `${fixture.name}: ${cli} owns its connection status`);
      assert.equal(await connection.getByRole('status').count(), 1);
      assert.equal(await panel.locator('.cfg-row__title').filter({ hasText: new RegExp(`^${cli}$`) }).count(), 0, 'no duplicate runtime row');
      assert.equal(await panel.getByText(/\bActive\b/).count(), 0, 'no mixed Active label');
      if (!fixture.statusUnavailable && !probeError && status.connected) {
        assert.match(await connection.innerText(), new RegExp(`${cli} ${status.providers[provider].installed ? 'installed' : 'not installed'} · ${fixture[provider] ? 'Signed in' : 'Not signed in'}`));
        if (!active) assert.equal(await connection.getByRole('button', { name: `${connected ? 'Use' : 'Connect'} ${plan}`, exact: true }).count(), 1);
        assert.equal(await connection.locator('button.cfg-btn--primary').count(), active ? 0 : 1, 'one primary connection action');
      }
      const sentence = panel.locator('.subscription-settings__current-route');
      assert.equal(await sentence.count(), 1);
      const routeText = await sentence.innerText();
      if (fixture.statusUnavailable) assert.match(routeText, /could not be verified/);
      else if (fixture.selected && (!fixture[fixture.selected] || !status.connected)) assert.match(routeText, /connection is not ready/);
      else if (!fixture.selected) assert.match(routeText, /^Your Bots currently use API providers;/);
      else assert.match(routeText, new RegExp(`^Your Bots currently use your ${fixture.selected === 'claude' ? 'Claude plan through Claude Code' : 'ChatGPT plan through Codex'}`));
      assert.equal(await panel.locator('p').filter({ hasText: /^Your Bots (currently use|are set to use)/ }).count(), fixture.statusUnavailable ? 0 : 1);
      assert.equal(await panel.getByLabel('Connected plan usage', { exact: true }).count(), active ? 1 : 0, 'usage belongs only to this tab');
      const saved = fixture[provider] || status.providers[provider].hasSavedState;
      assert.equal(await panel.getByRole('button', { name: 'Reset connection', exact: true }).count(), 0, 'reset stays hidden until Advanced is opened');
      assert.equal(await panel.getByRole('button', { name: 'Disconnect', exact: true }).count(), Number(fixture.selected === provider), 'disconnect belongs only to the selected route');
      assert.equal(await connection.getByText(/Disconnect switches/).count(), Number(fixture.selected === provider), 'disconnect copy belongs only to the selected CLI');
      assert.equal(await panel.locator('.cfg-error').count(), 0, 'status errors are quiet inline text');
      if (probeError) {
        assert.match(await connection.innerText(), /Claude Code status could not be verified/);
        await connection.getByRole('button', { name: 'Retry status', exact: true }).waitFor();
      }
      for (const title of ['CLI authentication', 'API providers', 'Authorization status', 'Provider instructions']) {
        await panel.locator('.cfg-row__title').getByText(title, { exact: true }).waitFor();
      }
      await panel.locator('.subscription-settings__context > summary').click();
      await panel.locator('.subscription-settings__advanced > summary').click();
      const advanced = panel.locator('.subscription-settings__advanced');
      const reset = advanced.getByRole('button', { name: 'Reset connection', exact: true });
      assert.equal(await reset.count(), Number(!!saved), 'Advanced reset belongs only to a CLI with saved state');
      assert.equal(await advanced.locator('.cfg-btn--primary').filter({ hasText: 'Reset connection' }).count(), 0);
      if (fixture.name.startsWith('both-')) {
        await reset.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `.context/model-access-status/${fixture.name}-${provider}-${width}-${theme}-advanced.png` });
        await reset.click();
        await advanced.getByRole('button', { name: 'Confirm reset', exact: true }).waitFor();
        const other = provider === 'claude' ? 'Codex' : 'Claude Code';
        await page.getByRole('tab', { name: other, exact: true }).click();
        assert.equal(await page.getByRole('button', { name: 'Confirm reset', exact: true }).count(), 0, 'switching tabs cancels confirmation');
        await page.getByRole('tab', { name: cli, exact: true }).click();
      }
      const overflow = await panel.evaluate(el => ({
        document: document.documentElement.scrollWidth > innerWidth,
        panel: el.scrollWidth > el.clientWidth + 1,
        outside: [...el.querySelectorAll('*')].filter(node => {
          const box = node.getBoundingClientRect();
          return box.width && (box.left < -1 || box.right > innerWidth + 1);
        }).map(node => node.className),
      }));
      assert.deepEqual(overflow, { document: false, panel: false, outside: [] }, `${width} ${theme} ${fixture.name} ${cli}: no horizontal overflow`);
      await panel.locator('.subscription-settings__advanced > summary').click();
      await panel.locator('.subscription-settings__context > summary').click();
      if (fixture.name.startsWith('both-') || ['codex-only', 'claude-never-set-up', 'claude-probe-error'].includes(fixture.name) && provider === 'claude') {
        await panel.evaluate(el => el.closest('.app-settings__content')?.scrollTo(0, 0));
        await page.getByRole('tab', { name: cli, exact: true }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: `.context/model-access-status/${fixture.name}-${provider}-${width}-${theme}.png` });
      }
    }
    assert.deepEqual(mutations, [], 'viewing tabs must never start sign-in or change the model route');
    if (fixture.name === 'claude-never-set-up' || fixture.name === 'claude-missing') {
      await page.getByRole('tab', { name: 'Claude Code', exact: true }).click();
      const connect = connection.getByRole('button', { name: 'Connect Claude plan', exact: true });
      assert.equal(await connect.isEnabled(), true);
      await connect.click();
      await page.getByLabel('Claude Code login terminal input').waitFor();
      assert.ok(mutations.includes('POST /api/cli/login'), 'explicit Connect opens the existing login flow');
      assert.equal(mutations.some(m => m === 'PUT /api/cli'), false, 'no route switch before authentication');
    }
    if (fixture.name === 'claude-probe-error') {
      await page.getByRole('tab', { name: 'Claude Code', exact: true }).click();
      await connection.getByRole('button', { name: 'Retry status', exact: true }).click();
      await page.getByRole('note').filter({ hasText: 'Connection status could not be verified.' }).waitFor();
      assert.equal(await page.locator('.subscription-settings .cfg-error').count(), 0, 'failed refresh also stays quiet');
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${width}px ${theme} ${fixture.name}: both tabs, own status, current route, actions, usage and overflow`);
  }
} finally {
  await browser?.close(); vite.kill();
  await new Promise(resolve => vite.exitCode !== null ? resolve() : vite.once('exit', resolve));
}

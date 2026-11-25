// Real picker and Settings components with controlled CLI/HTTP responses. No live login.
// Run: node tests/plan-connections-ui.mjs
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: `${process.cwd()}/web`, stdio: 'ignore' });
let browser;
await mkdir('.context/plan-connections', { recursive: true });
try {
  for (let i = 0; i < 100; i++) { if (await fetch(origin).then(r => r.ok, () => false)) break; await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const width of [1280, 390, 320]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', () => errors.push('Browser component error'));
    const user = { id: 'plan-test-account', email: 'plans@example.test', role: 'user' };
    let status = { runtime: 'server', serverLoginAvailable: true, selected: null, connected: true, device: 'Bot computer', providers: {
      claude: { installed: true, authenticated: false, subscription: false }, codex: { installed: true, authenticated: false, subscription: false },
    } };
    let loginProvider = null, loginComplete = false, failStatus = false, failSelection = false;
    const mutations = [];
    const pairingSecret = randomBytes(24).toString('hex');
    const bot = { id: 'plan-test-bot', name: 'Test Bot', model: 'api/model', effort: 'high', fast: false };
    const catalog = () => {
      const provider = status.selected;
      const models = [{ id: provider === 'codex' ? 'codex/default' : provider === 'claude' ? 'claude/account-model' : 'api/model',
        name: provider === 'codex' ? 'Codex CLI default' : provider === 'claude' ? 'Plan model' : 'API model',
        author: provider === 'claude' ? 'anthropic' : 'openai', efforts: [], defaultEffort: null, reasoning: false, vision: true, context: 0,
        billing: provider ? 'plan' : 'api' }].map(m => ({ ...m, short: m.name }));
      return { provider: provider ? `${provider}-cli` : 'openrouter', billing: provider ? 'plan' : 'api', canFast: !provider,
        models, favourites: models.map(m => m.id), defaultModel: models[0].id, plan: provider === 'claude' ? 'max' : null,
        usage: { available: false, windows: [], checkedAt: Date.now() } };
    };
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      const respond = (json, code = 200) => route.fulfill({ status: code, json });
      if (path.startsWith('/api/cli')) {
        assert.equal(url.searchParams.get('expectedUserId'), user.id);
        if (request.method() !== 'GET') mutations.push({ path, method: request.method(), provider: request.postDataJSON()?.provider });
        if (path === '/api/cli' && request.method() === 'PUT') {
          if (failSelection) return respond({ error: 'Selection failed' }, 503);
          status.selected = request.postDataJSON().provider; return respond(status);
        }
        if (path === '/api/cli/pair' && request.method() === 'POST') {
          status = { ...status, runtime: 'bridge', connected: false };
          return respond({ command: `node swarm-cli-bridge.mjs --server '${origin}' --token '${pairingSecret}'` });
        }
        if (path === '/api/cli/login' && request.method() === 'POST') {
          loginProvider = request.postDataJSON().provider; loginComplete = false;
          return respond({ id: 'fixture-login', provider: loginProvider, state: 'running', output: 'Complete the official CLI login.\r\n', cursor: 1, reset: false });
        }
        if (path === '/api/cli/login/fixture-login' && request.method() === 'GET') {
          if (loginComplete) {
            status.selected = loginProvider;
            status.providers[loginProvider] = { installed: true, authenticated: true, subscription: true };
          }
          return respond({ id: 'fixture-login', provider: loginProvider, state: loginComplete ? 'connected' : 'running', output: '', cursor: 1, reset: false });
        }
        if (path === '/api/cli' || path === '/api/cli/refresh') return failStatus ? respond({ error: 'Status unavailable' }, 503) : respond(status);
        return respond({ ok: true });
      }
      if (path === '/api/models' || path === '/api/settings/models') return respond(catalog());
      if (path === '/api/auth/me') return respond({ user });
      if (path === '/api/providers/openrouter') return respond({ connected: true, active: true, model: 'api/model', defaultModel: 'api/model', settingsUrl: 'https://openrouter.ai/settings/keys' });
      if (path === '/api/settings/keys') {
        const key = { set: false, source: null };
        return respond({ canEdit: true, voice: key, direct: key, composio: key, openrouter: key,
          model: { value: '', source: null }, openrouterModel: { value: 'api/model', source: null }, provider: { value: 'openrouter', chosen: 'openrouter', source: null } });
      }
      return respond({});
    });
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {ComposerModelMenu} from '/src/components/ComposerModelMenu.tsx';
import {AppSettings} from '/src/components/config/AppSettings.tsx';
import {useStore} from '/src/store.ts';
import {useConfigUI} from '/src/configStore.ts';
import {useModels} from '/src/lib/models.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/composer-models.css';import '/src/styles/mobile.css';
document.documentElement.dataset.theme=${JSON.stringify(theme)};
useStore.setState({user:${JSON.stringify(user)},mobile:innerWidth<760,bots:[${JSON.stringify(bot)}],selectedBotId:${JSON.stringify(bot.id)}});
window.closeSettings=()=>useConfigUI.getState().closeAppSettings();
window.refreshModels=()=>useModels.getState().load(true);
window.settingsSection=()=>useConfigUI.getState().appSettings;
function Harness(){const section=useConfigUI(s=>s.appSettings);return section?React.createElement(AppSettings):React.createElement('div',{style:{position:'absolute',left:'8px',bottom:'24px'}},React.createElement(ComposerModelMenu,{bot:${JSON.stringify(bot)}}));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));
` }));
    await page.goto(origin);
    const openPlans = async () => {
      await page.locator('.model-pill').click();
      await page.getByRole('button', { name: 'Connect plan', exact: true }).click();
      await page.getByRole('region', { name: 'Connect a plan', exact: true }).waitFor();
    };
    const closeSettings = () => page.evaluate(() => window.closeSettings());
    await openPlans();
    await page.getByText('Not connected', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('Not connected', { exact: true }).count(), 2);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'Connect plan', exact: true }).evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.screenshot({ path: `.context/plan-connections/picker-${width}-${theme}.png` });

    for (const provider of ['claude', 'codex']) {
      const label = provider === 'claude' ? 'Claude' : 'ChatGPT';
      await page.getByRole('button', { name: `Connect ${label} plan`, exact: true }).click();
      await page.getByRole('tab', { name: provider === 'claude' ? 'Claude Code' : 'Codex', exact: true }).waitFor();
      assert.equal(await page.getByRole('tab', { name: provider === 'claude' ? 'Claude Code' : 'Codex', exact: true }).getAttribute('aria-selected'), 'true');
      const connection = page.getByRole('region', { name: 'Plan connection', exact: true });
      await connection.getByRole('button', { name: 'Connect plan', exact: true }).click();
      await page.getByRole('region', { name: /login terminal$/ }).waitFor();
      assert.equal(loginProvider, provider);
      loginComplete = true;
      await connection.getByText(provider === 'claude' ? 'Connected as max' : 'Connected', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await closeSettings();
      await page.locator('.model-pill').click();
      await page.locator('.mm-row__main').first().waitFor();
      assert.equal(await page.locator('.mm-row__main').filter({ hasText: 'API model' }).count(), 0);
      if (provider === 'codex') {
        await page.getByText('Codex picks the model for each request. Uses your ChatGPT plan. Check plan limits in your ChatGPT account.', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Effort', exact: true }).count(), 0);
      }
      await page.getByRole('button', { name: 'Connect plan', exact: true }).click();
      await page.getByRole('button', { name: `Manage ${label} plan`, exact: true }).click();
      if (provider === 'claude') {
        failSelection = true;
        await connection.getByRole('button', { name: 'Disconnect', exact: true }).click();
        await page.getByText('Selection failed', { exact: true }).waitFor();
        assert.equal(status.selected, 'claude'); failSelection = false;
      }
      await connection.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await connection.getByText('Not connected', { exact: true }).waitFor();
      assert.equal(status.providers[provider].authenticated, true);
      assert.ok(!mutations.some(m => m.path === '/api/cli/reset' || (m.path === '/api/cli/pair' && m.method === 'DELETE')), 'disconnect must not remove CLI credentials');
      await closeSettings(); await page.locator('.model-pill').filter({ hasText: 'API model' }).waitFor();
      await openPlans();
    }

    await page.getByRole('button', { name: 'Manage API keys', exact: true }).click();
    await page.getByRole('region', { name: 'Connect a plan', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.settingsSection()), 'keys');
    await page.getByRole('button', { name: 'Connect Claude plan', exact: true }).click();
    await page.getByRole('region', { name: 'Plan connection', exact: true }).waitFor();
    await page.locator('.subscription-settings__advanced > summary').click();
    await page.getByRole('button', { name: 'Generate connect command', exact: true }).click();
    await page.getByLabel('Connect command, secret hidden', { exact: true }).waitFor();
    assert.equal((await page.content()).includes(pairingSecret), false, 'pairing secret must stay out of rendered HTML');
    await page.getByRole('button', { name: 'Copy connect command', exact: true }).click();
    assert.equal(await page.evaluate(value => navigator.clipboard.readText().then(text => text.includes(value)), pairingSecret), true);
    await page.screenshot({ path: `.context/plan-connections/masked-pairing-${width}-${theme}.png` });
    await closeSettings();

    status = { ...status, runtime: 'server', connected: true, providers: { ...status.providers, claude: { installed: false, authenticated: false, subscription: false } } };
    await openPlans(); await page.getByText('CLI missing', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Connect Claude plan', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: 'Plan connection', exact: true }).getByRole('button', { name: 'Connect plan', exact: true }).isDisabled(), true);
    await closeSettings();
    status = { ...status, runtime: 'bridge', connected: false };
    await openPlans(); await page.getByText('Not connected', { exact: true }).first().waitFor();
    await page.getByText('CLI missing', { exact: true }).waitFor({ state: 'hidden' }); // Cached status remains visible until revalidation completes.
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    failStatus = true;
    await openPlans(); await page.getByText('Status unavailable', { exact: true }).first().waitFor();
    assert.deepEqual(errors, []);
    assert.ok(await page.locator('.model-pill__name').evaluate(el => getComputedStyle(el).whiteSpace === 'nowrap'));
    await context.close();
    console.log(`PASS ${width}px ${theme}: picker entry, official login dispatch, status, catalog, disconnect, API fallback and pairing masking`);
  }
} finally { await browser?.close(); vite.kill(); await new Promise(resolve => vite.exitCode !== null ? resolve() : vite.once('exit', resolve)); }

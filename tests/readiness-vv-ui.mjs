// Real settings components with local HTTP fixtures. No live login or provider account.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: `${process.cwd()}/web`, stdio: 'ignore' });
const screenshots = '.context/readiness-vv';
await mkdir(screenshots, { recursive: true });
let browser;
try {
  for (let i = 0; i < 100; i++) { if (await fetch(origin).then(r => r.ok, () => false)) break; await new Promise(r => setTimeout(r, 100)); }
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const section of ['subscriptions', 'keys']) for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const user = { id: 'ordinary-signin-fixture', email: 'member@example.test', role: 'user' };
    const status = { runtime: 'server', serverLoginAvailable: true, selected: 'codex', connected: true, device: 'Bot computer', providers: {
      codex: { installed: true, authenticated: true, subscription: true }, claude: { installed: true, authenticated: true, subscription: true },
    } };
    let saved = null, enabled = false, recent = true, cliLogins = 0;
    const first = 'placeholder-openrouter-1111', second = 'placeholder-openrouter-2222';
    const connection = () => ({ connected: !!saved, linked: false, selected: enabled, active: enabled && !status.selected,
      hint: saved ? `…${saved.slice(-4)}` : null, source: saved ? 'manual' : null, model: 'test/model', defaultModel: 'test/model',
      provider: status.selected ? `${status.selected}-cli` : 'openrouter', settingsUrl: 'https://openrouter.ai/keys' });
    const models = [{ id: 'test/model', name: 'Fixture model', short: 'Fixture model', author: 'test', efforts: [], defaultEffort: null, reasoning: false, vision: true, context: 0 }];
    await page.route('**/api/**', async route => {
      const req = route.request(), path = new URL(req.url()).pathname, method = req.method();
      const respond = (json, code = 200) => route.fulfill({ status: code, json });
      if (path === '/api/auth/me') return respond({ user });
      if (path === '/api/cli' && method === 'PUT') { status.selected = req.postDataJSON().provider; if (!status.selected && saved) enabled = true; return respond(status); }
      if (path === '/api/cli' || path === '/api/cli/refresh') return respond(status);
      if (path === '/api/cli/login') { cliLogins++; return respond({ error: 'Unexpected CLI login' }, 400); }
      if (path === '/api/cli/reauth') return respond({ ok: true });
      if (path === '/api/providers/openrouter/key') {
        if (!recent) return respond({ error: 'Sign in again before changing your key.', code: 'reauth_required' }, 401);
        if (method === 'DELETE') saved = null;
        else {
          const value = req.postDataJSON().key;
          if (![first, second].includes(value)) return respond({ error: 'OpenRouter rejected this key. Check that it is active and has not expired.' }, 400);
          if (!saved) enabled = true;
          saved = value;
        }
        return respond(connection());
      }
      if (path === '/api/providers/openrouter') {
        if (method === 'PUT') { enabled = req.postDataJSON().enabled; if (enabled) status.selected = null; }
        return respond(connection());
      }
      if (path === '/api/models' || path === '/api/settings/models') return respond({ provider: connection().provider, billing: status.selected ? 'plan' : 'api', models, favourites: ['test/model'], defaultModel: 'test/model' });
      if (path === '/api/settings/keys') {
        const key = { set: false, source: null };
        return respond({ canEdit: false, voice: key, direct: key, composio: key, openrouter: key,
          model: { value: '', source: null }, openrouterModel: { value: 'test/model', source: null }, provider: { value: 'openrouter', chosen: 'openrouter', source: null } });
      }
      return respond({});
    });
    // Boot an ordinary signed-in customer, without an OpenRouter login identity.
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {AppSettings} from '/src/components/config/AppSettings.tsx';
import {useStore} from '/src/store.ts';
import {useConfigUI} from '/src/configStore.ts';
import '/src/styles/tokens.css';import '/src/styles/base.css';import '/src/styles/mobile.css';
useStore.setState({user:${JSON.stringify(user)},googleLogin:true,mobile:innerWidth<760});
useConfigUI.getState().setTheme(${JSON.stringify(theme)});
useConfigUI.getState().openAppSettings(${JSON.stringify(section)});
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(AppSettings));
` }));
    await page.goto(origin);
    const panel = page.getByRole('region', { name: 'Your OpenRouter connection', exact: true });
    const planRoute = panel.getByText('In use now: ChatGPT plan. Bot turns are billed to that plan. Your personal OpenRouter key is not used for plan turns.', { exact: true });
    await planRoute.waitFor();
    await panel.getByText('Add your own OpenRouter key here. Your ChatGPT or Claude plan stays signed in when you add, replace or remove a key.', { exact: true }).waitFor();
    await panel.getByText(/Your saved key is never shown again/).waitFor();
    const input = panel.locator('input[type=password]');
    const save = async value => { await input.fill(value); await panel.getByRole('button', { name: 'Save & verify key', exact: true }).click(); };
    await save(first);
    await panel.getByText('Key verified and saved.', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '');
    await panel.getByText('Manual key · …1111', { exact: true }).waitFor();
    assert.equal(status.selected, 'codex'); assert.equal(status.providers.codex.authenticated, true);
    assert.ok(!(await page.content()).includes(first));
    await save('invalid-placeholder');
    await panel.getByRole('alert').waitFor();
    assert.equal(saved, first); assert.equal(await input.inputValue(), '');
    await save(second);
    await panel.getByText('Manual key · …2222', { exact: true }).waitFor();
    await planRoute.waitFor();
    assert.equal(status.selected, 'codex');
    assert.ok(!(await page.content()).includes(second));
    assert.ok(!(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).includes(second));
    await input.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshots}/${section}-${width}-${theme}-plan.png` });
    await panel.getByRole('button', { name: 'Use server API defaults', exact: true }).click();
    await panel.getByText('Personal OpenRouter billing is off. Any selected plan stays in use.', { exact: true }).waitFor();
    assert.equal(status.selected, 'codex'); assert.equal(enabled, false);
    if (section === 'subscriptions') await page.getByRole('button', { name: 'Use API providers', exact: true }).click();
    else await panel.getByRole('button', { name: 'Use my OpenRouter credits', exact: true }).click();
    await panel.getByText('In use now: your OpenRouter key. You pay OpenRouter for Bot turns.', { exact: true }).waitFor();
    assert.equal(enabled, true); assert.equal(status.selected, null); assert.equal(status.providers.codex.authenticated, true);
    if (section === 'subscriptions') await page.getByRole('region', { name: 'Plan connection', exact: true }).getByText('Connected', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Use server API defaults', exact: true }).click();
    await panel.getByText('In use now: server API defaults. Usage is billed to the account that supplies those credentials.', { exact: true }).waitFor();
    assert.equal(enabled, false); assert.equal(saved, second);
    await panel.getByRole('button', { name: 'Use my OpenRouter credits', exact: true }).click();
    await panel.getByText('In use now: your OpenRouter key. You pay OpenRouter for Bot turns.', { exact: true }).waitFor();
    await panel.locator('.openrouter-settings__route').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshots}/${section}-${width}-${theme}-api.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.app-settings__main').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    if (section === 'subscriptions') {
      await page.getByRole('button', { name: 'Use ChatGPT plan', exact: true }).click();
      await planRoute.waitFor();
    }
    recent = false;
    await save(first);
    await page.getByRole('heading', { name: 'Confirm it’s you', exact: true }).waitFor();
    assert.equal(saved, second); assert.equal(await input.inputValue(), '');
    recent = true;
    if (section === 'subscriptions') {
      // Simulate the return from ordinary sign-in, preserving the credential intent.
      // This must not start a CLI login or retry a discarded secret automatically.
      await page.reload();
      await page.getByText('Your session is ready. Review the connection status before choosing Save and verify or remove your key.', { exact: true }).waitFor();
      await planRoute.waitFor();
      assert.equal(cliLogins, 0); assert.equal(saved, second);
      assert.equal(await input.inputValue(), '');
    } else await page.getByRole('button', { name: 'Not now', exact: true }).click();
    await panel.getByRole('button', { name: 'Disconnect key', exact: true }).click();
    await panel.getByRole('button', { name: 'Remove my key', exact: true }).click();
    await panel.getByText('Key removed from Swarm.', { exact: true }).waitFor();
    assert.equal(saved, null); assert.equal(status.providers.codex.authenticated, true);
    if (section === 'subscriptions') { assert.equal(status.selected, 'codex'); await planRoute.waitFor(); }
    else await panel.getByText(/Personal OpenRouter billing is selected, but your key is missing/).waitFor();
    assert.deepEqual(errors, []);
    console.log(`PASS ${section} ${width}px ${theme}: add, verify, mask, reject, replace, preserve plan, personal billing, explicit server billing, reauth and remove`);
    await context.close();
  }
} finally { await browser?.close(); vite.kill(); await new Promise(resolve => vite.exitCode !== null ? resolve() : vite.once('exit', resolve)); }

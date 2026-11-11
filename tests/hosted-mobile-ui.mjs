// Real Settings component with controlled HTTP responses; no live provider login.
// node tests/hosted-mobile-ui.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const value = server.address().port; server.close(() => resolve(value));
  });
});
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port)], { cwd: `${process.cwd()}/web`, stdio: 'pipe' });
let logs = '', browser;
vite.stdout.on('data', data => logs += data); vite.stderr.on('data', data => logs += data);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
const ready = { installed: true, authenticated: true, subscription: true };
const missing = { installed: false, authenticated: false, subscription: false };
const hosted = { runtime: 'server', serverLoginAvailable: true, selected: 'codex', connected: true, device: 'Swarm server', providers: { codex: ready, claude: ready } };

try {
  await mkdir('.context/hosted-mobile', { recursive: true });
  for (let n = 0; n < 100; n++) { if (await fetch(origin).then(r => r.ok, () => false)) break; await pause(100); }
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  for (const width of [390, 768, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1024 } });
    page.setDefaultTimeout(8000);
    const errors = [], mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    let account = 'alice', failStatus = false, modelReads = 0, nextStatusGate, status = { ...hosted, runtime: 'bridge', connected: false, device: null, providers: { codex: missing, claude: missing } };
    const initial = deferred(); nextStatusGate = initial;
    await page.route('**/api/**', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname === '/api/cli' && request.method() === 'GET') {
        const value = account === 'bob' ? { ...hosted, selected: null, connected: false, providers: { codex: missing, claude: missing } } : structuredClone(status);
        const gate = nextStatusGate; nextStatusGate = undefined;
        if (gate) await gate.promise;
        return route.fulfill(failStatus ? { status: 503, json: { error: 'Status check unavailable' } } : { json: value });
      }
      if (pathname === '/api/cli/refresh') return route.fulfill({ json: status });
      if (pathname === '/api/cli/pair') {
        mutations.push(pathname);
        return route.fulfill({ json: { command: 'node bridge --token alice-private-pairing' } });
      }
      if (pathname === '/api/models') { modelReads++; return route.fulfill({ json: { provider: 'codex-cli', billing: 'plan', models: [], favourites: [], defaultModel: null, canFast: false } }); }
      if (request.method() !== 'GET') mutations.push(pathname);
      return route.fulfill({ json: {} });
    });
    await page.route('**/src/main.tsx', route => route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import {SubscriptionSettings} from '/src/components/config/SubscriptionSettings.tsx';
import {useStore} from '/src/store.ts';
import {useConfigUI} from '/src/configStore.ts';
import '/src/styles/tokens.css'; import '/src/styles/base.css'; import '/src/styles/config.css'; import '/src/styles/settings.css';
document.documentElement.dataset.theme='light';
window.setAccount=id=>useStore.setState({user:{id,email:id+'@example.test',name:id}});
window.computerSection=()=>useConfigUI.getState().appSettings;
window.setAccount('alice');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement('main',{className:'app-settings__page',style:{maxWidth:'760px',margin:'0 auto',padding:'24px'}},React.createElement(SubscriptionSettings)));
` }));
    await page.goto(origin);
    await page.getByText('Checking status…', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Login', exact: true }).isDisabled(), true, 'unknown runtime cannot initiate a hosted login');
    assert.equal(await page.getByRole('button', { name: 'Use API providers', exact: true }).isDisabled(), true);
    initial.resolve();
    await page.getByText('Computer bridge offline', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Use server login', exact: true }).isEnabled(), true);
    assert.match(await page.locator('.subscription-settings__connection').innerText(), /same Swarm account/);
    assert.deepEqual(mutations, [], 'reading a bridge preference must never switch its runtime or billing');
    await page.screenshot({ path: `.context/hosted-mobile/bridge-offline-${width}.png`, fullPage: true });

    // A failed status read cannot leave an enabled Login with an unknown location.
    failStatus = true;
    const failed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/cli' && response.status() === 503);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await failed;
    await page.getByText('Status check unavailable', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Use server login', exact: true }).isDisabled(), true);

    // Hosted credentials must not appear as authenticated computer-bridge credentials.
    failStatus = false; status = structuredClone(hosted);
    const oldModelReads = modelReads;
    const reloadedModels = page.waitForResponse(response => new URL(response.url()).pathname === '/api/models');
    await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await reloadedModels;
    assert.ok(modelReads > oldModelReads, 'a runtime change refreshes models/plan usage even when the selected provider is unchanged');
    await page.locator('summary').click();
    assert.equal(await page.getByText('Connect the bridge to check this computer.', { exact: true }).count(), 2);
    assert.equal(await page.getByText('Ready', { exact: true }).count(), 0);
    await page.locator('summary').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `.context/hosted-mobile/hosted-${width}.png`, fullPage: true });

    // Clear secrets immediately on account change, including an old pending read.
    await page.locator('summary').click();
    const late = deferred(); nextStatusGate = late;
    await page.getByRole('button', { name: 'Generate connect command', exact: true }).click();
    await page.getByLabel('Connect command', { exact: true }).waitFor();
    assert.match(await page.getByLabel('Connect command', { exact: true }).innerText(), /alice-private-pairing/);
    account = 'bob';
    await page.evaluate(() => window.setAccount('bob'));
    await page.getByText('bob@example.test', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Connect command', { exact: true }).count(), 0);
    late.resolve();
    await page.getByText('API providers selected', { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(), /alice-private-pairing|alice@example.test/);
    await page.getByRole('button', { name: 'Computer settings', exact: true }).click();
    assert.equal(await page.evaluate(() => window.computerSection()), 'computer');
    assert.deepEqual(mutations, ['/api/cli/pair']);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${width}px: pending/stale runtime guard, offline bridge, hosted status isolation, account/secret reset, computer settings link, no overflow`);
  }
} catch (error) {
  console.error(logs.slice(-3000));
  throw error;
} finally {
  await browser?.close(); vite.kill('SIGTERM');
  await new Promise(resolve => vite.exitCode !== null ? resolve() : vite.once('exit', resolve));
}

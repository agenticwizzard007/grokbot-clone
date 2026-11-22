// Real suggestion and logo components. All API and connection operations are local fixtures.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const port = await new Promise(resolve => { const server = http.createServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const origin = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
let log = '', browser;
vite.stdout.on('data', chunk => { log += chunk; }); vite.stderr.on('data', chunk => { log += chunk; });
const app = (slug, name, reason) => ({ slug, name, reason, logo: `https://logos.composio.dev/api/${slug}`, categories: [], managedAuth: true, noAuth: false });
const github = app('github', 'GitHub', 'Track pull requests and review progress.');
const slack = app('slack', 'Slack', 'Post review updates to the team.');
const calendar = app('googlecalendar', 'Google Calendar', 'Manage events and upcoming meetings.');
try {
  await mkdir('.context/suggestions', { recursive: true });
  let ready = false;
  for (let i = 0; i < 150; i++) { if (await fetch(origin).then(response => response.ok, () => false)) { ready = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(ready, log);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [900, 390, 320]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme: theme });
    page.setDefaultTimeout(8000);
    const errors = [], requests = [], connects = [], iconPaths = [];
    let connected = false, held;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.violations = [];
      document.addEventListener('securitypolicyviolation', event => window.violations.push(event.violatedDirective));
      window.open = () => { const popup = { closed: false, location: { href: '' }, close() { this.closed = true; } }; window.fixturePopup = popup; return popup; };
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { errors.push('External request attempted'); return route.abort(); }
      if (url.pathname === '/') {
        const response = await route.fetch();
        return route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': "img-src 'self' data: blob:; object-src 'none'" } });
      }
      if (url.pathname === '/src/main.tsx') return route.fulfill({ contentType: 'application/javascript', body: `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import { SuggestedIntegrations } from '/src/components/SuggestedIntegrations.tsx';
import { useStore } from '/src/store.ts';
import '/src/styles/tokens.css'; import '/src/styles/base.css'; import '/src/styles/config.css';
document.documentElement.dataset.theme = ${JSON.stringify(theme)};
useStore.setState({ user: { id: 'owner', name: 'Test account' } });
window.refreshConnections = () => useStore.setState(state => ({ connectionsVersion: state.connectionsVersion + 1 }));
window.switchAccount = () => useStore.setState({ user: { id: 'another-account', name: 'Another account' } });
function Harness() {
  const [description, setDescription] = React.useState('track GitHub PRs and post to Slack');
  return React.createElement('main', { style: { margin: '24px auto', padding: '16px', maxWidth: '640px' } },
    React.createElement('label', { htmlFor: 'about' }, 'About'),
    React.createElement('textarea', { id: 'about', className: 'text-input', value: description, onChange: event => setDescription(event.target.value) }),
    React.createElement(SuggestedIntegrations, { botId: 'review-bot', description, instructions: '' }));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Harness));` });
      if (url.pathname.startsWith('/api/toolkits/icon/')) {
        iconPaths.push(url.pathname);
        if (url.pathname.endsWith('/slack')) return route.fulfill({ status: 404 });
        const slug = url.pathname.split('/').at(-1);
        assert.ok(['github', 'googlecalendar'].includes(slug));
        return route.fulfill({ contentType: 'image/svg+xml', body: await readFile(new URL(`../web/public/assets/toolkits/${slug}.svg`, import.meta.url), 'utf8') });
      }
      if (url.pathname.endsWith('/suggested-apps')) {
        const body = request.postDataJSON(); requests.push(body);
        if (body.description === 'slow request') { held = route; return; }
        const suggestions = body.description.includes('calendar') ? [calendar] : connected ? [slack] : [github, slack];
        return route.fulfill({ json: { suggestions } });
      }
      if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { id: 'owner', name: 'Test account' } } });
      if (url.pathname === '/api/apps/github/connect') { connects.push(request.postDataJSON()); return route.fulfill({ json: { redirectUrl: `${origin}/fixture-authorize` } }); }
      if (url.pathname.startsWith('/api/')) { errors.push(`Unexpected API ${url.pathname}`); return route.abort(); }
      return route.continue();
    });
    await page.goto(origin);
    const cards = page.locator('.suggested-integration');
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).waitFor();
    assert.equal(await cards.count(), 2);
    await cards.filter({ hasText: 'Slack' }).locator('.toolkit-logo__letter').waitFor();
    assert.equal(await cards.filter({ hasText: 'Slack' }).locator('.toolkit-logo__letter').textContent(), 'S');
    assert.ok(await cards.filter({ hasText: 'GitHub' }).locator('img').evaluate(image => image.complete && image.naturalWidth > 0));
    assert.equal(await cards.filter({ hasText: 'GitHub' }).locator('img').getAttribute('src'), '/api/toolkits/icon/github', 'metadata precedes bundled artwork');
    assert.ok(iconPaths.includes('/api/toolkits/icon/slack'));
    assert.deepEqual(await page.evaluate(() => window.violations), []);
    const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(geometry.scroll <= geometry.width, JSON.stringify(geometry));
    await page.screenshot({ path: `.context/suggestions/chips-${width}-${theme}.png` });
    if (width === 900 && theme === 'light') {
      await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
      await page.getByRole('button', { name: 'Refresh status', exact: true }).waitFor();
      assert.equal(connects.length, 1);
      assert.equal(await page.evaluate(() => window.fixturePopup.location.href), `${origin}/fixture-authorize`);
      connected = true;
      await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
      await page.getByRole('button', { name: 'Connect GitHub', exact: true }).waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelectorAll('.suggested-integration').length === 1);
      const before = requests.length;
      await page.getByLabel('About', { exact: true }).fill('manage');
      await page.waitForTimeout(120);
      await page.getByLabel('About', { exact: true }).fill('manage my');
      await page.waitForTimeout(120);
      await page.getByLabel('About', { exact: true }).fill('manage my calendar');
      await page.getByRole('button', { name: 'Connect Google Calendar', exact: true }).waitFor();
      assert.equal(requests.length - before, 1, 'edits produce one debounced request');
      await page.getByLabel('About', { exact: true }).fill('slow request');
      for (let i = 0; !held && i < 40; i++) await page.waitForTimeout(50);
      assert.ok(held);
      await page.getByLabel('About', { exact: true }).fill('manage my calendar again');
      await page.getByRole('button', { name: 'Connect Google Calendar', exact: true }).waitFor();
      await held.fulfill({ json: { suggestions: [github] } }).catch(() => {});
      await page.waitForTimeout(100);
      assert.equal(await page.getByRole('button', { name: 'Connect GitHub', exact: true }).count(), 0, 'late old result cannot replace the newest draft');
      held = undefined;
      await page.getByLabel('About', { exact: true }).fill('slow request');
      for (let i = 0; !held && i < 40; i++) await page.waitForTimeout(50);
      assert.ok(held);
      await page.evaluate(() => window.switchAccount());
      await held.fulfill({ json: { suggestions: [github] } }).catch(() => {});
      assert.equal(await cards.count(), 0, 'account switch immediately clears prior suggestions');
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Suggested integrations: logo chips, monograms, self-only CSP, popup reuse, debounce, late responses, account isolation and responsive layouts passed.');
} finally { await browser?.close(); vite.kill(); }

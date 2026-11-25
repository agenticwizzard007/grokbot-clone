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
  for (const width of [1280, 1024, 900, 768, 390, 320]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme: theme });
    page.setDefaultTimeout(8000);
    const errors = [], requests = [], connects = [], iconPaths = [];
    let connected = false, holdCached = false, held, recoverHang = false, holdSkip = false, heldSkip, catalogRecovered = false;
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
import { SetupBanner } from '/src/components/SetupBanner.tsx';
import { useStore } from '/src/store.ts';
import '/src/styles/tokens.css'; import '/src/styles/base.css'; import '/src/styles/config.css';
document.documentElement.dataset.theme = ${JSON.stringify(theme)};
useStore.setState({ user: { id: 'owner', name: 'Test account' } });
useStore.setState({ bots: [{ id: 'review-bot', name: 'Review Bot', kind: 'agent', onboarding: { status: 'interviewing', revision: 1 } }] });
window.refreshConnections = () => useStore.setState(state => ({ connectionsVersion: state.connectionsVersion + 1 }));
window.switchAccount = () => useStore.setState({ user: { id: 'another-account', name: 'Another account' } });
function Harness() {
  const [description, setDescription] = React.useState('track GitHub PRs and post to Slack');
  const [mount, setMount] = React.useState(0);
  const [botId, setBotId] = React.useState('review-bot');
  window.switchSuggestionBot = setBotId;
  window.remountSuggestions = () => setMount(value => value + 1);
  window.setSuggestionDraft = setDescription;
  const bot = useStore(state => state.bots[0]);
  return React.createElement('main', { style: { margin: '24px auto', padding: '16px', maxWidth: '640px' } },
    bot && React.createElement(SetupBanner, { bot }),
    React.createElement('label', { htmlFor: 'about' }, 'About'),
    React.createElement('textarea', { id: 'about', className: 'text-input', value: description, onChange: event => setDescription(event.target.value) }),
    React.createElement(SuggestedIntegrations, { key: mount, botId, description, instructions: '' }));
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
        if (holdCached && body.description === 'track GitHub PRs and post to Slack') { held = route; return; }
        if (body.description === 'catalog failure' && !catalogRecovered) return route.fulfill({ status: 503, json: { code: 'catalog_authorization', error: 'The app catalog service rejected the server credentials. The server administrator needs to check them.' } });
        if (body.description === 'slow request') { held = route; return; }
        if (body.description === 'never resolves' && !recoverHang) { held = route; return; }
        if (body.description === 'no matching tools' || !body.description.trim()) return route.fulfill({ json: { filterVersion: 'purpose-2', suggestions: [] } });
        const suggestions = body.description.includes('calendar') ? [calendar] : connected ? [slack] : [github, slack];
        return route.fulfill({ json: { filterVersion: 'purpose-2', suggestions } });
      }
      if (url.pathname.endsWith('/setup/skip')) {
        if (holdSkip) { heldSkip = route; return; }
        return route.fulfill({ json: { ok: true, bot: { id: 'review-bot', name: 'Review Bot', kind: 'agent', onboarding: { status: 'active', revision: 3 } } } });
      }
      if (url.pathname === '/api/bots') return route.fulfill({ status: 503, json: { error: 'Roster refresh unavailable.' } });
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
    // Returning to a previously viewed draft shows cached suggestions during a stalled refresh.
    await page.getByLabel('About', { exact: true }).fill('temporary edit');
    await page.waitForTimeout(500);
    holdCached = true;
    await page.getByLabel('About', { exact: true }).fill('track GitHub PRs and post to Slack');
    assert.equal(await page.getByText('Updating saved suggestions...', { exact: true }).count(), 0);
    assert.equal(await cards.count(), 2);
    assert.equal(await page.getByText('Finding relevant apps…', { exact: true }).count(), 0);
    for (let i = 0; !held && i < 40; i++) await page.waitForTimeout(25);
    assert.ok(held);
    await held.fulfill({ json: { filterVersion: 'purpose-2', suggestions: [github, slack] } });
    holdCached = false; held = undefined;
    await page.getByText('Updating saved suggestions...', { exact: true }).waitFor({ state: 'hidden' });
    const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(geometry.scroll <= geometry.width, JSON.stringify(geometry));
    await page.screenshot({ path: `.context/suggestions/chips-${width}-${theme}.png` });
    await page.getByLabel('About', { exact: true }).fill('catalog failure');
    await page.getByText("Couldn't refresh.", { exact: false }).waitFor();
    assert.equal(await cards.count(), 2, 'warm refresh failure retains the last Bot suggestions');
    assert.equal(await page.getByText('Suggestions are unavailable right now.', { exact: false }).count(), 0);
    await page.screenshot({ path: `.context/suggestions/catalog-error-${width}-${theme}.png` });
    catalogRecovered = true;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).waitFor();
    // QA SO L-05: empty suggestions must point to a real settings section.
    await page.getByLabel('About', { exact: true }).fill('');
    const emptyNote = page.getByRole('region', { name: 'Suggested integrations' }).locator('.suggested-integrations__note');
    await emptyNote.filter({ hasText: /Describe this Bot's work/ }).waitFor();
    assert.equal(await emptyNote.innerText(), "Describe this Bot's work in Bot settings > General to find relevant integrations.");
    assert.ok(await emptyNote.evaluate(element => element.scrollWidth <= element.clientWidth), `empty note fits ${width}px`);
    await page.screenshot({ path: `.context/suggestions/empty-${width}-${theme}.png` });
    const restoredDraft = page.waitForResponse(response => response.url().endsWith('/suggested-apps') && response.request().postDataJSON()?.description === 'track GitHub PRs and post to Slack');
    await page.getByLabel('About', { exact: true }).fill('track GitHub PRs and post to Slack');
    await restoredDraft;
    await page.getByText('Updating saved suggestions...', { exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).waitFor();
    if (width === 900 && theme === 'light') {
      await page.getByRole('button', { name: 'Skip setup', exact: true }).click();
      await page.getByRole('region', { name: 'Review Bot setup', exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => import('/src/store.ts').then(({ useStore }) => useStore.getState().bots[0].onboarding.status)), 'active');
      holdSkip = true;
      await page.evaluate(async () => {
        const { useStore } = await import('/src/store.ts');
        useStore.setState(state => ({ bots: state.bots.map(bot => ({ ...bot, onboarding: { status: 'interviewing', revision: 4 } })) }));
      });
      await page.getByRole('button', { name: 'Skip setup', exact: true }).click();
      for (let i = 0; !heldSkip && i < 40; i++) await page.waitForTimeout(25);
      assert.ok(heldSkip);
      await page.evaluate(async () => {
        const { useStore } = await import('/src/store.ts');
        const bot = useStore.getState().bots[0];
        useStore.getState().handleEvent({ type: 'bot', bot: { ...bot, name: 'Updated Bot', onboarding: { status: 'interviewing', revision: 6 } } });
      });
      await heldSkip.fulfill({ json: { ok: true, bot: { id: 'review-bot', name: 'Old Bot', onboarding: { status: 'active', revision: 5 } } } });
      await page.getByRole('button', { name: 'Skip setup', exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(async () => {
        const { useStore } = await import('/src/store.ts');
        const bot = useStore.getState().bots[0];
        return { name: bot.name, onboarding: bot.onboarding };
      }), { name: 'Updated Bot', onboarding: { status: 'interviewing', revision: 6 } });
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
      await page.getByLabel('About', { exact: true }).fill('no matching tools');
      await page.getByText('No matching additional apps for this Bot right now.', { exact: true }).waitFor();
      assert.equal(await page.getByText(/Describe this Bot's work/).count(), 0);
      await page.getByLabel('About', { exact: true }).fill('');
      await page.getByText(/Describe this Bot's work/).waitFor();
      await page.clock.install();
      await page.getByLabel('About', { exact: true }).fill('never resolves');
      await page.clock.runFor(500);
      for (let i = 0; !held && i < 40; i++) await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(held, 'the fixture must hold an actual suggestions request');
      await page.clock.fastForward(4500);
      await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
      assert.equal(await page.getByText('Finding relevant apps…', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('region', { name: 'Suggested integrations' }).getAttribute('aria-busy'), 'false');
      await held.fulfill({ json: { filterVersion: 'purpose-2', suggestions: [calendar] } }).catch(() => {});
      assert.equal(await page.getByRole('button', { name: 'Connect Google Calendar', exact: true }).count(), 0, 'a response after timeout must not replace the error');
      held = undefined; recoverHang = true;
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.clock.runFor(500);
      await page.getByRole('button', { name: 'Connect Slack', exact: true }).waitFor();
      await page.clock.resume();
      await page.getByLabel('About', { exact: true }).fill('slow request');
      for (let i = 0; !held && i < 40; i++) await page.waitForTimeout(50);
      assert.ok(held);
      await page.getByLabel('About', { exact: true }).fill('manage my calendar again');
      await page.getByRole('button', { name: 'Connect Google Calendar', exact: true }).waitFor();
      await held.fulfill({ json: { filterVersion: 'purpose-2', suggestions: [github] } }).catch(() => {});
      await page.waitForTimeout(100);
      assert.equal(await page.getByRole('button', { name: 'Connect GitHub', exact: true }).count(), 0, 'late old result cannot replace the newest draft');
      held = undefined;
      await page.getByLabel('About', { exact: true }).fill('slow request');
      for (let i = 0; !held && i < 40; i++) await page.waitForTimeout(50);
      assert.ok(held);
      await page.evaluate(() => window.switchAccount());
      await held.fulfill({ json: { filterVersion: 'purpose-2', suggestions: [github] } }).catch(() => {});
      assert.equal(await cards.count(), 0, 'account switch immediately clears prior suggestions');
    }
    if ([390, 1280].includes(width)) {
      // Draft changes and remounts before debounce used to renew the window forever.
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      const duringChurn = () => requests.filter(request => request.description.startsWith('continuous edit'));
      for (let i = 0; i < 17; i++) {
        await page.evaluate(i => {
          window.setSuggestionDraft(`continuous edit ${i}`);
          window.remountSuggestions();
          window.refreshConnections();
        }, i);
        await page.waitForFunction(i => document.querySelector('#about').value === `continuous edit ${i}`, i);
        await page.clock.runFor(300);
      }
      await page.clock.runFor(300); // The final debounce would fire after the deadline without the abort guard.
      await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
      assert.deepEqual(duringChurn(), [], 'deadline works even when debounce never starts a request');
      assert.equal(await page.getByText('Finding relevant apps…', { exact: true }).count(), 0);
      await page.evaluate(() => { window.remountSuggestions(); window.switchAccount(); });
      await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
      assert.equal(await page.getByText('Finding relevant apps…', { exact: true }).count(), 0, 'account switch/remount cannot renew an exhausted loading window');
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.clock.runFor(500);
      await page.getByRole('button', { name: 'Connect Slack', exact: true }).waitFor();
      assert.equal(await page.getByText('Updating saved suggestions...', { exact: true }).count(), 0);
      await page.clock.resume();
    }
    // A different Bot has a true cold cache and keeps the actionable API error.
    catalogRecovered = false;
    await page.evaluate(() => { window.switchSuggestionBot('cold-bot'); window.setSuggestionDraft('catalog failure'); });
    await page.getByText('The app catalog service rejected the server credentials. The server administrator needs to check them.', { exact: false }).waitFor();
    assert.equal(await cards.count(), 0, 'another Bot never inherits saved suggestions');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Suggested integrations: logo chips, monograms, self-only CSP, popup reuse, debounce, late responses, account isolation and responsive layouts passed.');
} finally { await browser?.close(); vite.kill(); }

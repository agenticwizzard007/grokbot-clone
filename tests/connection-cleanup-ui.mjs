// Run: npm run build -w web && node tests/connection-cleanup-ui.mjs
// Built Settings UI with mocked APIs only. Never uses provider accounts or credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

await fs.access(new URL('../web/dist/index.html', import.meta.url));
const screenshots = new URL('../.context/connection-cleanup-evidence/', import.meta.url);
await fs.mkdir(screenshots, { recursive: true });
const port = await new Promise(resolve => {
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const value = server.address().port;
    server.close(() => resolve(value));
  });
});
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: new URL('../web', import.meta.url), stdio: 'pipe',
});
let logs = '';
vite.stdout.on('data', data => { logs += data; });
vite.stderr.on('data', data => { logs += data; });
const origin = `http://127.0.0.1:${port}`;
const until = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for connection cleanup fixture');
};
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const ids = {
  active: 'active-work-gmail', second: 'active-personal-gmail', disabled: 'active-disabled-gmail',
  expired: 'expired/gmail?attempt=one & two', unfinished: 'expired-gmail-unfinished',
  pending: 'github-pending', initiated: 'github-initiated', revoked: 'github-revoked',
};
const initialAccounts = [
  { id: ids.active, toolkit: 'gmail', status: 'ACTIVE', isDefault: true },
  { id: ids.second, toolkit: 'gmail', status: 'ACTIVE' },
  { id: ids.disabled, toolkit: 'gmail', status: 'ACTIVE', isDisabled: true, isDefault: true },
  { id: ids.expired, toolkit: 'gmail', status: 'EXPIRED' },
  { id: ids.unfinished, toolkit: 'gmail', status: 'EXPIRED', authorizationIncomplete: true },
  { id: ids.pending, toolkit: 'github', status: 'PENDING' },
  { id: ids.initiated, toolkit: 'github', status: 'AUTHORIZATION_PENDING' },
  { id: ids.revoked, toolkit: 'github', status: 'REVOKED' },
];
let browser;
const openPages = [];
try {
  await until(async () => {
    if (vite.exitCode !== null) throw new Error(logs);
    return fetch(origin).then(response => response.ok, () => false);
  });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });

  async function fixture({ mobile = false, accounts = initialAccounts, providerFailure = false } = {}) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 1100 } });
    openPages.push(page);
    page.setDefaultTimeout(10000);
    const errors = [], unexpected = [], mutations = [], reads = [];
    let records = structuredClone(accounts);
    let failConnections = providerFailure, failApps = providerFailure, malformedConnections = false;
    let nextDelete = { status: 200, body: { ok: true } }, nextReadGate;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('swarm.selectedBot', 'main');
      localStorage.setItem('swarm.detailsOpen', '0');
    });
    // No requests to live providers, including app logos.
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const bot = { id: 'main', name: 'Main agent', isPrimary: true, label: '', description: '', instructions: '', avatarShape: 'blob', avatarColor: 'blue', mode: 'personal', pinned: true, effort: 'medium', model: null, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', generation: 1, unread: 0, lastPreview: '', lastActivityAt: 1, createdAt: 1 };
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      let body;
      if (path === '/api/apps/connections' && method === 'GET') {
        reads.push('connections');
        const gate = nextReadGate;
        nextReadGate = undefined;
        const status = failConnections ? 503 : 200;
        const result = failConnections ? { error: 'Provider accounts unavailable' }
          : malformedConnections ? {} : { connections: structuredClone(records) };
        if (gate) await gate.promise;
        return route.fulfill({ status, json: result });
      }
      if (path === '/api/apps' && method === 'GET') {
        reads.push('apps');
        const connectedApps = records.some(account => account.status === 'ACTIVE' && !account.isDisabled && account.toolkit === 'gmail')
          ? [{ slug: 'gmail', name: 'Gmail', description: 'Email for your Bots.', categories: [], connected: true }] : [];
        return route.fulfill({ status: failApps ? 503 : 200, json: failApps ? { error: 'Provider apps unavailable' } : { connectedApps, connected: connectedApps.map(app => app.slug) } });
      }
      if (path.startsWith('/api/apps/connections/') && method !== 'GET') {
        const action = path.endsWith('/expired') ? 'remove-expired' : path.endsWith('/default') ? 'default' : 'disconnect';
        const suffix = action === 'remove-expired' ? '/expired' : action === 'default' ? '/default' : '';
        const id = decodeURIComponent(path.slice('/api/apps/connections/'.length, suffix ? -suffix.length : undefined));
        mutations.push({ method, path, action, id });
        assert.ok(records.some(account => account.id === id), 'mutation must use an actual account ID');
        if (action === 'remove-expired') {
          const plan = nextDelete;
          nextDelete = { status: 200, body: { ok: true } };
          if (plan.gate) await plan.gate.promise;
          if (plan.status === 200 && plan.body.ok === true) records = records.filter(account => account.id !== id);
          if (plan.status === 409) records = records.map(account => account.id === id ? { ...account, status: plan.changedStatus ?? 'ACTIVE' } : account);
          return route.fulfill({ status: plan.status, json: plan.body });
        }
        assert.equal(records.find(account => account.id === id).status, 'ACTIVE', 'inactive rows must never use active management endpoints');
        assert.ok(!records.find(account => account.id === id).isDisabled, 'disabled rows must never use active management endpoints');
        if (action === 'default') {
          assert.equal(method, 'POST');
          const toolkit = records.find(account => account.id === id).toolkit;
          records = records.map(account => account.toolkit === toolkit ? { ...account, isDefault: account.id === id } : account);
        } else {
          assert.equal(method, 'DELETE');
          records = records.filter(account => account.id !== id);
        }
        return route.fulfill({ json: { ok: true } });
      }
      if (method !== 'GET') {
        unexpected.push({ method, path });
        return route.fulfill({ status: 500, json: { error: 'Unexpected mutation' } });
      }
      if (path === '/api/auth/me') body = { user: { id: 'cleanup-test-user', name: 'Alex', email: 'alex@example.test' }, devLogin: true };
      else if (path === '/api/bots') body = { bots: [bot], live: [] };
      else if (path === '/api/models') body = { models: [], defaultModel: null };
      else if (path.endsWith('/rows')) body = { generation: 1, rows: [] };
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'cloudvm' } };
      else if (path === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"type":"hello"}\n\n' });
      else {
        unexpected.push({ method, path });
        return route.fulfill({ status: 404, json: { error: 'Unexpected fixture API' } });
      }
      return route.fulfill({ json: body });
    });
    await page.goto(`${origin}/#settings/apps`);
    await page.getByRole('heading', { name: 'Connected apps', exact: true }).waitFor();
    const active = page.getByRole('region', { name: 'Your connected accounts', exact: true });
    const expired = page.getByRole('region', { name: 'Expired connections', exact: true });
    const other = page.getByRole('region', { name: 'Other connections', exact: true });
    const row = id => page.locator('.cfg-row').filter({ has: page.getByText(id, { exact: true }) });
    const summary = () => expired.locator('summary');
    const expand = async () => {
      if (!await expired.locator('details').evaluate(element => element.open)) await summary().click();
    };
    const confirmRemoval = async id => {
      await row(id).getByRole('button', { name: 'Remove expired record', exact: true }).click();
      await row(id).getByRole('button', { name: 'Confirm removal', exact: true }).click();
    };
    return {
      page, active, expired, other, row, summary, expand, confirmRemoval, errors, unexpected, mutations, reads,
      deletion: plan => { nextDelete = plan; },
      gateNextRead: gate => { nextReadGate = gate; },
      failures: (connections, apps = connections) => { failConnections = connections; failApps = apps; },
      malformed: value => { malformedConnections = value; },
    };
  }

  const desktop = await fixture();
  await desktop.row(ids.active).waitFor();
  await desktop.summary().getByText('Expired connections (2)', { exact: true }).waitFor();
  assert.equal(await desktop.expired.locator('details').evaluate(element => element.open), false, 'expired records start collapsed');
  assert.equal(await desktop.row(ids.expired).isVisible(), false);
  assert.equal(await desktop.active.getByRole('button', { name: 'Use by default', exact: true }).count(), 2);
  assert.equal(await desktop.active.getByRole('button', { name: 'Disconnect', exact: true }).count(), 2);
  assert.match(await desktop.row(ids.active).innerText(), /Active · Default/);
  assert.equal(await desktop.row(ids.active).getByRole('button', { name: 'Use by default', exact: true }).isDisabled(), true);
  for (const [id, status] of [[ids.pending, 'Pending'], [ids.initiated, 'Authorization Pending'], [ids.revoked, 'Revoked'], [ids.disabled, 'Active · Disabled']]) {
    assert.match(await desktop.row(id).innerText(), new RegExp(status));
    assert.equal(await desktop.row(id).getByRole('button').count(), 0, 'other statuses have no destructive or active-account controls');
  }
  assert.equal(await desktop.other.getByText(ids.disabled, { exact: true }).count(), 1, 'disabled ACTIVE accounts belong in Other connections');
  assert.equal(await desktop.active.getByText(ids.disabled, { exact: true }).count(), 0);
  assert.equal((await desktop.row(ids.disabled).innerText()).includes('Default'), false, 'disabled accounts do not appear as usable defaults');
  assert.equal(await desktop.active.getByText(ids.expired, { exact: true }).count(), 0);
  await desktop.summary().scrollIntoViewIfNeeded();
  await desktop.page.screenshot({ animations: 'disabled', path: new URL('desktop-collapsed.png', screenshots).pathname });
  // Native disclosure supports keyboard opening and keeps every action scoped to its row.
  await desktop.summary().focus();
  await desktop.page.keyboard.press('Enter');
  await desktop.row(ids.expired).waitFor();
  assert.equal(await desktop.expired.getByRole('button', { name: 'Use by default', exact: true }).count(), 0);
  assert.equal(await desktop.expired.getByRole('button', { name: 'Disconnect', exact: true }).count(), 0);
  assert.equal(await desktop.expired.getByRole('button', { name: 'Remove expired record', exact: true }).count(), 2);
  assert.equal((await desktop.row(ids.expired).innerText()).includes('Authorization was not completed'), false, 'unknown expiry reasons must stay honest');
  assert.match(await desktop.row(ids.unfinished).innerText(), /Expired · Authorization was not completed/);
  await desktop.row(ids.unfinished).scrollIntoViewIfNeeded();
  await desktop.page.screenshot({ animations: 'disabled', path: new URL('desktop-expanded.png', screenshots).pathname });

  await desktop.row(ids.expired).getByRole('button', { name: 'Remove expired record', exact: true }).click();
  assert.equal(desktop.mutations.length, 0, 'first click only requests confirmation');
  const deletionGate = deferred(), refreshGate = deferred();
  desktop.deletion({ status: 200, body: { ok: true }, gate: deletionGate });
  desktop.gateNextRead(refreshGate);
  await desktop.row(ids.expired).getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await until(() => desktop.mutations.length === 1);
  assert.equal(await desktop.row(ids.expired).isVisible(), true, 'record remains until deletion succeeds');
  assert.deepEqual(desktop.mutations[0], {
    method: 'DELETE', action: 'remove-expired', id: ids.expired,
    path: `/api/apps/connections/${encodeURIComponent(ids.expired)}/expired`,
  });
  deletionGate.resolve();
  await desktop.row(ids.expired).waitFor({ state: 'detached' });
  assert.equal(await desktop.row(ids.unfinished).isVisible(), true, 'only the selected record is removed before refresh completes');
  assert.equal(await desktop.row(ids.active).count(), 1);
  assert.equal(await desktop.row(ids.pending).count(), 1);
  refreshGate.resolve();
  await desktop.row(ids.unfinished).getByRole('button', { name: 'Remove expired record', exact: true }).waitFor({ state: 'visible' });
  await until(async () => await desktop.row(ids.unfinished).getByRole('button', { name: 'Remove expired record', exact: true }).isEnabled());
  assert.ok(desktop.reads.filter(kind => kind === 'connections').length >= 2, 'successful removal refreshes the account list');
  assert.ok(desktop.reads.filter(kind => kind === 'apps').length >= 2, 'successful removal refreshes the apps summary');
  assert.match(await desktop.summary().innerText(), /Expired connections \(1\)/);
  console.log('PASS desktop: collapsed counts, readable statuses, honest expiry reasons, keyboard disclosure, confirmed exact-ID removal and refresh');

  desktop.deletion({ status: 503, body: { error: 'Could not verify this expired record' } });
  await desktop.confirmRemoval(ids.unfinished);
  await desktop.page.getByRole('alert').filter({ hasText: 'Could not verify this expired record' }).waitFor();
  assert.equal(await desktop.row(ids.unfinished).isVisible(), true, 'verification failures retain the expired record');
  desktop.deletion({ status: 409, body: { error: 'This account is no longer expired' } });
  await desktop.confirmRemoval(ids.unfinished);
  await desktop.page.getByRole('alert').filter({ hasText: 'This account is no longer expired' }).waitFor();
  await desktop.active.getByText(ids.unfinished, { exact: true }).waitFor();
  assert.match(await desktop.row(ids.unfinished).innerText(), /Active/);
  assert.equal(await desktop.expired.count(), 0, 'conflicts refresh status and remove the obsolete expiry group');
  assert.equal(desktop.mutations.filter(mutation => mutation.action === 'remove-expired').length, 3);

  await desktop.row(ids.second).getByRole('button', { name: 'Use by default', exact: true }).click();
  await until(async () => (await desktop.row(ids.second).innerText()).includes('Active · Default'));
  await until(async () => await desktop.row(ids.active).getByRole('button', { name: 'Disconnect', exact: true }).isEnabled());
  await desktop.row(ids.active).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await desktop.row(ids.active).waitFor({ state: 'detached' });
  assert.deepEqual(desktop.mutations.slice(-2), [
    { method: 'POST', path: `/api/apps/connections/${ids.second}/default`, action: 'default', id: ids.second },
    { method: 'DELETE', path: `/api/apps/connections/${ids.active}`, action: 'disconnect', id: ids.active },
  ], 'active management keeps the existing per-account endpoints');
  console.log('PASS failures and compatibility: 503 retains records, 409 refreshes changed status, active default/disconnect keep their existing endpoints');

  const mobile = await fixture({ mobile: true });
  await mobile.summary().waitFor();
  assert.equal(await mobile.other.getByText(ids.disabled, { exact: true }).count(), 1);
  assert.equal(await mobile.row(ids.disabled).getByRole('button').count(), 0, 'disabled ACTIVE accounts have no controls on mobile');
  assert.equal(await mobile.expired.locator('details').evaluate(element => element.open), false);
  await mobile.summary().scrollIntoViewIfNeeded();
  await mobile.page.screenshot({ animations: 'disabled', path: new URL('mobile-collapsed.png', screenshots).pathname });
  await mobile.expand();
  await mobile.row(ids.unfinished).scrollIntoViewIfNeeded();
  await mobile.page.screenshot({ animations: 'disabled', path: new URL('mobile-expanded.png', screenshots).pathname });
  await mobile.row(ids.expired).getByRole('button', { name: 'Remove expired record', exact: true }).click();
  const confirmBounds = await mobile.row(ids.expired).getByRole('button', { name: 'Confirm removal', exact: true }).boundingBox();
  assert.ok(confirmBounds.x >= 0 && confirmBounds.x + confirmBounds.width <= 390, 'confirmation fits phone width');
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const controlBounds = await mobile.page.locator('.app-settings .cfg-row button').evaluateAll(buttons => buttons.map(button => ({ left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right })));
  assert.ok(controlBounds.every(bounds => bounds.left >= 0 && bounds.right <= 390), 'all account controls fit phone width');
  mobile.failures(true);
  await mobile.row(ids.expired).getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await mobile.row(ids.expired).waitFor({ state: 'detached' });
  await mobile.page.getByRole('alert').filter({ hasText: 'Accounts could not be refreshed' }).waitFor();
  await mobile.page.getByRole('alert').filter({ hasText: 'Apps could not be refreshed' }).waitFor();
  assert.equal(await mobile.row(ids.active).count(), 1, 'refresh failure preserves known active accounts');
  assert.equal(await mobile.row(ids.unfinished).count(), 1, 'refresh failure preserves every other expired record');
  assert.equal(await mobile.page.getByText('No apps connected yet', { exact: true }).count(), 0);
  assert.equal(await mobile.page.getByText('No active accounts connected.', { exact: true }).count(), 0);
  await mobile.page.getByRole('alert').first().scrollIntoViewIfNeeded();
  await mobile.page.screenshot({ animations: 'disabled', path: new URL('mobile-refresh-failure.png', screenshots).pathname });
  mobile.failures(false);
  await mobile.page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
  await until(async () => await mobile.page.getByRole('alert').count() === 0);
  assert.equal(await mobile.row(ids.expired).count(), 0, 'confirmed removal stays removed after recovery');
  console.log('PASS mobile: disclosure, wrapping IDs and controls, confirmed removal, retained accounts during provider failures, refresh recovery');

  const unavailable = await fixture({ providerFailure: true });
  await unavailable.page.getByText('Accounts unavailable', { exact: true }).waitFor();
  await unavailable.page.getByText('Apps unavailable', { exact: true }).waitFor();
  assert.equal(await unavailable.page.getByText('No apps connected yet', { exact: true }).count(), 0);
  assert.equal(await unavailable.page.getByText('No active accounts connected.', { exact: true }).count(), 0);
  unavailable.failures(false);
  unavailable.malformed(true);
  await unavailable.page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
  await unavailable.page.getByRole('alert').filter({ hasText: 'Could not load accounts.' }).waitFor();
  assert.equal(await unavailable.page.getByText('No active accounts connected.', { exact: true }).count(), 0, 'malformed success responses are not empty account lists');
  unavailable.malformed(false);
  await unavailable.page.getByRole('button', { name: 'Retry refresh', exact: true }).click();
  await unavailable.row(ids.active).waitFor();
  await until(async () => await unavailable.page.getByRole('alert').count() === 0);

  const expiredOnly = await fixture({ accounts: [{ id: 'only-expired', toolkit: 'gmail', status: 'EXPIRED' }] });
  await expiredOnly.summary().waitFor();
  await expiredOnly.page.getByText('No active accounts connected.', { exact: true }).waitFor();
  assert.equal(await expiredOnly.active.getByRole('button').count(), 0);
  assert.equal(await expiredOnly.page.getByText('No apps connected yet', { exact: true }).count(), 1);
  await expiredOnly.expand();
  await expiredOnly.row('only-expired').getByRole('button', { name: 'Remove expired record', exact: true }).click();
  assert.equal(expiredOnly.mutations.length, 0, 'expired-only cleanup still requires confirmation');
  await expiredOnly.page.screenshot({ animations: 'disabled', path: new URL('expired-only-confirm-desktop.png', screenshots).pathname });
  // A 200 without the endpoint's explicit success flag cannot remove a record.
  expiredOnly.deletion({ status: 200, body: {} });
  await expiredOnly.row('only-expired').getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expiredOnly.page.getByRole('alert').filter({ hasText: 'Could not remove this expired record' }).waitFor();
  assert.equal(await expiredOnly.row('only-expired').count(), 1);
  await expiredOnly.confirmRemoval('only-expired');
  await expiredOnly.expired.waitFor({ state: 'detached' });
  await expiredOnly.page.screenshot({ animations: 'disabled', path: new URL('expired-only-removed-desktop.png', screenshots).pathname });
  console.log('PASS unavailable/empty states: failed and malformed loads stay honest, retry recovers, expired-only accounts have no active controls, last removal clears the disclosure');

  const expiredOnlyMobile = await fixture({ mobile: true, accounts: [{ id: 'only-expired-mobile', toolkit: 'gmail', status: 'EXPIRED' }] });
  await expiredOnlyMobile.summary().waitFor();
  await expiredOnlyMobile.expand();
  await expiredOnlyMobile.row('only-expired-mobile').getByRole('button', { name: 'Remove expired record', exact: true }).click();
  assert.equal(expiredOnlyMobile.mutations.length, 0);
  assert.equal(await expiredOnlyMobile.active.getByRole('button').count(), 0);
  await expiredOnlyMobile.row('only-expired-mobile').scrollIntoViewIfNeeded();
  await expiredOnlyMobile.page.screenshot({ animations: 'disabled', path: new URL('expired-only-confirm-mobile.png', screenshots).pathname });
  await expiredOnlyMobile.row('only-expired-mobile').getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expiredOnlyMobile.expired.waitFor({ state: 'detached' });
  assert.deepEqual(expiredOnlyMobile.mutations, [{
    method: 'DELETE', path: '/api/apps/connections/only-expired-mobile/expired', action: 'remove-expired', id: 'only-expired-mobile',
  }]);
  await expiredOnlyMobile.page.screenshot({ animations: 'disabled', path: new URL('expired-only-removed-mobile.png', screenshots).pathname });

  const refusals = [];
  for (const status of ['ACTIVE', 'PENDING']) {
    const id = `changed-to-${status.toLowerCase()}`;
    const current = await fixture({ accounts: [{ id, toolkit: 'gmail', status: 'EXPIRED' }] });
    refusals.push(current);
    await current.summary().waitFor();
    await current.expand();
    current.deletion({ status: 409, body: { error: `Cleanup refused: this connection is now ${status.toLowerCase()}.` }, changedStatus: status });
    await current.confirmRemoval(id);
    await current.page.getByRole('alert').filter({ hasText: 'Cleanup refused:' }).waitFor();
    assert.equal(await current.expired.count(), 0, '409 status refresh removes expired-only cleanup controls');
    assert.equal(await current.row(id).count(), 1, 'refused cleanup retains the same account record');
    assert.equal(await current.row(id).getByRole('button', { name: 'Remove expired record', exact: true }).count(), 0);
    if (status === 'ACTIVE') {
      assert.equal(await current.active.getByText(id, { exact: true }).count(), 1);
      assert.equal(await current.row(id).getByRole('button', { name: 'Disconnect', exact: true }).count(), 1);
      assert.equal(await current.row(id).getByRole('button', { name: 'Use by default', exact: true }).count(), 1);
    } else {
      assert.equal(await current.other.getByText(id, { exact: true }).count(), 1);
      assert.equal(await current.row(id).getByRole('button').count(), 0, 'pending records have no destructive or active-account controls');
    }
    assert.deepEqual(current.mutations, [{ method: 'DELETE', path: `/api/apps/connections/${id}/expired`, action: 'remove-expired', id }], 'status conflict causes no fallback deletion');
    await current.page.screenshot({ animations: 'disabled', path: new URL(`${status.toLowerCase()}-cleanup-refusal-desktop.png`, screenshots).pathname });
  }
  console.log('PASS explicit evidence: desktop/mobile expired-only confirmation and removal, ACTIVE/PENDING 409 refusal retains records and refreshes available controls');

  for (const current of [desktop, mobile, unavailable, expiredOnly, expiredOnlyMobile, ...refusals]) {
    assert.deepEqual(current.errors, [], 'no browser runtime errors');
    assert.deepEqual(current.unexpected, [], 'no unexpected APIs, toolkit deletion or bulk mutation');
    await current.page.close();
  }
  console.log(`Screenshots: ${screenshots.pathname}`);
} catch (error) {
  console.error(logs.slice(-4000));
  for (const [index, page] of openPages.entries()) {
    if (page.isClosed()) continue;
    console.error((await page.locator('.app-settings').innerText().catch(() => '')).slice(0, 5000));
    await page.screenshot({ animations: 'disabled', path: new URL(`failure-${index}.png`, screenshots).pathname }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  vite.kill();
}

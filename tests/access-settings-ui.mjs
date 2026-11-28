import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.ACCESS_UI_BASE ?? 'http://127.0.0.1:5193';
assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Run access fixtures only against local Vite.');
const screenshots = process.env.ACCESS_UI_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });

const alice = { id: 'access-alice', email: 'alice@example.test', name: 'Alice Test', avatarUrl: null };
const bob = { id: 'access-bob', email: 'bob@example.test', name: 'Bob Test', avatarUrl: null };
const currentId = 'private-current-session-id';
const otherId = 'private-other-session-id';
const rotatedId = 'private-rotated-session-id';
const token = 'fixture-bearer-not-for-storage';
const now = Date.now();
const existingServer = {
  id: 'oauth-server', name: 'Example tools', transport: 'http', url: 'https://fixture.invalid/mcp', command: '', args: [], cwd: '', folders: [], enabled: true,
  botIds: null, requireApproval: true, oauth: true, hasBearerToken: false, headerNames: [], envNames: [], checkedAt: null, error: null, tools: [],
};
const computer = { status: 'stopped', provider: 'local', desktop: false, screens: [] };
const connectedComputer = { ...computer, status: 'running', device: { name: 'Fixture desktop', platform: 'Linux' } };
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
const line = { number: '+14155550148', connectCommand: 'connect fixture', smsLink: 'sms:+14155550148?body=connect%20fixture', qr: pixel };
const toolkit = (slug, name, connected = false) => ({ slug, name, connected, categories: ['productivity'], description: `${name} for work.`, managedAuth: true, noAuth: false });
const calendar = toolkit('googlecalendar', 'Google Calendar');
const calendly = toolkit('calendly', 'Calendly');
const slack = toolkit('slack', 'Slack', true);
const providerStatus = { connected: true, linked: false, selected: false, active: false, hint: '…1234', source: 'manual', model: 'fixture/default', provider: 'direct', defaultModel: 'fixture/server', settingsUrl: 'https://openrouter.ai/keys' };
const cliStatus = { runtime: 'server', serverLoginAvailable: true, selected: null, connected: true, device: null,
  providers: { claude: { installed: true, authenticated: false, subscription: false }, codex: { installed: true, authenticated: false, subscription: false } } };
const messaging = {
  account: { phone: '+14155550142', email: alice.email, signupSource: 'text' },
  links: [{ channel: 'sms', channelName: 'SMS', status: 'connected', phone: '+14155550142', lastInboundAt: now, error: null }],
  line, invites: { allowance: 2 }, prefs: { forward: 'engaged', activeBot: null, voiceReplies: 'off', ttsVoice: null },
  speech: { speech: null, transcription: null, voices: [] },
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
// Keep session probes from consuming the Account preflight gates. Real SSE expiry is
// exercised by session-revocation-ui.mjs; this suite models a quiet, connected session.
await context.addInitScript(() => { window.EventSource = class { close() {} }; });
const state = {
  user: alice, fresh: false, failures: 1, activeSession: currentId,
  sessions: [{ id: currentId, current: true, created_at: now, last_seen_at: now, expires_at: now + 600_000 },
    { id: otherId, current: false, device: 'Android', created_at: new Date(now).toISOString(), last_seen_at: now, expires_at: now + 600_000 }],
  writes: [], revoked: [], verifies: [], deletes: 0, oauth: 0,
  local: { computer, paired: false, active: false }, deviceActions: [], provider: { ...providerStatus }, providerWrites: [], modelAttempts: 0,
  appPages: [], messaging: structuredClone(messaging), emailWrites: [], invites: [],
  privateWrites: [], appConnects: [], providerStarts: 0,
};
let nextGate;
function holdRequest(path, method = 'GET') {
  assert.equal(nextGate, undefined);
  const arrived = Promise.withResolvers();
  const barrier = Promise.withResolvers();
  nextGate = { path, method, arrived: arrived.resolve, wait: barrier.promise };
  return { arrived: arrived.promise, release: barrier.resolve };
}
await context.route('**/api/**', async route => {
  const method = route.request().method();
  const url = new URL(route.request().url());
  const send = (json, status = 200) => route.fulfill({ status, json });
  const stale = () => send({ error: 'Sign in again to continue.', code: 'reauth_required' }, 401);
  if (url.origin !== base) return route.abort();
  if (nextGate?.path === url.pathname && nextGate.method === method) {
    const gate = nextGate;
    nextGate = undefined;
    gate.arrived();
    await gate.wait;
  }
  if (url.pathname === '/api/auth/me') return send({ user: state.user, devLogin: true, googleLogin: true, appleLogin: true });
  if (url.pathname === '/api/auth/dev' && method === 'POST') {
    state.user = route.request().postDataJSON().email === alice.email ? alice : bob;
    state.fresh = true;
    return send({ ok: true });
  }
  if (url.pathname === '/api/auth/sessions' && method === 'GET') {
    if (state.failures-- > 0) return send({ error: 'Fixture session list unavailable.' }, 503);
    return send({ sessions: state.sessions.map(session => ({ ...session, current: session.id === state.activeSession })) });
  }
  if (url.pathname.startsWith('/api/auth/sessions/') && method === 'DELETE') {
    const id = decodeURIComponent(url.pathname.split('/').at(-1));
    state.revoked.push(id);
    if (!state.sessions.some(item => item.id === id)) return send({ error: 'Session not found.' }, 404);
    state.sessions = state.sessions.filter(item => item.id !== id);
    const revokedCurrent = id === state.activeSession;
    if (revokedCurrent) state.user = null;
    return send({ ok: true, revokedCurrent });
  }
  if (url.pathname === '/api/account' && method === 'DELETE') {
    state.deletes++;
    assert.deepEqual(route.request().postDataJSON(), { confirmation: 'DELETE', expectedUserId: alice.id });
    if (!state.fresh) return stale();
    state.user = null;
    return send({ ok: true });
  }
  if (url.pathname === '/api/cli/reauth') {
    const { expectedUserId } = route.request().postDataJSON();
    state.verifies.push(expectedUserId);
    return state.fresh && state.user?.id === expectedUserId ? send({ ok: true }) : stale();
  }
  if (url.pathname === '/api/mcp/servers' && method === 'GET') return send({ servers: [existingServer], canManage: true });
  if (url.pathname === '/api/mcp/servers' && method === 'POST') {
    const body = route.request().postDataJSON();
    state.writes.push(body);
    return state.fresh ? send({ server: { ...existingServer, ...body, id: 'saved' } }, 201) : stale();
  }
  if (url.pathname === '/api/mcp/servers/oauth-server/oauth') {
    state.oauth++;
    return state.fresh ? send({ error: 'Fixture provider refused authorization.' }, 400) : stale();
  }
  if (url.pathname === '/api/mcp/servers/saved/test') return send({ error: 'Fixture probe failed.' }, 503);
  if (url.pathname === '/api/cli' && method === 'GET') {
    assert.equal(url.searchParams.get('expectedUserId'), state.user?.id);
    return send(cliStatus);
  }
  if (url.pathname === '/api/computer/details') return send({ computer: state.local.computer, screens: [], thisComputer: { available: true, active: state.local.active }, pairing: { paired: state.local.paired }, localComputer: { enabled: false } });
  if (url.pathname === '/api/computer/this-computer' && method === 'DELETE') {
    state.deviceActions.push({ path: url.pathname, method, account: state.user?.id });
    state.local.active = false; state.local.computer = computer;
    return send({ ok: true });
  }
  if (url.pathname === '/api/computer/pair' && method === 'DELETE') {
    state.deviceActions.push({ path: url.pathname, method, account: state.user?.id });
    state.local.paired = false; state.local.computer = computer;
    return send({ ok: true, revoked: 1 });
  }
  if (url.pathname === '/api/providers/openrouter' && method === 'GET') return send(state.provider);
  if (url.pathname === '/api/auth/openrouter/start') { state.providerStarts++; return send({ error: 'Unexpected fixture navigation' }, 400); }
  if (url.pathname === '/api/providers/openrouter/key' && method === 'PUT') {
    const body = route.request().postDataJSON();
    state.providerWrites.push({ account: state.user?.id, body });
    if (!state.fresh) return stale();
    state.provider = { ...state.provider, hint: `…${body.key.slice(-4)}` };
    return send(state.provider);
  }
  if (url.pathname === '/api/providers/openrouter' && method === 'PUT') {
    const body = route.request().postDataJSON();
    state.providerWrites.push({ account: state.user?.id, body });
    state.provider = { ...state.provider, ...body };
    return send(state.provider);
  }
  if (url.pathname === '/api/settings/models' && url.searchParams.get('provider') === 'openrouter') {
    if (!state.modelAttempts++) return send({ error: 'Catalog unavailable for fixture.' }, 503);
    return send({ provider: 'openrouter', models: [{ id: 'fixture/default', name: 'Fixture default', vision: true }, { id: 'fixture/other', name: 'Other model', vision: false }] });
  }
  if (url.pathname === '/api/settings/keys') return send({ isolated: true });
  if (url.pathname === '/api/providers/private-keys') return send({ keys: [] });
  if (url.pathname === '/api/providers/private-keys/direct' && method === 'PUT') { state.privateWrites.push(route.request().postDataJSON()); return send({ keys: [] }); }
  if (/^\/api\/apps\/[^/]+\/connect$/.test(url.pathname)) {
    state.appConnects.push(url.pathname);
    return send({ redirectUrl: `${base}/fixture-provider` });
  }
  if (url.pathname === '/api/apps/connections') return send({ connections: [] });
  if (url.pathname === '/api/apps') {
    if (url.searchParams.has('limit')) return send({ connected: ['slack'], connectedApps: [slack] });
    const search = url.searchParams.get('search');
    const offset = Number(url.searchParams.get('offset'));
    state.appPages.push({ search, offset });
    if (search === 'calendar') return send({ apps: offset ? [calendly] : [calendar], total: 2, nextOffset: offset ? null : 1, connected: ['slack'], connectedApps: [slack], categories: ['productivity'] });
    return send({ apps: [calendar, slack], total: 2, nextOffset: null, connected: ['slack'], connectedApps: [slack], categories: ['productivity'] });
  }
  if (url.pathname === '/api/messaging' && method === 'GET') return send(state.messaging);
  if (url.pathname === '/api/messaging/email' && method === 'PUT') {
    const { email } = route.request().postDataJSON();
    state.emailWrites.push({ email, account: state.user?.id });
    state.messaging.account.email = email;
    return send(state.messaging);
  }
  if (url.pathname === '/api/messaging/my-invite' && method === 'POST') return send({ url: `${base}/join/local-invite`, remaining: 2 });
  if (url.pathname.startsWith('/api/platform/')) return send({ admin: false, settings: null });
  if (url.pathname === '/api/join/local-invite' && method === 'GET') return send({ valid: true, inviter: 'Fixture inviter', line, reason: null });
  if (url.pathname === '/api/join/local-invite/claim' && method === 'POST') {
    state.invites.push(route.request().postDataJSON());
    return send({ ok: true });
  }
  if (url.pathname === '/api/bots') return send({ bots: [], live: [] });
  if (url.pathname === '/api/computer') return send({ computer: state.local.computer });
  if (url.pathname === '/api/models') return send({ models: [], favourites: [], canFast: false });
  if (url.pathname === '/api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
  return send({ error: 'No fixture for this endpoint.' }, 404);
});
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  return url.origin === base ? route.fallback() : route.abort();
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.setDefaultTimeout(10_000);
const button = name => page.getByRole('button', { name, exact: true });
const heading = name => ['Your account', 'Text your Bots'].includes(name) ? page.locator('.shell-header, .app-settings__page').getByText(name === 'Your account' ? 'Account' : 'Messaging', { exact: true }).first() : page.getByRole('heading', { name, exact: true });
const disclose = async name => { const summary = page.locator('summary').filter({ hasText: name }).first(); if (!(await summary.evaluate(el => el.parentElement.open))) await summary.click(); };
const menu = async name => { await button('Manage').click(); await page.getByRole('menuitem', {name, exact:true}).click(); };
const replaceKey = async () => { await page.locator('.openrouter-settings').getByRole('button', {name:'Replace',exact:true}).click(); };
const openrouterSave = () => page.locator('.openrouter-settings').getByRole('button', {name:'Save',exact:true});
const open = async section => { await page.goto(`${base}/#settings/${section}`); if(section === 'account') await disclose('Sessions'); };
const reloadSection = async section => { await page.goto(`${base}/?fixture=${Date.now()}#settings/${section}`); if(section === 'account') await disclose('Sessions'); };
const shot = async name => {
  if (!screenshots) return;
  await page.locator('.app-settings__main').evaluateAll(elements => elements.forEach(element => { element.scrollTop = 0; }));
  await page.screenshot({ path: join(screenshots, name), animations: 'disabled' });
};
const headerFocused = () => page.waitForFunction(() => document.activeElement?.matches('.app-settings__main > .sr-only'));

async function releaseAfterDeparture(gate, leave, path = '/api/auth/me', method = 'GET') {
  try {
    await Promise.race([gate.arrived, page.waitForTimeout(5000).then(() => { throw new Error(`No suspended request for ${method} ${path}`); })]);
    await leave();
    const response = page.waitForResponse(result => new URL(result.url()).pathname === path && result.request().method() === method);
    gate.release();
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  } finally { gate.release(); }
}

async function assertMcpActionsFit(width) {
  const actions = page.locator('.mcp-server').filter({ hasText: 'Example tools' }).locator('.mcp-server__actions :is(button, [role="switch"])');
  assert.equal(await actions.count(), 1, 'One Manage action keeps rare server controls together.');
  const bounds = await actions.evaluateAll(elements => elements.map(element => {
    const { left, right, top, width } = element.getBoundingClientRect();
    const onTop = element.contains(document.elementFromPoint(left + width / 2, top + element.clientHeight / 2));
    return { left, right, top, onTop };
  }));
  assert.ok(bounds.every(action => action.left >= 0 && action.right <= width - 16 && action.onTop), JSON.stringify(bounds));
  assert.ok(bounds.every(action => action.right - action.left >= 44), 'Manage has a full touch target.');
}

async function emailSignIn(email) {
  await page.getByLabel('Dev sign-in email').fill(email);
  await button('Continue with email').click();
}

try {
  await open('account');
  await heading('Your account').waitFor();
  await page.getByText('Fixture session list unavailable.').waitFor();
  await button('Retry').click();
  const current = page.locator('.account-session').filter({ hasText: 'Current session' });
  const other = page.locator('.account-session').filter({ hasText: 'Android' });
  await other.getByText('Last active').waitFor();
  assert.equal(await page.getByText(currentId).count(), 0);
  assert.equal(await page.getByText(otherId).count(), 0);
  await shot('access-account-desktop-light.png');
  await other.getByRole('button', { name: 'Sign out session' }).click();
  await button('Cancel').click();
  assert.equal(state.revoked.length, 0);
  await other.getByRole('button', { name: 'Sign out session' }).click();
  state.user = bob;
  await button('Confirm sign-out').click();
  await page.getByText(/no longer signed in to that account/).waitFor();
  assert.equal(state.revoked.length, 0, 'A changed cookie account must not receive a revoke request.');
  state.user = alice;
  await button('Confirm sign-out').click();
  await page.getByText('Session signed out.').waitFor();
  await other.waitFor({ state: 'detached' });
  assert.deepEqual(state.revoked, [otherId]);
  await current.getByRole('button', { name: 'Sign out here' }).click();
  await button('Confirm sign-out').click();
  await heading('Welcome to Swarm').waitFor();
  assert.deepEqual(state.revoked, [otherId, currentId]);
  await shot('access-signin-desktop-light.png');

  state.user = alice;
  state.activeSession = currentId;
  state.sessions = [{ id: currentId, created_at: now }, { id: rotatedId, device: 'Rotated device', created_at: now }];
  await reloadSection('account');
  const rotated = page.locator('.account-session').filter({ hasText: 'Rotated device' });
  await rotated.getByRole('button', { name: 'Sign out session' }).click();
  state.activeSession = rotatedId;
  await button('Confirm sign-out').click();
  await heading('Welcome to Swarm').waitFor();
  assert.equal(state.revoked.at(-1), rotatedId, 'The request session, not the old badge, decides whether to leave the app.');

  state.user = alice;
  await reloadSection('general');
  await heading('General').waitFor();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  assert.equal(await nav.locator('xpath=ancestor::*[contains(@class,"app-settings__nav")]').count(), 1);
  await shot('access-general-desktop-light.png');
  await button('Collapse sidebar').click();
  await button('Expand sidebar').click();
  await nav.getByLabel('Search settings').fill('sessions');
  await nav.getByRole('button', { name: 'Account', exact: true }).click();
  await heading('Your account').waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('region', { name: 'Settings', exact: true }).waitFor();
  await headerFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('region', { name: 'Settings', exact: true }).waitFor();
  await headerFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await button('Back').click();
  await page.goto(`${base}/#settings`);
  await page.locator('.shell-header').getByText('Settings',{exact:true}).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await shot('access-settings-phone-night.png');
  await nav.getByLabel('Search settings').fill('not-a-setting');
  await page.getByText(/No settings match/).waitFor();
  await nav.getByLabel('Search settings').fill('delete');
  await nav.getByRole('button', { name: 'Account', exact: true }).click();
  await menu('Delete account');
  await heading('Delete your Swarm account?').waitFor();
  await shot('access-account-delete-phone-night.png');
  assert.equal(state.deletes, 0);
  await button('Delete my account').click();
  await heading('Confirm it’s you').waitFor();
  await emailSignIn(alice.email);
  await page.getByText("You're signed in again. Nothing has been deleted.").waitFor();
  assert.equal(state.deletes, 1, 'Account deletion requires another explicit confirmation.');
  await button('Cancel').click();
  await heading('Your account').waitFor();

  state.fresh = false;
  await reloadSection('mcp');
  await button('Add MCP server').click();
  await page.getByLabel('Name', { exact: true }).fill('Recovered draft');
  await page.getByLabel('Server URL').fill('https://fixture.invalid/private-endpoint');
  await page.getByText('Authentication & headers', { exact: true }).click();
  await page.getByLabel('Bearer token (optional)', { exact: true }).fill(token);
  await button('Save & test connection').click();
  await heading('Confirm it’s you').waitFor();
  const saved = await page.evaluate(() => sessionStorage.getItem('swarm.access-return.mcp'));
  assert.ok(saved.includes('Recovered draft'));
  assert.ok(!saved.includes(token) && !saved.includes('private-endpoint'));
  await emailSignIn(alice.email);
  await page.getByText(/Review your draft/).waitFor();
  assert.equal(state.writes.length, 1, 'A recent sign-in cannot replay an MCP save.');
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Recovered draft');
  assert.equal(await page.getByLabel('Server URL').inputValue(), '');
  await page.getByLabel('Server URL').fill('https://fixture.invalid/new-endpoint');
  await button('Save & test connection').click();
  await page.getByText(/Saved, but the connection test failed/).waitFor();
  assert.equal(state.writes.length, 2);
  assert.ok(!('bearerToken' in state.writes[1]));
  await assertMcpActionsFit(390);
  await shot('access-mcp-phone-night.png');
  await page.setViewportSize({ width: 320, height: 844 });
  await assertMcpActionsFit(320);
  await page.setViewportSize({ width: 390, height: 844 });

  state.fresh = false;
  await page.locator('.mcp-server').filter({hasText:'Example tools'}).getByRole('button',{name:'Manage Example tools',exact:true}).click();
  await page.getByRole('menuitem',{name:'Connect account',exact:true}).click();
  await heading('Confirm it’s you').waitFor();
  await emailSignIn(alice.email);
  await page.getByText(/Select Connect account on the server/).waitFor();
  assert.equal(state.oauth, 1, 'MCP OAuth does not auto-start after Swarm sign-in.');
  await page.locator('.mcp-server').filter({hasText:'Example tools'}).getByRole('button',{name:'Manage Example tools',exact:true}).click();
  await page.getByRole('menuitem',{name:'Connect account',exact:true}).click();
  await page.getByText('Fixture provider refused authorization.').waitFor();

  state.fresh = false;
  await button('Add MCP server').click();
  await page.getByLabel('Name', { exact: true }).fill('Alice-only draft');
  await page.getByLabel('Server URL').fill('https://fixture.invalid/account-only');
  await button('Save & test connection').click();
  await heading('Confirm it’s you').waitFor();
  const verifyCount = state.verifies.length;
  await emailSignIn(bob.email);
  await page.getByText(/expired or belongs to another account/).waitFor();
  assert.equal(state.verifies.length, verifyCount);
  assert.equal(await page.getByText('Alice-only draft').count(), 0);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('swarm.access-return.mcp')), null);
  assert.equal(state.writes.length, 3);

  state.user = alice;
  state.local = { computer: connectedComputer, paired: true, active: true };
  await page.setViewportSize({ width: 1440, height: 900 });
  await reloadSection('computer');
  await page.getByText('Your PC',{exact:true}).waitFor();
  await menu('Stop');
  await page.getByText('Stop this computer? Its pairing is kept.').waitFor();
  assert.equal(state.deviceActions.length, 0);
  await button('Stop').click();
  await page.locator('.app-settings__page').getByText('Not connected',{exact:true}).waitFor();
  await menu('Disconnect');
  await page.getByText('Disconnect this PC? Pair again to reconnect.').waitFor();
  await button('Disconnect').click();
  await page.getByText('Disconnect this PC? Pair again to reconnect.').waitFor({state:'detached'});
  assert.deepEqual(state.deviceActions, [
    { path: '/api/computer/this-computer', method: 'DELETE', account: alice.id },
    { path: '/api/computer/pair', method: 'DELETE', account: alice.id },
  ]);
  await shot('access-device-desktop-night.png');

  state.local = { computer: connectedComputer, paired: true, active: true };
  await reloadSection('computer');
  await menu('Stop');
  const stopPreflight = holdRequest('/api/auth/me');
  await button('Stop').click();
  await releaseAfterDeparture(stopPreflight, () => nav.getByRole('button', { name: 'General', exact: true }).click());
  assert.equal(state.deviceActions.length, 2, 'Closing Computer during preflight must not stop the companion.');

  await nav.getByRole('button', { name: 'Computer', exact: true }).click();
  await menu('Stop');
  const stopDispatched = holdRequest('/api/computer/this-computer', 'DELETE');
  await button('Stop').click();
  await releaseAfterDeparture(stopDispatched, () => nav.getByRole('button', { name: 'General', exact: true }).click(), '/api/computer/this-computer', 'DELETE');
  assert.equal(state.deviceActions.length, 3, 'An already dispatched Stop still completes.');
  await nav.getByRole('button', { name: 'Computer', exact: true }).click();
  await page.locator('.app-settings__page').getByText('Not connected',{exact:true}).waitFor();

  state.fresh = false;
  await reloadSection('keys');
  await page.locator('.openrouter-settings').waitFor(); await replaceKey();
  const keyField = page.getByLabel('OpenRouter API key', { exact: true });
  await keyField.fill(token);
  await openrouterSave().click();
  await heading('Confirm it’s you').waitFor();
  assert.equal(await keyField.inputValue(), '');
  assert.ok(!(await page.evaluate(() => JSON.stringify({ ...sessionStorage }))).includes(token));
  await emailSignIn(alice.email);
  await page.getByText(/Review your credentials and retry/).waitFor();
  assert.equal(state.providerWrites.length, 1, 'A stale credential change is not replayed.');
  await replaceKey(); await keyField.fill(token);
  await openrouterSave().click();
  await page.getByText('Key saved.',{exact:true}).waitFor();
  assert.equal(await keyField.count(), 0);
  assert.deepEqual(state.providerWrites.map(entry => entry.account), [alice.id, alice.id]);
  await button('Default API model').click();
  await page.getByRole('option').filter({ hasText: 'Other model' }).waitFor();
  await page.getByRole('textbox', { name: 'Search models' }).fill('Other');
  await page.getByRole('textbox', { name: 'Search models' }).press('ArrowDown');
  await page.getByRole('option').filter({ hasText: 'Other model' }).press('Enter');
  await page.waitForFunction(() => document.querySelector('[aria-label^="Default API model:"]')?.textContent.includes('Other model'));
  assert.deepEqual(state.providerWrites.at(-1), { account: alice.id, body: { model: 'fixture/other' } });
  await shot('access-openrouter-desktop-night.png');

  const leaveKeys = () => nav.getByRole('button', { name: 'General', exact: true }).click();
  const providerWrites = state.providerWrites.length;
  await replaceKey(); await keyField.fill(token);
  const providerSave = holdRequest('/api/auth/me');
  await openrouterSave().click();
  await releaseAfterDeparture(providerSave, leaveKeys);
  assert.equal(state.providerWrites.length, providerWrites);
  await nav.getByRole('button', { name: 'API keys', exact: true }).click();
  await page.locator('.private-keys-settings .settings-key-row').filter({hasText:'Model API'}).getByRole('button',{name:'Add key',exact:true}).click();
  const privateKey = page.getByLabel('Model API API key', { exact: true });
  await privateKey.fill(token);
  const privateSave = holdRequest('/api/auth/me');
  await privateKey.locator('xpath=ancestor::form').getByRole('button', { name: 'Save', exact:true }).click();
  await releaseAfterDeparture(privateSave, leaveKeys);
  assert.deepEqual(state.privateWrites, []);
  await nav.getByRole('button', { name: 'API keys', exact: true }).click();
  await replaceKey();
  await button('Key options').click();
  const oauthPreflight = holdRequest('/api/auth/me');
  await page.getByRole('menuitem', { name: 'Enable sign-in', exact: true }).click();
  await releaseAfterDeparture(oauthPreflight, leaveKeys);
  assert.equal(state.providerStarts, 0);

  await reloadSection('subscriptions');
  await heading('Models & access').waitFor();
  await page.locator('[data-provider="codex"]').getByRole('button',{name:'Connect',exact:true}).click();
  await page.getByRole('dialog',{name:'Connect ChatGPT',exact:true}).waitFor();
  await page.getByRole('dialog',{name:'Connect ChatGPT',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
  await shot('access-models-desktop-night.png');
  await reloadSection('apps');
  await button('Connect').click();
  await heading('Connect an app').waitFor();
  await page.getByLabel('Search apps', { exact: true }).fill('calendar');
  await button('Connect Google Calendar').waitFor();
  await button('Load more').click();
  await button('Connect Calendly').waitFor();
  assert.deepEqual(state.appPages.filter(request => request.search === 'calendar'), [{ search: 'calendar', offset: 0 }, { search: 'calendar', offset: 1 }]);
  await shot('access-apps-desktop-night.png');
  const catalogPreflight = holdRequest('/api/auth/me');
  const catalogPopupPromise = page.waitForEvent('popup');
  await button('Connect Google Calendar').click();
  const catalogPopup = await catalogPopupPromise;
  const catalogClosed = catalogPopup.waitForEvent('close');
  await releaseAfterDeparture(catalogPreflight, () => button('Close catalog').click());
  await catalogClosed;
  assert.deepEqual(state.appConnects, []);
  await heading('Connected apps').waitFor();
  await button('Back to chat').click();
  await page.getByRole('region', { name: 'Settings', exact: true }).waitFor({state:'detached'});

  const caller = button('Account & settings');
  await caller.click();
  await page.getByRole('menuitem', { name: /Settings/ }).click();
  await headerFocused();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.matches('.account__btn'));
  await caller.focus();
  await page.keyboard.press('Control+,');
  await headerFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('region', { name: 'Settings', exact: true }).waitFor();
  await headerFocused();
  await page.keyboard.press('Escape');
  if (await page.getByRole('region', {name:'Settings',exact:true}).count()) await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.matches('.main-pane, .phone-tabs button') && document.activeElement.checkVisibility());

  await page.setViewportSize({ width: 390, height: 844 });
  await reloadSection('messaging');
  await heading('Text your Bots').waitFor(); await disclose('Learn more');
  await button('Manage preferences').click();
  await page.getByLabel('Messages go to').waitFor();
  await button('Hide preferences').click();
  const gmailPreflight = holdRequest('/api/auth/me');
  const gmailPopupPromise = page.waitForEvent('popup');
  await button('Connect Gmail').click();
  const gmailPopup = await gmailPopupPromise;
  const gmailClosed = gmailPopup.waitForEvent('close');
  await releaseAfterDeparture(gmailPreflight, () => button('Back').click());
  await gmailClosed;
  assert.deepEqual(state.appConnects, []);
  await nav.getByRole('button', { name: 'Messaging', exact: true }).click(); await disclose('Learn more');
  const googlePreflight = holdRequest('/api/auth/me');
  await page.getByRole('link', { name: 'Connect Google', exact: true }).click();
  await releaseAfterDeparture(googlePreflight, () => button('Back').click());
  assert.deepEqual(state.emailWrites, []);
  await nav.getByRole('button', { name: 'Messaging', exact: true }).click(); await disclose('Learn more');
  assert.equal(await page.getByLabel('Desktop sign-in email').count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Connect Google', exact: true }).getAttribute('href'), '/api/auth/google/start?intent=link');
  assert.equal(await page.getByText('Google connected', { exact: true }).count(), 0);
  await shot('access-messaging-phone-night.png');
  await button('Get my invite link').click();
  await page.getByText(`${base}/join/local-invite`, { exact: true }).waitFor();
  await page.goto(`${base}/join/local-invite`);
  await heading('You’re invited to Swarm').waitFor();
  await shot('access-invite-phone-night.png');
  await page.getByLabel('Phone number', { exact: true }).fill('+14155550142');
  await button('Continue').click();
  await heading('One last step').waitFor();
  assert.deepEqual(state.invites, [{ phone: '+14155550142' }]);
  assert.equal(await page.getByRole('link', { name: 'Text Swarm', exact: true }).getAttribute('href'), line.smsLink);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  // R2F-027: an offline permissions load says what to do, never the browser's "Failed to fetch".
  const offline = await context.newPage();
  offline.on('pageerror', error => errors.push(error.message));
  await offline.route('**/api/policies', route => route.abort('internetdisconnected'));
  await offline.goto(`${base}/#settings/permissions`);
  const offlineAlert = offline.getByRole('alert').filter({ hasText: "Couldn't load permissions." });
  await offlineAlert.waitFor({ timeout: 10_000 });
  const offlineText = await offlineAlert.innerText();
  assert.match(offlineText, /Couldn't load permissions\. Check your connection\./);
  assert.doesNotMatch(offlineText, /Failed to fetch|NetworkError|Load failed/i);
  await offline.close();
  assert.deepEqual(errors, []);
  console.log('Access UI passed: navigation, own sessions, deletion/MCP/key reauthentication, device stop vs disconnect, provider model selection, catalog paging, and messaging/invite payloads.');
} finally {
  await browser.close();
}

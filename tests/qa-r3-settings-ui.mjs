// Run against root's local frontend. All API requests are fixtures; no test server is started.
// Gate: UI_ORIGIN=http://127.0.0.1:5193 node tests/qa-r3-settings-ui.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.QA_R3_SETTINGS_UI_BASE ?? process.env.UI_ORIGIN ?? 'http://127.0.0.1:5193';
assert.match(base, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Use a local frontend for settings fixtures.');
const account = { id: 'settings-account', email: 'settings@example.test', name: 'Account', avatarUrl: null, timezone: 'UTC' };
const bot = {
  id: 'bot_settings_fixture', name: 'Coordinator Bot', label: '', description: 'Fixture coordinator', instructions: 'Review supplied notes.',
  avatarShape: 'square', avatarColor: 'blue', mode: 'personal', isPrimary: true, pinned: false, kind: 'agent',
  effort: 'medium', fast: false, model: 'x-ai/grok-4.7', voice: '', voiceSpeed: 1, voiceLanguage: 'auto',
  generation: 1, unread: 0, lastPreview: null, lastActivityAt: 1, createdAt: 1, onboarding: { status: 'active' },
};
const duplicate = { ...bot, id: 'bot_duplicate_fixture', isPrimary: false };
const worker = { ...bot, id: 'settings-worker', name: 'Worker Bot', isPrimary: false };
const computer = (status, provider = 'cloudvm') => ({ status, provider, screens: [], orgoId: null, error: null, desktop: false });
const settings = {
  enabled: true, automaticReview: true, memoryReview: true, skillReview: true, skillApproval: true,
  memoryTurnInterval: 10, skillIterationInterval: 10, maxIterations: 16, maxInputTokens: 32000,
  auxiliaryModel: null, auxiliaryProvider: null, curatorEnabled: true, curatorIntervalHours: 168,
  curatorMinIdleHours: 2, curatorStaleDays: 14, curatorArchiveDays: 30, curatorConsolidate: false,
};
const state = {
  computer: computer('suspended'), stage: 'review', preparation: 'ready', setupMode: 'ready',
  source: undefined, overrides: { enabled: false }, writes: [], reads: [],
};
function setup(target) {
  return {
    botId: target.id,
    manifest: {
      format: 'swarm-bot-setup', version: 1, bot: { name: target.name, label: '', instructions: target.instructions }, source: state.source,
      brief: {
        purpose: 'Review supplied notes.', responsibilities: ['Summarize supplied notes.'], success_criteria: ['A concise summary.'],
        action_boundaries: 'Ask before any external action.', out_of_scope: [], context_summary: 'Supplied notes only.',
        shared_resources: ["User's private Slack account connected account, toolkit slack, revision 1, status EXPIRED"],
        handoff_notes: [], communication_style: 'Concise.', working_principles: [], workflows: [], open_questions: [],
      },
    },
    computer: { status: state.preparation, error: null },
    onboarding: { status: state.stage, revision: 1, confirmedAt: null, missing: [] },
    files: { 'AGENTS.md': '# Saved setup' },
  };
}
let heldSetup;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? process.env.CHROME_PATH ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'UTC' });
await context.addInitScript(() => {
  localStorage.setItem('swarm.selectedBot', 'bot_settings_fixture');
  // Keep the live event stream entirely in the fixture. Individual computer events use handleEvent.
  window.EventSource = class {
    static CLOSED = 2;
    readyState = 1;
    constructor() { window.__emit = event => this.onmessage?.({ data: JSON.stringify(event) }); queueMicrotask(() => this.onopen?.({})); }
    close() { this.readyState = 2; }
  };
});
await context.route('**/api/**', async route => {
  const request = route.request(), url = new URL(request.url());
  const send = (json, status = 200) => route.fulfill({ status, json });
  if (url.origin !== base) return route.abort();
  if (request.method() !== 'GET') { state.writes.push({ path: url.pathname, method: request.method() }); return send({ error: 'Unexpected fixture write.' }, 400); }
  state.reads.push(url.pathname + url.search);
  if (url.pathname === '/api/auth/me') return send({ user: account, devLogin: true });
  if (url.pathname === '/api/bots') return send({ bots: [bot, worker, duplicate], live: [] });
  if (/\/bots\/[^/]+\/rows$/.test(url.pathname)) return send({ generation: 1, rows: [] });
  if (/\/bots\/[^/]+\/routines$/.test(url.pathname)) return send({ routines: [] });
  if (/\/bots\/[^/]+\/tasks$/.test(url.pathname)) return send({ tasks: [] });
  if (/\/bots\/[^/]+\/settings$/.test(url.pathname)) return send({ skills: [], memories: [], routines: [], approvals: [], connections: [] });
  if (/\/bots\/[^/]+\/coworker-setups$/.test(url.pathname)) return send({ setups: [setup(worker)] });
  if (/\/bots\/[^/]+\/setup$/.test(url.pathname)) {
    if (heldSetup) { const gate = heldSetup; gate.arrived(); await gate.promise; }
    if (state.setupMode === 'absent') return send({ error: 'No saved setup.' }, 404);
    if (state.setupMode === 'error') return send({ error: 'Fixture setup unavailable.' }, 503);
    return send(setup(url.pathname.includes(worker.id) ? worker : bot));
  }
  if (/\/learning\/bots\/[^/]+\/history$/.test(url.pathname)) return send({ entries: [], through: 0, latestVersion: 0, nextBefore: null, coverage: 'No recorded changes.' });
  if (url.pathname === '/api/learning/settings') {
    const botId = url.searchParams.get('botId');
    return send({ settings: { ...settings, ...(botId ? state.overrides : {}) }, account: settings, overrides: botId ? state.overrides : null, revision: 1, accountRevision: 1, botId });
  }
  if (url.pathname === '/api/computer') return send({ computer: state.computer });
  if (url.pathname === '/api/computer/details') return send({
    // Deliberately stale snapshot: the status UI must prefer the shared live state.
    computer: { ...state.computer, status: 'running' }, screens: [], hibernation: { idleMinutes: 10 },
    pairing: { paired: false }, localComputer: { enabled: false }, thisComputer: { available: false, active: false },
  });
  if (url.pathname === '/api/cli') return send({ selected: null, connected: false, providers: {} });
  if (url.pathname === '/api/providers/openrouter') return send({ active: false, defaultModel: 'x-ai/grok-4.7' });
  if (url.pathname === '/api/tasks') return send({ tasks: [] });
  if (url.pathname === '/api/needs-you') return send({ items: [] });
  if (url.pathname === '/api/models') return send({ provider: 'direct', billing: 'api', models: [], favourites: [], canFast: false });
  if (url.pathname === '/api/apps') return send({ apps: [], connected: [], connectedApps: [], categories: [] });
  if (url.pathname === '/api/apps/connections') return send({ connections: [] });
  if (url.pathname === '/api/settings/keys') return send({ isolated: true });
  return send({ error: 'No fixture for this read.' }, 404);
});
await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.fallback() : route.abort());
const page = await context.newPage();
page.setDefaultTimeout(10_000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let visits = 0;
const reload = async (hash = '') => { await page.goto(`${base}/?settings-fixture=${++visits}${hash}`); await page.locator('.app').waitFor(); };
const title = value => page.waitForFunction(expected => document.title === expected, value);
const openApp = async section => {
  await page.keyboard.press('Control+,');
  await page.getByRole('navigation', { name: 'Settings sections', exact: true }).getByRole('button', { name: section === 'computer' ? 'Computer' : 'Learning', exact: true }).click();
};
const openBot = async (tab = 'general') => {
  if (await page.locator('.app.is-mobile.pane-list').count()) await page.locator('.pinned__tile').click();
  await page.locator('.chat__pill').click();
  await page.getByRole('menuitem', { name: 'Bot settings', exact: true }).click();
  await page.locator('.bot-settings-page').waitFor();
  if (tab !== 'general') await page.locator('.bot-settings-page').getByRole('button', { name: 'Learning', exact: true }).click();
};
const liveComputer = async next => {
  state.computer = next;
  await page.evaluate(computer => window.__emit({ type: 'computer', state: computer }), next);
};
const details = page.getByRole('complementary', { name: 'Conversation details' });
const detailTab = name => details.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name, exact: true });
const card = page.getByRole('article', { name: 'Worker Bot setup' });
const statusLine = details.locator('.agent-config__computer');
const assertLine = async text => { await statusLine.filter({ hasText: text }).waitFor(); assert.equal(await statusLine.count(), 1); assert.equal(await statusLine.innerText(), text); };
const assertPhoneList = async () => {
  await page.locator('.app.is-mobile.pane-list').waitFor();
  assert.equal(await page.locator('.bot-settings-page').count(), 0);
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  assert.equal(new URL(page.url()).hash, '');
};

try {
  await reload();
  await card.waitFor();
  // R3 follow-up: copied settings links work without saved selection or a route cache.
  await openBot('learning');
  const settingsUrl = page.url();
  assert.ok(!settingsUrl.includes('bot_'));
  assert.ok(!settingsUrl.includes(bot.id));
  assert.match(new URL(settingsUrl).hash, /^#bot\/coordinator-bot~[a-z0-9]+\/settings\/learning$/);
  await page.reload(); await title('Coordinator Bot · Learning');
  await page.locator('.bot-settings-page .learning-flags').waitFor();
  const copied = await context.newPage();
  await copied.goto(settingsUrl);
  await copied.locator('.bot-settings-page .learning-flags').waitFor();
  assert.equal(await copied.title(), 'Coordinator Bot · Learning');
  await copied.close();
  await reload(`#bot/${duplicate.id}/settings/general`);
  await title('Coordinator Bot · General');
  const duplicateUrl = page.url();
  assert.ok(!duplicateUrl.includes('bot_'));
  assert.notEqual(new URL(duplicateUrl).hash.split('/')[1], new URL(settingsUrl).hash.split('/')[1]);
  state.reads = [];
  await page.reload(); await title('Coordinator Bot · General');
  assert.ok(state.reads.includes(`/api/bots/${duplicate.id}/settings`), 'reload restores the correct duplicate Bot');
  const model = page.getByRole('button', { name: 'Bot model', exact: true });
  await model.getByText('Grok 4.7', { exact: true }).waitFor();
  assert.ok(!(await model.innerText()).includes('x-ai/grok-4.7'));
  await page.screenshot({ path: '.context/slug-settings.png' });
  duplicate.model = null;
  await page.reload(); await title('Coordinator Bot · General');
  await model.getByText('Default · Grok 4.7', { exact: true }).waitFor();
  assert.ok(!(await model.innerText()).includes('x-ai/grok-4.7'));
  duplicate.model = bot.model;
  await page.keyboard.press('Escape'); await title('Swarm');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  for (const tab of ['Goals', 'Reports']) {
    await page.getByRole('navigation', { name: 'Work sections' }).getByRole('button', { name: tab, exact: true }).click();
    await title(tab);
    assert.equal(new URL(page.url()).hash, `#${tab.toLowerCase()}`);
    await page.reload(); await title(tab);
    assert.equal(await page.getByRole('navigation', { name: 'Work sections' }).getByRole('button', { name: tab, exact: true }).getAttribute('aria-current'), 'page');
    await openApp('learning'); await title('Settings · Learning');
    await page.keyboard.press('Escape'); await title(tab);
    assert.equal(new URL(page.url()).hash, `#${tab.toLowerCase()}`);
  }
  await page.locator('.pinned__tile').click(); await title('Swarm');
  assert.equal(new URL(page.url()).hash, '');
  await reload('#goals'); await title('Goals');
  await page.evaluate(() => { location.hash = '#reports'; }); await title('Reports');
  await page.goBack(); await title('Goals');
  await page.goForward(); await title('Reports');
  for (const tab of ['Goals', 'Reports']) {
    const hash = new URL(duplicateUrl).hash.replace('/settings/general', `/${tab.toLowerCase()}`);
    await reload(hash); await title(`Coordinator Bot · ${tab}`);
    await page.reload(); await title(`Coordinator Bot · ${tab}`);
    assert.equal(new URL(page.url()).hash, hash);
    assert.ok(!page.url().includes('bot_'));
  }
  await reload();
  await card.waitFor();
  assert.equal(await card.locator('.coworker-setup__readiness').innerText(), 'Computer: Asleep. Work waits for readiness.');
  await card.getByRole('button', { name: 'Review Worker Bot configuration' }).click();
  const resources = await card.locator('dt').filter({ hasText: /^Resources$/ }).evaluate(el => el.nextElementSibling.textContent);
  assert.equal(resources, "User's private Slack account, Reconnect required");
  await card.getByText('Original user answers', { exact: true }).click();
  await card.getByText('No original user answers were saved for this setup.', { exact: true }).waitFor();

  for (const source of [
    { sourceRefs: [{ botId: bot.id, generation: 1, seq: 1, text: ' ', contentHash: 'fixture' }], messages: [{ seq: 2, text: 'Use only the supplied notes.' }] },
    { sourceRefs: [{ botId: bot.id, generation: 1, seq: 3, text: 'Keep the summary concise.', contentHash: 'fixture' }], messages: [{ seq: 2, text: 'Use only the supplied notes.' }] },
    { sourceRefs: [], messages: [] },
  ]) {
    state.source = source; await reload();
    await card.getByRole('button', { name: 'Review Worker Bot configuration' }).click();
    await card.getByText('Original user answers', { exact: true }).click();
    const expected = source.sourceRefs[0]?.text.trim() || source.messages[0]?.text;
    if (expected) { assert.equal(await card.locator('blockquote').count(), 1); await card.locator('blockquote').getByText(expected, { exact: true }).waitFor(); }
    else await card.getByText('No original user answers were saved for this setup.', { exact: true }).waitFor();
  }

  await liveComputer(computer('running'));
  await card.locator('.coworker-setup__readiness').filter({ hasText: 'Computer: Awake.' }).waitFor();
  await liveComputer(computer('suspended'));
  await card.locator('.coworker-setup__readiness').filter({ hasText: 'Computer: Asleep.' }).waitFor();
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  assert.equal(await details.getByRole('button', { name: 'Open computer', exact: true }).locator('small').innerText(), 'Asleep');
  await detailTab('Setup').click();
  await assertLine('Computer: Asleep');
  await title('Coordinator Bot · Setup');

  // Every setup state, including initial loading, 404, errors, and all saved stages.
  for (const mode of ['absent', 'error', 'ready']) {
    state.setupMode = mode;
    await detailTab('Activity').click();
    await detailTab('Setup').click();
    if (mode === 'absent') await details.getByRole('button', { name: 'Start setup interview' }).waitFor();
    if (mode === 'error') await details.getByText('Fixture setup unavailable.', { exact: true }).waitFor();
    if (mode === 'ready') await details.getByRole('tab', { name: 'Responsibilities' }).waitFor();
    await assertLine('Computer: Asleep');
  }
  await detailTab('Activity').click();
  let release;
  const arrived = Promise.withResolvers();
  heldSetup = { promise: new Promise(resolve => { release = resolve; }), arrived: arrived.resolve };
  await detailTab('Setup').click(); await arrived.promise;
  await details.getByText('Loading configuration…', { exact: true }).waitFor();
  await assertLine('Computer: Asleep');
  heldSetup = undefined; release(); await details.getByRole('tab', { name: 'Responsibilities' }).waitFor();
  for (const stage of ['interviewing', 'review', 'active']) {
    for (const preparation of ['pending', 'ready']) {
      state.stage = stage; state.preparation = preparation;
      await detailTab('Activity').click(); await detailTab('Setup').click();
      await details.getByRole('tab', { name: 'Responsibilities' }).waitFor();
      await assertLine('Computer: Asleep');
      assert.equal(await details.getByRole('button', { name: 'Retry computer preparation' }).count(), preparation === 'pending' ? 1 : 0);
    }
  }
  for (const [tab, expected] of [['Harness', 'Coordinator Bot · Harness'], ['Files', 'Configuration files'], ['History', 'Coordinator Bot · History']]) {
    await details.getByRole('tab', { name: tab, exact: true }).click(); await title(expected);
    await assertLine('Computer: Asleep');
  }
  await page.getByRole('button', { name: 'New Bot', exact: true }).click();
  await page.locator('main.setup-create').waitFor(); await title('Swarm');
  await page.locator('main.setup-create').getByRole('button', { name: 'Close', exact: true }).click();
  await title('Coordinator Bot · History');
  await openApp('computer'); await title('Settings · Computer');
  await page.locator('.cloud-computer .cfg-row__title').filter({ hasText: 'Bots’ computer · Asleep' }).waitFor();
  await page.getByText(/On Linux, use Connect your PC/).waitFor();
  await page.keyboard.press('Escape'); await title('Coordinator Bot · History');
  await openBot('learning'); await title('Coordinator Bot · Learning');
  const learning = page.locator('.bot-settings-page .learning-flags label').first();
  assert.equal(await learning.getByRole('checkbox').isChecked(), false);
  assert.match(await learning.innerText(), /Bot override\.[\s\S]*On:[\s\S]*Off:[\s\S]*Saved memories and skills remain available/);
  assert.match(await page.locator('.bot-settings-page .learning-flags label').nth(1).innerText(), /Inherited from the account\.[\s\S]*On:[\s\S]*Off:/);
  await openApp('learning'); await title('Settings · Learning');
  const accountLearning = page.locator('.app-settings .learning-flags label').first();
  assert.equal(await accountLearning.getByRole('checkbox').isChecked(), true);
  assert.match(await accountLearning.innerText(), /On:[\s\S]*Off:/);
  await page.getByText('Defaults for learning across this account. Each Bot can override these settings.', { exact: true }).waitFor();
  await page.keyboard.press('Escape'); await title('Coordinator Bot · Learning');
  await page.keyboard.press('Escape'); await title('Coordinator Bot · History');
  await details.getByRole('button', { name: 'Close details', exact: true }).click(); await title('Swarm');

  // Linux guidance is present before pairing, including the minimal Connect your PC state.
  state.computer = computer('stopped', 'local');
  await reload('#settings/computer');
  await page.getByRole('heading', { name: 'Connect your PC', exact: true }).waitFor();
  await page.getByText(/On Linux, use Connect your PC/).waitFor();
  await page.getByText(/permissions apply only on macOS/).waitFor();
  await page.locator('.app-settings .cfg-row__sub').filter({ hasText: /^Not connected$/ }).waitFor();
  await page.keyboard.press('Escape');

  // Back button and browser Back at phone width, with clean and dirty drafts.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.app.is-mobile.pane-list').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('navigation', { name: 'Work sections' }).getByRole('button', { name: 'Goals', exact: true }).click();
  await title('Goals');
  await page.evaluate(() => { location.hash = '#reports'; }); await title('Reports');
  const workHistoryLength = await page.evaluate(() => history.length);
  await page.goBack(); await title('Goals');
  await page.goForward(); await title('Reports');
  assert.equal(await page.evaluate(() => history.length), workHistoryLength, 'work route traversal retains Forward history');
  await page.goBack(); await title('Goals');
  await page.goBack(); await assertPhoneList();
  await page.goForward(); await title('Goals');
  assert.equal(await page.evaluate(() => history.length), workHistoryLength);
  await page.getByRole('button', { name: 'Bot list', exact: true }).click(); await assertPhoneList();
  await openBot(); await page.getByRole('button', { name: 'Back to Bots', exact: true }).click();
  await assertPhoneList(); await title('Swarm');
  await openBot();
  const name = page.locator('.bot-settings-page').getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Edited Bot');
  await page.getByRole('button', { name: 'Back to Bots', exact: true }).click();
  const guard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  await guard.waitFor();
  await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await name.inputValue(), 'Edited Bot');
  assert.equal(await page.locator('.app.is-mobile.pane-chat').count(), 1);
  await page.getByRole('button', { name: 'Back to Bots', exact: true }).click();
  await guard.getByRole('button', { name: 'Discard', exact: true }).click(); await assertPhoneList();
  await openBot();
  const historyLength = await page.evaluate(() => history.length);
  await page.goBack(); await assertPhoneList();
  await page.goForward(); await page.locator('.bot-settings-page').waitFor();
  assert.equal(await page.evaluate(() => history.length), historyLength, 'Forward restores the existing settings entry');
  await page.goBack(); await assertPhoneList();
  await openBot(); await name.fill('Edited Bot');
  await page.goBack(); await guard.waitFor();
  await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await name.inputValue(), 'Edited Bot');
  await page.goBack(); await guard.waitFor();
  await guard.getByRole('button', { name: 'Discard', exact: true }).click(); await assertPhoneList();
  await openBot('learning');
  await page.locator('.bot-settings-page .learning-flags input').first().check();
  await openApp('learning');
  await page.locator('.app-settings .learning-flags input').first().waitFor();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.getByRole('button', { name: 'Back to Bots', exact: true }).click(); await guard.waitFor();
  await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await page.locator('.bot-settings-page .learning-flags input').first().isChecked(), true);
  await page.locator('.bot-settings-page summary').filter({ hasText: 'Skill maintenance' }).click();
  await page.getByRole('button', { name: 'Review skills and archive', exact: true }).click(); await guard.waitFor();
  await guard.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await page.locator('.bot-settings-page .learning-flags input').first().isChecked(), true);
  await page.getByRole('button', { name: 'Back to Bots', exact: true }).click();
  await guard.getByRole('button', { name: 'Discard', exact: true }).click(); await assertPhoneList();
  await reload('#bot/bot_settings_fixture/settings/general');
  await page.getByRole('button', { name: 'Back to Bots', exact: true }).click(); await assertPhoneList();
  assert.deepEqual(state.writes, [], 'these checks must not perform any API writes');
  assert.deepEqual(errors, []);
  console.log('PASS R3 settings: titles, guarded phone Back, live status on four surfaces, every Setup state, resources, original answers, Learning and Linux copy');
} finally { await browser.close(); }

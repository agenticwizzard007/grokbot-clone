// Shared Paper shell and live interaction regressions. Local fixtures only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const evidence = new URL('../.context/updated-ui-core/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
let server;
let origin = process.env.UI_ORIGIN;
if (!origin) {
  const port = await new Promise(resolve => { const socket = http.createServer().listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port)], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
}
const wait = async predicate => { for (let n = 0; n < 120; n++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('Timed out waiting for condition'); };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const appears = locator => locator.waitFor({ timeout: 500 }).then(() => true, error => { if (error.name !== 'TimeoutError') throw error; return false; });
const now = Date.now();
const bots = [
  { id: 'quinn', name: 'Quinn', label: 'Chief of Staff', isPrimary: true, avatarColor: 'blue', avatarShape: 'blob', kind: 'agent' },
  { id: 'nia', name: 'Nia', label: 'Research', avatarColor: 'violet', avatarShape: 'clover', kind: 'agent' },
  { id: 'room', name: 'Launch desk', label: 'Team conversation', avatarColor: 'green', avatarShape: 'cloud', kind: 'room' },
].map(b => ({ description: 'Your team is ready.', instructions: '', mode: 'personal', pinned: false, effort: 'medium', model: null, generation: 1, unread: 0, lastPreview: 'Ready for your next task', lastActivityAt: now, createdAt: now, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', ...b }));
const model = { id: 'fixture/model', name: 'Test Model', short: 'Test Model', author: 'test', efforts: ['low', 'medium', 'high'], reasoning: true, defaultEffort: 'medium', billing: 'api', vision: false, context: 10000 };
const row = (botId, n, role, text, generation = 1) => ({ botId, seq: n, updatedSeq: n, generation, createdAt: now - (4 - n) * 60_000, kind: 'message', body: { type: 'message', role, text } });
let browser;
try {
  await wait(() => fetch(origin).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [1440, 844, 390, 320]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const errors = [], writes = [], reads = [];
    const raceChecks = width === 1440 && theme === 'light';
    const phoneHistoryChecks = width === 390 && theme === 'dark';
    let sendGate, rowsGate, freshGate, generation = 1, createdRoom, rejectRoom = true, rejectCreatedList = true;
    page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(theme => {
      localStorage.setItem('swarm.theme', theme);
      localStorage.setItem('swarm.selectedBot', 'quinn');
      // The old right-column default cannot commandeer the new full-page setup.
      localStorage.setItem('swarm.detailsOpen', '1');
      window.EventSource = class {
        static CLOSED = 2;
        constructor() { window.emitFixtureEvent = event => this.onmessage?.({ data: JSON.stringify(event) }); setTimeout(() => this.onopen?.(), 0); }
        close() {}
      };
    }, theme);
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (request.method() !== 'GET') {
        writes.push({ path, body: request.postDataJSON() });
        if (path === '/api/bots/quinn/messages' && sendGate) await sendGate.promise;
        if (path === '/api/bots/quinn/fresh' && freshGate) await freshGate.promise;
        if (path === '/api/rooms') {
          if (rejectRoom) { rejectRoom = false; return route.fulfill({ status: 503, json: { error: 'Room creation temporarily unavailable' } }); }
          createdRoom = { ...bots[2], id: 'created-room', name: 'Release room', label: '' };
          return route.fulfill({ json: { id: createdRoom.id } });
        }
        if (!['/api/bots/quinn/messages', '/api/bots/quinn/fresh'].includes(path)) return route.fulfill({ status: 400, json: { error: 'Unexpected mutation' } });
        return route.fulfill({ json: { ok: true } });
      }
      reads.push(path);
      let body = {};
      if (path === '/api/auth/me') body = { user: { id: 'owner', name: 'Alex', email: 'alex@example.test' }, devLogin: false, googleLogin: false };
      else if (path === '/api/bots') {
        if (createdRoom && rejectCreatedList) { rejectCreatedList = false; return route.fulfill({ status: 503, json: { error: 'Could not refresh bots' } }); }
        body = { bots: createdRoom ? [...bots, createdRoom] : bots, live: [] };
      }
      else if (path.endsWith('/rows')) {
        const id = path.split('/')[3];
        const requestGeneration = id === 'quinn' ? generation : 1;
        if (id === 'quinn' && rowsGate) await rowsGate.promise;
        body = requestGeneration === 2
          ? { generation: 2, rows: [row(id, 1, 'assistant', 'Only the new conversation remains.', 2)] }
          : { generation: 1, rows: [row(id, 1, 'user', 'Can you turn the launch notes into a one-page brief?'), row(id, 2, 'assistant', 'I drafted the brief around timing, ownership, and the two decisions still open.')] };
      }
      else if (path.endsWith('/routines')) body = { routines: [] };
      else if (path.endsWith('/tasks')) body = { tasks: [] };
      else if (path.endsWith('/coworker-setups')) body = { setups: [] };
      else if (path === '/api/team/exchanges') body = { exchanges: [], nextBefore: null };
      else if (path === '/api/computer') body = { computer: { status: 'absent', screens: [] } };
      else if (path === '/api/models') body = { provider: 'openrouter', billing: 'api', models: [model], defaultModel: model.id, favourites: [model.id], canFast: false };
      else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'orgo' } };
      else if (path === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
      else if (path === '/api/checkins') body = { enabled: false, times: ['09:00'], timezone: 'UTC', timezoneSource: 'utc_fallback', quietHours: [] };
      else if (path === '/api/checkins/reports') body = { reports: [], nextCursor: 0, hasMore: false };
      else if (path === '/api/apps') body = { apps: [], connected: [], categories: [], total: 0 };
      return route.fulfill({ json: body });
    });
    if (phoneHistoryChecks) {
      await page.route(`${origin}/fixture-previous`, route => route.fulfill({ contentType: 'text/html', body: '<title>Previous document</title>' }));
      await page.goto(`${origin}/fixture-previous`);
    }
    await page.goto(origin);
    const searchButton = page.locator('.sidebar__search');
    const searchInput = page.getByRole('textbox', { name: 'Search', exact: true });
    const create = page.getByRole('main', { name: 'Create a Bot', exact: true });
    const group = page.getByRole('main', { name: 'New group chat', exact: true });
    const openCreate = () => page.getByRole('button', { name: 'New Bot', exact: true }).click();
    const openGroup = () => create.getByRole('button', { name: 'New group chat instead', exact: true }).click();
    const documentStart = await page.evaluate(() => performance.timeOrigin);
    if (width <= 760) {
      await page.locator('.sidebar').waitFor();
      await page.screenshot({ path: new URL(`bots-${width}-${theme}.png`, evidence).pathname });
      if (phoneHistoryChecks) {
        await openCreate(); await openGroup();
        await group.getByLabel('Group name', { exact: true }).fill('Do not submit');
        await page.goBack(); await create.waitFor();
        await openGroup();
        await group.getByRole('button', { name: 'Back to create a Bot', exact: true }).click();
        await create.waitFor();
        await page.goBack(); await page.locator('.sidebar').waitFor();
        assert.equal(await create.isVisible(), false);
        assert.equal(await page.evaluate(() => performance.timeOrigin), documentStart, 'phone setup Back never leaves the document');
      }
      await page.locator('.pinned__tile').click();
    }
    await page.locator('.composer__input').waitFor();
    await page.getByText('I drafted the brief around timing, ownership, and the two decisions still open.', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^Model: Test Model/ }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('.traffic-lights:visible').count(), 0);
    assert.equal(await page.locator('#app-settings-sidebar-slot').count(), 1);
    if (width > 760) {
      assert.equal(Math.round((await page.locator('.sidebar').boundingBox()).width), 272);
      assert.match(await page.locator('.sidebar-usage').innerText(), /API credits/);
    }
    for (const selector of ['.chat', '.composer', '.chat__header', '.bubble', '.composer__voice']) {
      const elements = await page.locator(selector).all();
      for (const element of elements) {
        const box = await element.boundingBox();
        assert.ok(box && box.x >= -1 && box.x + box.width <= width + 1, `${width}/${theme} ${selector} fits: ${JSON.stringify(box)}`);
      }
    }
    assert.equal(await page.locator('.chat').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    const color = await page.locator('.chat').evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(color, theme === 'dark' ? 'rgb(23, 34, 47)' : 'rgb(255, 255, 255)');
    await page.screenshot({ path: new URL(`chat-${width}-${theme}.png`, evidence).pathname });
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).waitFor();
    await page.getByRole('menuitem', { name: /Dictate a message/ }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click();
    // MF-007: every entry point asks first; Cancel leaves the chat untouched.
    await page.getByRole('dialog', { name: 'Start a new conversation?' }).getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(writes.some(w => w.path === '/api/bots/quinn/fresh'), false, 'Cancel must not clear the conversation');
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click();
    await page.getByRole('dialog', { name: 'Start a new conversation?' }).getByRole('button', { name: 'Start new conversation', exact: true }).click();
    await wait(() => writes.some(w => w.path === '/api/bots/quinn/fresh'));
    // The receipt is an app-level toast; dismiss it so later checks start clean.
    const receipt = page.locator('.toast--global', { hasText: 'Started a new conversation' });
    await receipt.waitFor();
    await receipt.click();
    await receipt.waitFor({ state: 'hidden' });
    await page.locator('.composer__input').fill('Keep my Quinn draft');
    if (raceChecks) {
      await searchButton.click();
      await searchInput.fill('no-matching-bot');
      assert.equal(await page.locator('#root').evaluate(el => el.inert), true, 'Search makes the underlying app inert');
      await page.keyboard.press('Control+i');
      await page.keyboard.press('Enter');
      assert.equal(await searchInput.evaluate(el => document.activeElement === el), true, 'composer shortcut must leave focus in Search');
      assert.equal(writes.some(w => w.path.endsWith('/messages')), false, 'Enter in Search must not send the underlying draft');
      await page.keyboard.press('Escape');
      await searchInput.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#root').evaluate(el => el.inert), false);
      assert.equal(await searchButton.evaluate(el => document.activeElement === el), true, 'closing Search restores its trigger');
      assert.equal(await page.locator('.composer__input').inputValue(), 'Keep my Quinn draft');
    }
    const showList = async () => {
      if (width <= 760) await page.getByRole('button', { name: /^All Bots/ }).click();
    };
    const select = async name => { await showList(); await page.locator('.bot-row', { hasText: name }).click(); };
    await select('Nia');
    await page.locator('.composer__input').fill('Keep my Nia draft');
    await showList(); await page.locator('.pinned__tile').click();
    assert.equal(await page.locator('.composer__input').inputValue(), 'Keep my Quinn draft');
    sendGate = gate();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await wait(() => writes.some(w => w.path === '/api/bots/quinn/messages'));
    await select('Nia');
    await page.locator('.composer__input').fill('A newer Nia draft');
    await showList(); await page.locator('.pinned__tile').click();
    assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true, 'returning to a pending send cannot submit it twice');
    if (raceChecks) { await searchButton.click(); await searchInput.waitFor(); }
    sendGate.resolve();
    await wait(async () => await page.locator('.composer__input').inputValue() === '');
    if (raceChecks) {
      assert.equal(await searchInput.evaluate(el => document.activeElement === el), true, 'settling a send cannot steal dialog focus');
      await page.keyboard.press('Escape');
    }
    await select('Nia');
    assert.equal(await page.locator('.composer__input').inputValue(), 'A newer Nia draft', 'late send must not clear another bot’s draft');
    await showList();
    if (width > 760) {
      await page.getByRole('button', { name: 'Back to Bots', exact: true }).click();
      await page.getByRole('heading', { name: 'Your Bots', exact: true }).waitFor();
    }
    await page.locator('.sidebar__search').click();
    await page.getByRole('textbox', { name: 'Search', exact: true }).fill('no-matching-bot');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await page.getByRole('textbox', { name: 'Search', exact: true }).fill('Nia');
    await page.keyboard.press('Enter');
    await page.locator('.composer__input').waitFor();
    assert.equal(await page.locator('.composer__input').inputValue(), 'A newer Nia draft', 'search for selected bot leaves other views without losing draft');
    if (raceChecks) {
      await page.locator('.pinned__tile').click();
      freshGate = gate();
      await page.locator('.chat__pill').click();
      await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click();
      await page.getByRole('dialog', { name: 'Start a new conversation?' }).getByRole('button', { name: 'Start new conversation', exact: true }).click();
      await wait(() => writes.filter(w => w.path === '/api/bots/quinn/fresh').length === 2);
      await select('Nia');
      const reset = page.waitForResponse(r => r.url().endsWith('/api/bots/quinn/fresh'));
      freshGate.resolve();
      await (await reset).finished();
      assert.equal(await appears(page.getByText('Started a new conversation', { exact: true })), false, 'a late Quinn reset must not post a receipt in Nia');

      await page.locator('.pinned__tile').click();
      rowsGate = gate();
      const rowsBefore = reads.filter(p => p === '/api/bots/quinn/rows').length;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await wait(() => reads.filter(p => p === '/api/bots/quinn/rows').length >= rowsBefore + 2);
      const newRow = row('quinn', 1, 'assistant', 'Only the new conversation remains.', 2);
      await page.evaluate(newRow => {
        window.emitFixtureEvent({ type: 'cleared', botId: 'quinn', generation: 2 });
        window.emitFixtureEvent({ type: 'rows', botId: 'quinn', generation: 2, rows: [newRow] });
      }, newRow);
      await page.getByText(newRow.body.text, { exact: true }).waitFor();
      generation = 2;
      const stale = page.waitForResponse(async r => r.url().endsWith('/api/bots/quinn/rows') && (await r.json()).generation === 1);
      rowsGate.resolve();
      await (await stale).finished();
      assert.equal(await appears(page.getByText('Can you turn the launch notes into a one-page brief?', { exact: true })), false, 'settling a pre-clear GET cannot restore an older generation');
      assert.equal(await page.getByText(newRow.body.text, { exact: true }).isVisible(), true);
      rowsGate = undefined;

      const edited = { ...newRow, updatedSeq: 3, body: { ...newRow.body, text: 'A newer streamed revision.' } };
      const current = page.waitForResponse(async r => r.url().endsWith('/api/bots/quinn/rows') && (await r.json()).generation === 2);
      await page.evaluate(edited => {
        window.emitFixtureEvent({ type: 'rows', botId: 'quinn', generation: 2, rows: [edited] });
        window.emitFixtureEvent({ type: 'cleared', botId: 'quinn', generation: 2 });
        window.dispatchEvent(new Event('online'));
      }, edited);
      await (await current).finished();
      assert.equal(await appears(page.getByText(newRow.body.text, { exact: true })), false, 'reconnect does not erase a newer updatedSeq in the same generation');
      assert.equal(await page.getByText(edited.body.text, { exact: true }).isVisible(), true);
      await page.locator('.chat__pill').click();
      await page.getByRole('menuitem', { name: 'New conversation', exact: true }).click();
      await page.getByRole('dialog', { name: 'Start a new conversation?' }).getByRole('button', { name: 'Start new conversation', exact: true }).click();
      await page.getByText('Started a new conversation', { exact: true }).waitFor();
    }
    if (phoneHistoryChecks) {
      await page.keyboard.press('Alt+Shift+N'); await openGroup();
      await group.waitFor();
      await page.goBack(); await create.waitFor();
      await page.goBack(); await page.locator('.composer__input').waitFor();
      assert.equal(await page.locator('.chat__pill').innerText(), 'Nia');
      assert.equal(await page.locator('.composer__input').inputValue(), 'A newer Nia draft');
      assert.equal(await page.evaluate(() => performance.timeOrigin), documentStart, 'phone setup Back restores the exact chat caller');
      await page.keyboard.press('Alt+Shift+N'); await openGroup();
      await group.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.locator('.composer__input').waitFor();
      assert.equal(await page.locator('.chat__pill').innerText(), 'Nia');
      assert.equal(await page.locator('.composer__input').inputValue(), 'A newer Nia draft');
    }
    if (width > 760) {
      const catalogReads = reads.filter(p => p === '/api/models').length;
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      await wait(async () => Math.abs((await page.locator('.sidebar').boundingBox()).width - 76) < 1);
      assert.equal(await page.locator('#app-settings-sidebar-slot').count(), 1);
      assert.equal(reads.filter(p => p === '/api/models').length, catalogReads, 'collapsing usage summary makes no provider request');
      await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    }
    if ((width === 1440 && theme === 'light') || (width === 390 && theme === 'dark')) {
      await showList();
      await openCreate(); await openGroup();
      await group.getByLabel('Group name', { exact: true }).fill('Release room');
      assert.equal(await group.getByRole('checkbox', { name: 'Launch desk', exact: true }).count(), 0, 'groups cannot be room members');
      await group.getByRole('checkbox', { name: 'Quinn', exact: true }).check();
      assert.equal(await group.getByRole('button', { name: 'Create group', exact: true }).isDisabled(), true);
      await group.getByRole('checkbox', { name: 'Nia', exact: true }).check();
      await group.getByRole('button', { name: 'Create group', exact: true }).click();
      await group.getByRole('alert').filter({ hasText: 'Room creation temporarily unavailable' }).waitFor();
      assert.equal(await group.getByLabel('Group name', { exact: true }).inputValue(), 'Release room');
      assert.equal(await group.getByRole('checkbox', { name: 'Nia', exact: true }).isChecked(), true);
      await group.getByRole('button', { name: 'Create group', exact: true }).click();
      await group.getByRole('alert').filter({ hasText: 'Group created. Could not open it yet:' }).waitFor();
      assert.equal(await group.getByLabel('Group name', { exact: true }).isDisabled(), true);
      await group.getByRole('button', { name: 'Open created group', exact: true }).click();
      await page.locator('.chat__pill').filter({ hasText: 'Release room' }).waitFor();
      assert.deepEqual(writes.filter(w => w.path === '/api/rooms').map(w => w.body), [
        { name: 'Release room', botIds: ['quinn', 'nia'] }, { name: 'Release room', botIds: ['quinn', 'nia'] },
      ]);
      if (phoneHistoryChecks) {
        await showList(); await page.locator('.sidebar').waitFor();
        assert.equal(await create.isVisible(), false, 'leaving the created group does not reopen setup');
        assert.equal(await group.isVisible(), false);
        assert.equal(await page.evaluate(() => performance.timeOrigin), documentStart);
      }
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(writes.filter(w => w.path !== '/api/rooms').map(w => w.path), ['/api/bots/quinn/fresh', '/api/bots/quinn/messages', ...(raceChecks ? ['/api/bots/quinn/fresh', '/api/bots/quinn/fresh'] : [])]);
    assert.deepEqual(writes.find(w => w.path === '/api/bots/quinn/messages')?.body, { text: 'Keep my Quinn draft' });
    console.log(`PASS ${width}px ${theme}: geometry, tokens, list/search/return, actions, drafts, late response, passive usage`);
    await page.close();
  }
} finally { await browser?.close(); server?.kill(); }

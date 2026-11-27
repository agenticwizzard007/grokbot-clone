// Chat and shell regressions from QA round 2 (R2F-006, 008, 013, 024, 025, 030, 031, 032, 033, 034).
// Built frontend with mocked API responses; no provider calls, shared database or live account.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright';

const evidence = new URL('../.context/chat-shell-ui/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
let server, origin = process.env.UI_ORIGIN, logs = '';
if (!origin) {
  const port = await new Promise(resolve => { const socket = http.createServer().listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); }); });
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
  server.stdout.on('data', d => { logs += d; }); server.stderr.on('data', d => { logs += d; });
}
const wait = async (predicate, label = 'condition') => { for (let n = 0; n < 200; n++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error(`Timed out waiting for ${label}`); };
const now = Date.now();
const base = { description: '', instructions: '', mode: 'personal', pinned: false, effort: 'medium', model: null, generation: 1, unread: 0, lastPreview: 'Ready for your next task', lastActivityAt: now, createdAt: now, voice: 'ara', voiceSpeed: 1, voiceLanguage: 'auto', kind: 'agent', onboarding: { status: 'active' } };
const bots = [
  { ...base, id: 'quinn', name: 'Quinn', label: 'Chief of Staff', isPrimary: true, avatarColor: 'blue', avatarShape: 'blob' },
  { ...base, id: 'nia', name: 'Nia', label: 'Research', avatarColor: 'violet', avatarShape: 'clover', lastActivityAt: now - 1000 },
  { ...base, id: 'wren', name: 'Wren', label: 'Writer', avatarColor: 'green', avatarShape: 'cloud', lastActivityAt: now - 2000 },
  { ...base, id: 'setup-bot', name: 'Ledger', label: '', avatarColor: 'orange', avatarShape: 'heart', lastActivityAt: now - 3000, onboarding: { status: 'interviewing' } },
  ...Array.from({ length: 16 }, (_, n) => ({ ...base, id: `extra-${n}`, name: `Helper ${n + 1}`, label: '', avatarColor: 'pink', avatarShape: 'flower', lastActivityAt: now - 10_000 - n * 1000 })),
];
const model = { id: 'fixture/model', name: 'Test Model', short: 'Test Model', author: 'test', efforts: ['low', 'medium', 'high'], reasoning: true, defaultEffort: 'medium', billing: 'api', vision: true, context: 10000 };
const message = (botId, seq, role, text) => ({ botId, generation: 1, seq, updatedSeq: seq, createdAt: now - (40 - seq) * 60_000, kind: 'message', body: { type: 'message', role, text } });
const card = (botId, seq, body, updatedSeq = seq) => ({ botId, generation: 1, seq, updatedSeq, createdAt: now - (40 - seq) * 60_000, kind: 'card', body: { type: 'card', ...body } });
const quinnRows = () => [
  ...Array.from({ length: 24 }, (_, n) => message('quinn', n + 1, n % 2 ? 'assistant' : 'user', n === 2 ? 'The launch checklist lives in the shared folder.' : `Earlier note ${n + 1} about planning the week.`)),
  // R2F-006: present_draft writes a draft card with no approval behind it.
  card('quinn', 25, { card: 'draft', channel: 'email', to: 'team@example.test', subject: 'Hello from the team', text: 'Hi team,\n\nA quick hello before the launch.\n\nThanks', approvalId: '', status: draftStatus }, draftStatus === 'pending' ? 25 : 29),
  card('quinn', 26, { card: 'approval', approvalId: 'apr_fixtureApproval1', tool: 'GMAIL_SEND_EMAIL', toolkit: 'gmail', toolkitName: 'Gmail', title: 'Send an email to the team', detail: 'Subject: Launch', status: approvalStatus }, approvalStatus === 'pending' ? 26 : 30),
];
let approvalStatus = 'pending', draftStatus = 'pending';

let browser;
try {
  await wait(() => fetch(origin).then(r => r.ok, () => false), 'preview');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: 'reduce' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], writes = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem('swarm.selectedBot', 'quinn');
    window.EventSource = class {
      static CLOSED = 2;
      constructor() { window.__emit = event => this.onmessage?.({ data: JSON.stringify(event) }); setTimeout(() => this.onopen?.(), 0); }
      close() {}
    };
  });
  let roomError = true;
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (path.endsWith('/suggested-apps')) return route.fulfill({ json: { suggestions: [] } });
    if (request.method() !== 'GET') {
      writes.push({ method: request.method(), path, body: request.postDataJSON?.() ?? null });
      // Server contract: oversized setup imports get 413 with this message.
      if (path === '/api/bots/import') return route.fulfill({ status: 413, json: { error: 'This setup file is too large (max 2 MB).' } });
      if (path === '/api/rooms') {
        if (roomError) { roomError = false; return route.fulfill({ status: 400, json: { error: 'Activate Ledger before adding it to a group.' } }); }
        return route.fulfill({ json: { id: 'room-new' } });
      }
      return route.fulfill({ json: { ok: true } });
    }
    let body = {};
    if (path === '/api/auth/me') body = { user: { id: 'owner', name: 'Owner', email: 'owner@example.test' }, devLogin: false, googleLogin: false };
    else if (path === '/api/bots') body = { bots, live: [] };
    else if (path.endsWith('/rows')) body = { generation: 1, rows: path.includes('/quinn/') ? quinnRows() : [message(path.split('/')[3], 1, 'assistant', 'Ready when you are.')] };
    else if (path.endsWith('/routines')) body = { routines: [] };
    else if (path.endsWith('/tasks')) body = { tasks: [] };
    else if (path.endsWith('/coworker-setups')) body = { setups: [] };
    else if (path === '/api/team/exchanges') body = { exchanges: [], nextBefore: null };
    else if (path === '/api/needs-you') body = { items: [] };
    else if (path === '/api/conversation-search') body = { results: url.searchParams.get('q')?.includes('checklist') ? [{ botId: 'quinn', botName: 'Quinn', seq: 3, generation: 1, role: 'user', text: 'The launch checklist lives in the shared folder.', createdAt: now }] : [] };
    else if (path === '/api/computer') body = { computer: { provider: 'local', status: 'absent', screens: [], error: null } };
    else if (path === '/api/models') body = { provider: 'openrouter', billing: 'api', models: [model], defaultModel: model.id, favourites: [model.id], canFast: false };
    else if (path === '/api/settings') body = { settings: {}, computer: { provider: 'orgo' } };
    else if (path === '/api/voice/options') body = { voices: [], languages: [], speeds: [], configured: false };
    else if (path === '/api/apps') body = { apps: [], connected: [], categories: [], total: 0 };
    return route.fulfill({ json: body });
  });
  await page.goto(origin);
  const composer = page.locator('.composer__input');
  await composer.waitFor();
  const chatName = () => page.locator('.chat__pill-name').innerText();
  const sidebar = page.locator('.sidebar');

  // R2F-024: visible "Your Bots" section label and a "Primary" tag on the pinned row.
  await sidebar.getByText('Your Bots', { exact: true }).waitFor();
  assert.equal(await sidebar.locator('.pinned__tile .pinned__tag').innerText(), 'Primary');
  console.log('PASS R2F-024 sidebar section label and primary tag');

  // R2F-006: a draft card without an approval offers Copy draft, never Send.
  const draft = page.locator('.draft-card');
  await draft.getByText('Hello from the team', { exact: true }).waitFor();
  assert.equal(await draft.getByRole('button', { name: 'Send' }).count(), 0, 'nothing can be sent from a shown draft');
  const writesBeforeCopy = writes.length;
  await draft.getByRole('button', { name: 'Copy draft', exact: true }).click();
  await draft.getByRole('button', { name: 'Copied', exact: true }).waitFor();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^Subject: Hello from the team\n\nHi team,/);
  await draft.getByText('Draft only. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(writes.length, writesBeforeCopy, 'copying a draft makes no request');
  await draft.getByRole('button', { name: 'Discard', exact: true }).click();
  await wait(() => writes.some(w => w.path === '/api/bots/quinn/cards/25/dismiss'), 'draft dismiss request');
  draftStatus = 'discarded';
  await page.evaluate(rows => window.__emit({ type: 'rows', botId: 'quinn', generation: 1, rows }), [quinnRows().find(r => r.seq === 25)]);
  await draft.getByText('Discarded. Nothing was sent.', { exact: true }).waitFor();
  assert.equal(writes.filter(w => w.path.startsWith('/api/approvals')).length, 0, 'a shown draft never calls approve');
  console.log('PASS R2F-006 draft card: Copy draft, Discard dismisses the card, no Send, no approval');

  // R2F-031: after an approval card resolves, typing goes back to the composer.
  const approval = page.locator('.approval-card');
  await approval.getByRole('button', { name: 'Allow', exact: true }).click();
  await wait(() => writes.some(w => w.path === '/api/approvals/apr_fixtureApproval1'), 'approval request');
  approvalStatus = 'allowed';
  await page.evaluate(rows => window.__emit({ type: 'rows', botId: 'quinn', generation: 1, rows }), [quinnRows().at(-1)]);
  await approval.getByText('Allowed once', { exact: true }).waitFor();
  await wait(() => composer.evaluate(el => document.activeElement === el), 'composer focus after the card resolves');
  await page.keyboard.type('thanks');
  assert.equal(await composer.inputValue(), 'thanks');
  await composer.fill('');
  console.log('PASS R2F-031 composer focus returns after an approval');

  // R2F-030: Escape closes the model picker in one press, also with the effort segments focused.
  const pill = page.getByRole('button', { name: /^Model: Test Model/ });
  await pill.click();
  const picker = page.getByRole('dialog', { name: 'Model and effort' });
  await picker.waitFor();
  await picker.getByRole('radiogroup', { name: 'Effort' }).waitFor();
  await picker.getByRole('radio', { name: 'Medium', exact: true }).focus();
  await page.keyboard.press('Escape');
  await picker.waitFor({ state: 'detached' });
  await pill.click(); await picker.waitFor();
  await picker.getByRole('radio', { name: 'Medium', exact: true }).focus();
  await page.keyboard.press('Escape');
  await picker.waitFor({ state: 'detached' });
  assert.equal(await pill.evaluate(el => document.activeElement === el), true, 'focus returns to the model pill');
  console.log('PASS R2F-030 Escape closes the model picker in one press');

  // R2F-013: a search hit scrolls to and visibly highlights the message.
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: 'Search', exact: true }).fill('checklist');
  await page.getByRole('listbox', { name: 'Search results' }).getByText('The launch checklist lives in the shared folder.').first().click();
  const hit = page.locator('.transcript [data-row-seq="3"]');
  await hit.and(page.locator('.is-search-hit')).waitFor();
  const background = await hit.evaluate(el => getComputedStyle(el).backgroundColor);
  assert.notEqual(background, 'rgba(0, 0, 0, 0)', 'the hit row has a visible highlight');
  assert.equal(await hit.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), true, 'the hit row is in view');
  await page.screenshot({ path: new URL('search-hit.png', evidence).pathname });
  await hit.and(page.locator('.is-search-hit')).waitFor({ state: 'detached' }).catch(() => {});
  await wait(() => hit.evaluate(el => !el.classList.contains('is-search-hit')), 'highlight ends');
  console.log('PASS R2F-013 search hit highlight');

  // R2F-033: the first click after closing the search palette or a modal reaches the page.
  const openChat = name => sidebar.locator('.bot-row').filter({ hasText: name }).first();
  await page.keyboard.press('Control+k');
  await page.getByRole('textbox', { name: 'Search', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await openChat('Nia').click();
  await wait(async () => (await chatName()) === 'Nia', 'Nia opened on the first click after Escape');
  await page.getByRole('button', { name: 'Account & settings', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Connect apps', exact: true }).click();
  await page.getByRole('dialog', { name: 'Connect Apps' }).waitFor();
  await page.getByRole('dialog', { name: 'Connect Apps' }).getByRole('button', { name: 'Close', exact: true }).click();
  await openChat('Wren').click();
  await wait(async () => (await chatName()) === 'Wren', 'Wren opened on the first click after closing a modal');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search', exact: true }).waitFor();
  // A click on the backdrop closes the palette and lands on the row underneath.
  const row = await openChat('Nia').boundingBox();
  await page.mouse.click(row.x + row.width / 2, row.y + row.height / 2);
  await wait(async () => (await chatName()) === 'Nia', 'Nia opened by the click that closed the palette');
  await page.locator('.pinned__tile').click();
  await wait(async () => (await chatName()) === 'Quinn', 'back to Quinn');
  console.log('PASS R2F-033 first click after closing the palette or a modal');

  // R2F-025: the Bots page says "Create a Bot".
  await sidebar.getByRole('button', { name: 'All Bots', exact: true }).click();
  await page.getByRole('heading', { name: 'Your Bots', exact: true }).waitFor();
  await page.locator('.bots-view').getByRole('button', { name: 'Create a Bot', exact: true }).waitFor();
  assert.doesNotMatch(await page.locator('.bots-view').innerText(), /Create bot\b/);
  console.log('PASS R2F-025 Create a Bot copy');

  // R2F-008: Bots still in setup cannot be picked for a group; a server refusal shows inline.
  await page.locator('.bots-view').getByRole('button', { name: 'Create a Bot', exact: true }).click();
  await page.getByRole('main', { name: 'Create a Bot' }).getByRole('button', { name: 'Start a room instead' }).click();
  const group = page.getByRole('main', { name: 'New room' });
  const locked = group.locator('.group-create__member').filter({ hasText: 'Ledger' });
  await locked.getByText('Activate first', { exact: true }).waitFor();
  assert.equal(await locked.locator('input[type="checkbox"]').isDisabled(), true, 'setup Bot is disabled');
  await group.getByLabel('Room name').fill('Launch crew');
  await group.getByRole('checkbox', { name: 'Nia', exact: true }).check();
  await group.getByRole('checkbox', { name: 'Wren', exact: true }).check();
  await group.getByRole('button', { name: 'Create room' }).click();
  await group.getByRole('alert').getByText('Activate Ledger before adding it to a group.').waitFor();
  const roomWrite = writes.find(w => w.path === '/api/rooms');
  assert.deepEqual(roomWrite.body.botIds.sort(), ['nia', 'wren'], 'only active Bots are sent');
  await group.getByRole('button', { name: 'Cancel', exact: true }).click();
  console.log('PASS R2F-008 group picker disables setup Bots and shows the server message inline');

  // R2F-032: after choosing a setup file the native input is replaced by the file name and "Choose another file".
  await page.getByRole('button', { name: 'New Bot', exact: true }).click();
  const create = page.getByRole('main', { name: 'Create a Bot' });
  await page.locator('.setup-create .pb-disclosure > summary').click();
  await create.getByRole('button', { name: 'Import saved setup' }).click();
  const upload = page.getByRole('main', { name: 'Import a saved setup' });
  const manifest = { format: 'swarm.bot-setup', version: 1, bot: { name: 'Imported Helper', label: '', instructions: 'Be brief.' }, brief: { purpose: 'Help' }, source: { messages: [] } };
  await upload.getByLabel('Setup file').setInputFiles({ name: 'bot-setup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(manifest)) });
  const chosen = upload.getByText('Selected: bot-setup.json');
  const choseOk = await chosen.waitFor({ timeout: 3000 }).then(() => true, () => false);
  if (choseOk) {
    await upload.getByRole('button', { name: 'Choose another file', exact: true }).waitFor();
    const fileBox = await upload.locator('input[type="file"]').boundingBox();
    assert.ok(!fileBox || (fileBox.width <= 1 && fileBox.height <= 1), `the native "No file chosen" input is hidden ${JSON.stringify(fileBox)}`);
    await upload.getByLabel('Setup file').setInputFiles({ name: 'another-setup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...manifest, bot: { ...manifest.bot, name: 'Second Helper' } })) });
    await upload.getByText('Selected: another-setup.json').waitFor();
    assert.equal(await upload.getByRole('textbox', { name: 'Bot name' }).inputValue(), 'Second Helper');
    await upload.getByRole('button', { name: 'Import setup', exact: true }).click();
    await upload.getByRole('alert').getByText('This setup file is too large (max 2 MB).', { exact: true }).waitFor();
    console.log('PASS R2F-032 chosen setup file replaces the native input');
  } else {
    // The fixture manifest may not satisfy the parser; the visible input must then stay available.
    assert.equal(await upload.locator('input[type="file"]').isVisible(), true);
    throw new Error(`setup manifest fixture was rejected: ${await upload.getByRole('alert').innerText().catch(() => 'no message')}`);
  }
  await upload.getByRole('button', { name: 'Cancel', exact: true }).click();

  // R2F-034: the Tasks island stays visible while the Bot list scrolls in a small window.
  await page.setViewportSize({ width: 1024, height: 600 });
  const scroller = sidebar.locator('.sidebar__scroll');
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(100);
  const island = sidebar.getByRole('button', { name: 'Tasks', exact: true });
  const [islandBox, scrollBox] = [await island.boundingBox(), await scroller.boundingBox()];
  assert.ok(await scroller.evaluate(el => el.scrollTop > 0), 'the Bot list scrolled');
  assert.ok(islandBox && islandBox.y >= 0 && islandBox.y + islandBox.height <= scrollBox.y + 1, `Tasks island stays in view ${JSON.stringify({ islandBox, scrollBox })}`);
  const topRow = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent?.trim() === 'Tasks', { x: islandBox.x + 20, y: islandBox.y + islandBox.height / 2 });
  assert.equal(topRow, true, 'the island is on top of scrolled rows');
  await page.screenshot({ path: new URL('tasks-island-1024x600.png', evidence).pathname });
  await island.click();
  await page.locator('.tasks-view').waitFor();
  console.log('PASS R2F-034 sticky Tasks island at 1024x600');

  // R2F-011: the viewer header links to Computer settings and fits a phone.
  await page.locator('.pinned__tile').click();
  await composer.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.app.is-mobile').waitFor();
  if (await page.locator('.app.pane-list').count()) await page.locator('.pinned__tile').click();
  await page.locator('.chat__pill').click();
  await page.getByRole('menuitem', { name: 'Open computer' }).click();
  const viewer = page.getByRole('dialog', { name: "Quinn's computer" });
  await viewer.getByRole('button', { name: 'Connect your PC', exact: true }).waitFor();
  const settingsButton = viewer.getByRole('button', { name: 'Computer settings', exact: true });
  await settingsButton.waitFor();
  await page.screenshot({ path: new URL('viewer-390.png', evidence).pathname });
  const header = await viewer.locator('.viewer__top').evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth, kids: [...el.querySelectorAll('*')].map(c => [c.className, Math.round(c.getBoundingClientRect().left), Math.round(c.getBoundingClientRect().right)]), right: Math.max(...[...el.querySelectorAll('button')].map(b => b.getBoundingClientRect().right)) }));
  assert.ok(header.sw <= header.cw + 1 && header.right <= 391, `viewer header fits 390px ${JSON.stringify(header)}`);
  await settingsButton.click();
  await viewer.waitFor({ state: 'detached' });
  await page.waitForFunction(() => location.hash === '#settings/computer');
  console.log('PASS R2F-011 viewer Computer settings button on a phone');

  assert.deepEqual(errors, []);
} catch (error) {
  if (logs) console.error(logs);
  throw error;
} finally { await browser?.close(); server?.kill(); }

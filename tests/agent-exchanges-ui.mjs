// Built UI with local HTTP fixtures; no provider calls or live accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const evidence = new URL('../.context/agent-exchanges-evidence/', import.meta.url);
await fs.mkdir(evidence, { recursive: true });
const port = await new Promise(resolve => { const server = http.createServer().listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const base = `http://127.0.0.1:${port}`;
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', String(port)], { cwd: new URL('../web', import.meta.url), stdio: 'pipe' });
let output = '', browser;
vite.stdout.on('data', d => { output += d; }); vite.stderr.on('data', d => { output += d; });
const until = async fn => { for (let n = 0; n < 150; n++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Timed out'); };
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const at = Date.now() - 3600_000;
const participants = [
  { id: 'quinn', name: 'Quinn', avatarShape: 'teardrop', avatarColor: 'brown' },
  { id: 'research', name: 'Research', avatarShape: 'clover', avatarColor: 'green' },
  { id: 'writer', name: 'Writer', avatarShape: 'flower', avatarColor: 'orange' },
];
const bots = participants.map((bot, n) => ({ ...bot, label: '', description: '', instructions: '', mode: 'personal', kind: 'agent', isPrimary: n === 0, pinned: false, effort: 'medium', model: null, generation: 1, unread: 0, lastPreview: '', lastActivityAt: at, createdAt: at }));
const initial = { id: 'thread-a', firstSeq: 1, lastSeq: 5, createdAt: at, messageCount: 5, version: 5, participants };
const messages = [
  ['quinn', 'research', 'Check the current sources.'],
  ['research', 'writer', 'Draft a summary of the sources.'],
  ['writer', 'research', 'The draft is ready.'],
  ['research', 'quinn', 'Here is the sourced summary.'],
  ['quinn', 'writer', 'Keep the final version concise.'],
].map(([fromBotId, toBotId, text], n) => ({ id: `message-${n}`, seq: n + 1, fromBotId, toBotId, text, status: n === 4 ? 'deferred' : 'completed', kind: 'request', createdAt: at + n * 1000 }));
try {
  await until(() => fetch(base).then(r => r.ok, () => false));
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [], reads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.addInitScript(() => {
    localStorage.setItem('swarm.selectedBot', 'quinn'); localStorage.setItem('swarm.detailsOpen', '0');
    window.EventSource = class {
      static CLOSED = 2;
      constructor() { window.__events = this; setTimeout(() => this.onopen?.(), 0); }
      close() {}
    };
  });
  let summary = structuredClone(initial), generation = 1, listError = false, detailError = false, listGate, detailGate;
  let older = false;
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    reads.push({ path, search: url.search, method: req.method() });
    let data = {};
    if (path === '/api/auth/me') data = { user: { id: 'owner', name: 'Owner', email: 'owner@example.test' }, devLogin: true };
    else if (path === '/api/bots') data = { bots, live: [] };
    else if (path.endsWith('/rows')) data = { generation, rows: path.includes('/quinn/') ? [
      { botId: 'quinn', generation, seq: 1, updatedSeq: 1, kind: 'message', audience: 'internal', createdAt: at - 1000, body: { type: 'message', role: 'assistant', audience: 'internal', text: 'Hidden internal reasoning must stay hidden' } },
    ] : [] };
    else if (path === '/api/team/exchanges') {
      const captured = structuredClone(summary);
      if (listGate) { const held = listGate; listGate = undefined; await held.promise; }
      if (listError) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
      data = url.searchParams.get('botId') !== 'quinn' || Number(url.searchParams.get('generation')) !== 1 ? { exchanges: [], nextBefore: null }
        : url.searchParams.has('before') ? { exchanges: [{ ...initial, id: 'older', firstSeq: 0, createdAt: at - 86400_000, messageCount: 1, participants: participants.slice(0, 2) }], nextBefore: null }
          : { exchanges: [captured], nextBefore: older ? 1 : null };
    } else if (path.startsWith('/api/team/exchanges/')) {
      if (detailGate) { const held = detailGate; detailGate = undefined; await held.promise; }
      if (detailError) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
      const after = Number(url.searchParams.get('after'));
      const selected = messages.filter(m => m.seq > after && m.seq <= Number(url.searchParams.get('through')));
      const batch = selected.slice(0, 2);
      data = { messages: batch, nextAfter: selected.length > 2 ? batch.at(-1).seq : null };
    } else if (path.endsWith('/coworker-setups')) data = { setups: [] };
    else if (path.endsWith('/routines')) data = { routines: [] };
    else if (path.endsWith('/tasks')) data = { tasks: [] };
    else if (path === '/api/settings') data = { settings: {}, computer: { provider: 'local' } };
    else if (path === '/api/computer') data = { computer: { status: 'absent', screens: [] } };
    else if (path === '/api/models') data = { provider: 'direct', billing: 'api', defaultModel: 'test', canFast: false, favourites: ['test'], models: [{ id: 'test', name: 'Test model', short: 'Test', billing: 'api', author: 'test', efforts: null }] };
    await route.fulfill({ json: data });
  });
  const emit = event => page.evaluate(event => window.__events.onmessage({ data: JSON.stringify(event) }), event);
  await page.goto(base);
  const toggle = page.getByRole('button', { name: '5 messages with 3 Bots', exact: true });
  await toggle.waitFor();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await toggle.locator('.bot-avatar').count(), 3);
  assert.equal(reads.filter(r => r.path === '/api/team/exchanges/thread-a').length, 0, 'text fetched only when expanded');
  assert.equal(await page.getByText('Hidden internal reasoning must stay hidden').count(), 0);
  await page.screenshot({ path: new URL('desktop-collapsed.png', evidence).pathname });
  await page.locator('.agent-exchange').screenshot({ path: new URL('summary-row.png', evidence).pathname });
  await toggle.focus(); await page.keyboard.press('Enter');
  const region = page.getByRole('region', { name: 'Agent conversation' });
  await region.getByText('Check the current sources.', { exact: true }).waitFor();
  assert.equal(await region.locator('li').count(), 2);
  await region.getByRole('button', { name: 'Show more messages' }).click();
  await region.getByText('Here is the sourced summary.', { exact: true }).waitFor();
  await region.getByRole('button', { name: 'Show more messages' }).click();
  await region.getByText('Keep the final version concise.', { exact: true }).waitFor();
  assert.equal(await region.locator('li').count(), 5);
  await region.getByText('Waiting to send', { exact: true }).waitFor();
  await region.getByText('Research → Writer', { exact: true }).waitFor();
  await page.screenshot({ path: new URL('desktop-expanded.png', evidence).pathname });
  await toggle.focus(); await page.keyboard.press('Space');
  assert.equal(await region.count(), 0);
  console.log('PASS exact collapsed label, 3 overlapping avatars, lazy expansion, keyboard, sender/recipient, timestamps and paginated messages');

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.app.is-mobile').waitFor();
    if (await page.locator('.app.pane-list').count()) await page.getByTitle('Quinn', { exact: true }).first().click();
    await toggle.waitFor({ state: 'visible' });
    assert.ok(await toggle.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), `summary fits ${width}px`);
    await page.screenshot({ path: new URL(`mobile-${width}-collapsed.png`, evidence).pathname });
    await toggle.click(); await region.getByText('Check the current sources.', { exact: true }).waitFor();
    assert.ok(await region.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `expanded messages fit ${width}px`);
    await page.screenshot({ path: new URL(`mobile-${width}-expanded.png`, evidence).pathname });
    await toggle.click();
  }
  console.log('PASS 390px and 320px collapsed/expanded layouts');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('.app:not(.is-mobile)').waitFor();
  summary = { ...summary, messageCount: 6, lastSeq: 6, version: 6 };
  messages.push({ ...messages[0], id: 'message-6', seq: 6, text: 'Newest team reply' });
  await emit({ type: 'native', cursor: 10 });
  const updated = page.getByRole('button', { name: '6 messages with 3 Bots', exact: true });
  await updated.waitFor();
  listError = true; await emit({ type: 'native', cursor: 11 });
  await page.getByText('Couldn’t refresh agent conversations.').waitFor();
  assert.ok(await updated.isVisible(), 'failed refresh retains the known summary');
  listError = false; await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByText('Couldn’t refresh agent conversations.').waitFor({ state: 'hidden' });
  detailError = true; await updated.click();
  await region.getByText('Couldn’t refresh this conversation.').waitFor();
  detailError = false; await region.getByRole('button', { name: 'Retry' }).click();
  await region.getByText('Newest team reply', { exact: true }).waitFor();
  await updated.click();
  console.log('PASS live updates, failed list/detail refreshes and retry recovery');

  older = true; await emit({ type: 'native', cursor: 12 });
  await page.getByRole('button', { name: 'Earlier agent conversations' }).click();
  await page.getByRole('button', { name: '1 message with 2 Bots', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Earlier agent conversations' }).count(), 0);
  const hold = gate(); detailGate = hold;
  await updated.click(); await until(() => detailGate === undefined);
  await page.locator('.bot-row').filter({ hasText: 'Research' }).click();
  hold.resolve();
  await until(async () => (await page.locator('.agent-exchange').count()) === 0);
  assert.equal(await page.getByText('Newest team reply').count(), 0, 'late detail does not appear in another agent chat');
  await page.getByTitle('Quinn', { exact: true }).first().click();
  await updated.waitFor();
  const heldList = gate(); listGate = heldList;
  await emit({ type: 'native', cursor: 13 }); await until(() => listGate === undefined);
  generation = 2; await emit({ type: 'cleared', botId: 'quinn', generation });
  heldList.resolve();
  await until(async () => (await page.locator('.agent-exchange').count()) === 0);
  assert.equal(await page.getByText('Newest team reply').count(), 0);
  console.log('PASS older conversations, singular wording, agent switch and chat clear during pending requests');
  assert.deepEqual(errors, []);
  assert.equal(reads.some(r => r.method !== 'GET' && !r.path.endsWith('/read')), false, 'inspection never dispatches work');
} catch (error) {
  console.error(output); throw error;
} finally {
  await browser?.close(); vite.kill('SIGTERM');
}

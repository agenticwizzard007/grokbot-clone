import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, checkAccessibility, checkLayout } from './ui-d-fixture.mjs';

const f = await fixture(), results = [];
async function check(name, run, options = {}) {
  for (const width of [390, 1280]) {
    const page = await f.page({ width, view: name.startsWith('viewer') ? 'viewer' : name.startsWith('detail') ? 'detail' : name.startsWith('list') ? 'list' : name.startsWith('settings') ? 'settings' : 'card', ...options });
    try { await run(page); assert.deepEqual(page.fixtureErrors, []); results.push({ name, width }); console.log(`PASS ${name} ${width}`); }
    finally { await page.close(); }
  }
}
const open = page => page.getByRole('button', { name: 'Send to agent', exact: true }).click();
const pick = page => page.getByRole('button', { name: /^Checker/ }).click();
const send = page => page.getByRole('button', { name: 'Send', exact: true });
const waitReceipt = page => page.getByText('Sent to Checker', { exact: true }).waitFor();
try {
  await check('three clicks, defaults, filtering and double send', async page => {
    await open(page);
    assert.deepEqual(await page.locator('.ho-target .layout-row__title').allTextContents(), ['Checker', 'Editor']);
    assert.equal(await page.getByLabel('Send result back to me').isChecked(), true);
    assert.equal(await page.getByLabel('Keep improving', { exact: true }).count(), 0, 'HO-E absent: feature check hides the fields');
    await pick(page); assert.equal(await page.getByLabel('Ask', { exact: true }).inputValue(), 'Review Release note draft against the brief.');
    await send(page).evaluate(button => { button.click(); button.click(); });
    await waitReceipt(page);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    const sends = await page.evaluate(() => window.fixture.calls.filter(call => call.method === 'POST'));
    assert.equal(sends.length, 1); assert.equal(sends[0].body.returnResult, true);
    assert.equal(sends[0].body.includeSensitive, undefined);
    assert.deepEqual(sends[0].body.source, { outputId: 'out_fixture' });
  });
  await check('server error stays inline and same request retries', async page => {
    await open(page); await pick(page);
    await page.evaluate(() => { window.fixture.failOnce = true; });
    await send(page).click(); await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /Use a loop instead/);
    assert.equal(await page.locator('dialog[open]').count(), 1);
    await send(page).click(); await waitReceipt(page);
    const calls = await page.evaluate(() => window.fixture.calls.filter(call => call.method === 'POST'));
    assert.equal(calls.length, 2); assert.equal(calls[0].body.idempotencyKey, calls[1].body.idempotencyKey);
  });
  await check('lost response after commit cannot duplicate a retry', async page => {
    await open(page); await pick(page); await page.evaluate(() => { window.fixture.failAfterCommit = true; });
    await send(page).click(); await page.getByRole('alert').waitFor(); await send(page).click(); await waitReceipt(page);
    assert.equal(await page.evaluate(() => window.fixture.sent.length), 1);
  });
  await check('changed request and deliberate second send get fresh keys', async page => {
    await open(page); await pick(page); await page.evaluate(() => { window.fixture.failOnce = true; });
    await send(page).click(); await page.getByRole('alert').waitFor(); await page.getByLabel('Ask', { exact: true }).fill('Check the final paragraph.');
    await send(page).click(); await waitReceipt(page); await open(page); await pick(page); await send(page).click();
    await page.waitForFunction(() => window.fixture.sent.length === 2);
    const keys = await page.evaluate(() => window.fixture.calls.filter(call => call.method === 'POST').map(call => call.body.idempotencyKey));
    assert.equal(new Set(keys).size, 3);
  });
  await check('keyboard trap, every control, Escape and opener focus', async page => {
    const opener = page.getByRole('button', { name: 'Send to agent', exact: true });
    await opener.focus(); await page.keyboard.press('Enter'); await pick(page);
    const dialog = page.getByRole('dialog');
    const reachable = await dialog.evaluate(element => [...element.querySelectorAll('button:not(:disabled),textarea,input:not(:disabled)')].filter(node => node.checkVisibility()).length);
    await page.getByRole('button', { name: 'Close', exact: true }).focus();
    const seen = new Set();
    for (let index = 0; index < reachable + 2; index++) {
      assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
      seen.add(await page.evaluate(() => { const element = document.activeElement; return element.id || element.getAttribute('aria-label') || element.textContent || element.type; }));
      await page.keyboard.press('Tab');
    }
    assert.equal(seen.size, reachable);
    await page.keyboard.press('Shift+Tab'); assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
    await page.keyboard.press('Escape'); assert.equal(await dialog.count(), 0);
    assert.equal(await opener.evaluate(element => document.activeElement === element), true);
  });
  await check('standing suggestion saves only on request', async page => {
    await open(page); await pick(page);
    assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call.method === 'PUT').length), 0);
    await page.getByRole('button', { name: 'Always offer this', exact: true }).click();
    await page.getByRole('button', { name: 'Always offered', exact: true }).waitFor();
    const links = await page.evaluate(() => window.fixture.links);
    assert.equal(links.length, 1); assert.equal(links[0].mode, 'suggest'); assert.equal(links[0].autoApproveLoops, false);
  });
  await check('search and long agent labels remain readable', async page => {
    await page.evaluate(() => {
      for (let index = 0; index < 7; index++) window.fixture.agents.push({ ...window.fixture.agents[1], id: 'bot_extra_' + index, name: 'Reviewer for detailed product release notes ' + index });
    });
    await open(page); await page.getByLabel('Search agents').fill('notes 6');
    assert.equal(await page.locator('.ho-target').count(), 1);
    await checkLayout(page); await checkAccessibility(page);
    await page.getByLabel('Search agents').fill('absent target'); await page.getByText('No available agents', { exact: true }).waitFor();
  });
  await check('empty instruction and max length guard', async page => {
    await open(page); await pick(page); await page.getByLabel('Ask', { exact: true }).fill(' ');
    assert.equal(await send(page).isDisabled(), true);
    await page.getByLabel('Ask', { exact: true }).fill('a'.repeat(999));
    assert.equal(await page.getByLabel('Ask', { exact: true }).getAttribute('maxlength'), '1000');
    assert.match(await page.locator('dialog').innerText(), /999 \/ 1000/);
  });
  await check('viewer loads parts only on demand and pages safely', async page => {
    assert.equal(await page.evaluate(() => window.fixture.calls.filter(call => call.path.includes('/parts/')).length), 0);
    await page.getByRole('button', { name: 'Open Body', exact: true }).click(); await page.getByText(/First body page/).waitFor();
    await page.getByRole('button', { name: 'Read more', exact: true }).click(); await page.getByText(/Last body page/).waitFor();
    assert.equal(await page.evaluate(() => window.injected), undefined);
    const calls = await page.evaluate(() => window.fixture.calls.filter(call => call.path.includes('/parts/')));
    assert.equal(calls.length, 2); assert.match(calls[1].query, /offset=8000/);
    assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
    assert.equal(await page.getByRole('link', { name: 'Open Release brief', exact: true }).getAttribute('rel'), 'noopener noreferrer');
    await checkAccessibility(page);
  });
  await check('detail receives live status and Stop settles in place', async page => {
    await page.evaluate(() => { window.fixture.status = 'running'; window.dispatchEvent(new CustomEvent('swarm:event', { detail: { type: 'handoff', id: 'ho_fixture' } })); });
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Stopped' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
  });
  await check('detail human gate actions and support copy excludes bodies', async page => {
    await page.evaluate(() => { window.fixture.status = 'pending_approval'; window.refreshFixture(); });
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Queued' }).waitFor();
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.copied = text; } }, configurable: true }); });
    await page.getByRole('button', { name: 'Copy details', exact: true }).click();
    const copied = await page.evaluate(() => window.copied);
    assert.match(copied, /ho_fixture/); assert.doesNotMatch(copied, /Review this|summary|First body/);
    await page.evaluate(() => { window.fixture.status = 'pending_approval'; window.refreshFixture(); });
    await page.getByRole('button', { name: 'Decline', exact: true }).click(); await page.getByRole('status').filter({ hasText: 'Declined' }).waitFor();
  });
  await check('list filters, 20 item pages and cursor reset', async page => {
    assert.equal(await page.locator('.ho-receipt').count(), 20);
    await page.getByRole('button', { name: 'Next', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.ho-receipt').length === 5);
    await page.getByRole('button', { name: 'Received', exact: true }).click(); await page.waitForFunction(() => document.querySelectorAll('.ho-receipt').length === 20);
    assert.equal(await page.getByText('Handed off from Checker', { exact: true }).count(), 20);
    const last = await page.evaluate(() => window.fixture.calls.filter(call => call.path === '/api/handoffs').at(-1));
    assert.match(last.query, /direction=received/); assert.doesNotMatch(last.query, /after=/);
  });
  await check('settings policy, per-pair approval and refused automatic cycle', async page => {
    await page.getByLabel('Agents can send to').selectOption('links_only');
    await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.settings.agentHandoffs), 'links_only');
    assert.equal(await page.getByLabel('Auto approve loops started by agents with Checker').isChecked(), false);
    await page.getByLabel('Auto approve loops started by agents with Checker').click();
    await page.waitForFunction(() => window.fixture.links[0].autoApproveLoops);
    await page.evaluate(() => { window.fixture.failLinks = true; });
    await page.getByLabel('Mode for Checker').selectOption('auto'); await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /automatic cycle/);
    assert.equal(await page.getByLabel('Mode for Checker').inputValue(), 'suggest');
  });
  await check('Open and browser Back preserve route history', async page => {
    await page.getByRole('link', { name: 'Open', exact: true }).click();
    await page.getByRole('heading', { name: 'Provenance', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Back', exact: true }).click(); await page.getByRole('heading', { name: 'Run output', exact: true }).waitFor();
  });
  for (const source of ['task', 'message']) await check(`${source} source is sent by reference`, async page => {
    await open(page); await pick(page); await send(page).click(); await waitReceipt(page);
    const body = await page.evaluate(() => window.fixture.sent[0]);
    assert.deepEqual(body.source, source === 'task' ? { taskId: 'task_fixture' } : { messageRef: { botId: 'bot_maker', generation: 1, seq: 5 } });
    assert.equal('output' in body, false);
  }, { source });
  await check('room sends only to eligible members', async page => {
    await open(page); await page.getByRole('button', { name: /^Editor/ }).waitFor();
    assert.deepEqual(await page.locator('.ho-target .layout-row__title').allTextContents(), ['Editor']);
    await page.getByRole('button', { name: /^Editor/ }).click(); await send(page).click();
    await page.waitForFunction(() => window.fixture.sent.length === 1);
    assert.equal(await page.evaluate(() => window.fixture.sent[0].roomId), 'bot_room');
  }, { room: true });
  await check('closed request cannot close a newly opened sheet', async page => {
    await page.evaluate(() => { window.fixture.delay = 1000; });
    await open(page); await pick(page); await send(page).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click(); await open(page);
    await page.waitForFunction(() => window.fixture.sent.length === 1);
    assert.equal(await page.getByRole('dialog').count(), 1);
  });
  await check('viewer renders hostile titles as text and blocks unsafe URLs', async page => {
    await page.evaluate(() => {
      window.fixture.output.title = '<img src=x onerror=window.injected=true>';
      window.fixture.output.parts.find(part => part.kind === 'link').url = 'javascript:window.injected=true';
      window.refreshFixture();
    });
    await page.getByRole('heading', { name: '<img src=x onerror=window.injected=true>', exact: true }).waitFor();
    assert.equal(await page.locator('h1 img').count(), 0);
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    await page.getByText('Link unavailable', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.injected), undefined);
  });
  await check('settings global controls select a link sender', async page => {
    await page.getByLabel('Links from').selectOption('bot_checker');
    await page.waitForFunction(() => window.fixture.calls.some(call => call.path === '/api/handoff-links' && call.query.includes('bot_checker')));
    await checkLayout(page); await checkAccessibility(page);
  }, { global: true });
  for (const file of fs.readdirSync('web/src/handoffs').filter(file => /\.(tsx?|css)$/.test(file))) {
    assert.doesNotMatch(fs.readFileSync(path.join('web/src/handoffs', file), 'utf8'), /[\u2013\u2014]/, `${file}: no prohibited dash characters`);
  }
  results.push({ name: 'source text policy', files: 9 }); console.log('PASS source text policy: 9 files');
} finally {
  await f.close(); fs.writeFileSync('.context/ho-d/behavior.json', JSON.stringify(results, null, 2));
}
console.log(`PASS ${results.length}/${results.length} behavior checks`);

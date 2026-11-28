// Local fixture data only. Capture with LW_PHASE=before on unchanged main.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { layoutServer } from './layout-fixture.mjs';

const phase = process.env.LW_PHASE || 'after';
const shots = process.env.LW_SHOTS || '/workspace/swarm-qa/livewalk-fix/shots';
let server, browser;
before(async () => {
  fs.mkdirSync(shots, { recursive: true });
  server = await layoutServer();
  browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await server?.close(); });

async function fixture(t, width, hash) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: 'light', reducedMotion: 'reduce' });
  t.after(() => context.close());
  await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
  await context.addInitScript(() => {
    if (!localStorage.getItem('swarm.theme')) localStorage.setItem('swarm.theme', 'light');
    localStorage.setItem('swarm.detailsOpen', '0');
    localStorage.setItem('swarm.sidebarCollapsed', '0');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.route('**/*', route => new URL(route.request().url()).origin === server.base ? route.fallback() : route.abort());
  await page.route('**/api/bots/*/coworker-setups', route => route.fulfill({ json: { setups: [] } }));
  await page.route('**/api/handoff-settings', route => route.fulfill({ json: { settings: { enabled: true } } }));
  await page.goto(`${server.base}/${hash || `#bot/${server.fixture.bot.id}`}`);
  await page.locator('.shell-header').waitFor();
  await page.waitForFunction(async () => (await import('/src/store.ts')).useStore.getState().botsLoaded);
  return page;
}
async function capture(page, defect, width) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(shots, `${defect}-${phase}-${width}.png`) });
}
async function outputChat(page, { text, declared = 'auto', parts = [] }) {
  const bot = server.fixture.bot;
  const output = { id: 'out_fixture', botId: bot.id, jobId: 'job_fixture', source: 'run', status: 'final', title: text.split('\n')[0], summary: text,
    parts: [{ id: 'p_body', kind: 'text', name: 'body', chars: text.length, sha256: 'fixture' }, ...parts], provenance: { declaredBy: declared } };
  await page.route('**/api/outputs/by-job/*', route => route.fulfill({ json: { output, terminal: true } }));
  await page.waitForFunction(async id => (await import('/src/store.ts')).useStore.getState().transcripts[id]?.loaded, bot.id);
  const response = page.waitForResponse('**/api/outputs/by-job/job_fixture');
  await page.evaluate(async ({ bot, text }) => {
    const { useStore } = await import('/src/store.ts');
    const previous = useStore.getState().transcripts[bot.id];
    const row = { botId: bot.id, generation: previous.generation, seq: 1, updatedSeq: 1, createdAt: Date.now(), kind: 'message', body: { type: 'message', role: 'assistant', text, jobId: 'job_fixture' } };
    useStore.setState({ transcripts: { ...useStore.getState().transcripts, [bot.id]: { ...previous, bySeq: { 1: row }, loaded: true } } });
  }, { bot, text });
  await response;
  await page.locator('.ho-message-handoff').waitFor();
  await page.waitForTimeout(300);
}

for (const width of [390, 1280]) {
  test(`D2 safe markdown and meaningful loop output title at ${width}`, async t => {
    const page = await fixture(t, width);
    await outputChat(page, { text: '**Loop awaiting approval**\n**Checker:** QA-Temp-2\n**Passes:** 0/3', declared: 'agent' });
    const card = page.locator('.ho-output-card'); await card.waitFor();
    await capture(page, 'D2', width);
    assert.equal(await card.locator('.layout-row__title').innerText(), 'Loop awaiting approval');
    assert.equal(await card.locator('.ho-summary strong').allTextContents().then(values => values.join(' ')), 'Checker: Passes:');
    assert.ok(!(await card.innerText()).includes('**'));
    const actions = await card.locator('[data-layout="button-group"] > *').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
    assert.equal(actions.length, 2); assert.ok(Math.abs(actions[0].width - actions[1].width) <= 1); assert.ok(actions.every(action => action.height >= 44));
  });
  test(`D3 plain replies have no duplicated output card at ${width}`, async t => {
    const page = await fixture(t, width);
    await outputChat(page, { text: 'Your changes are ready for review.' });
    await capture(page, 'D3', width);
    assert.equal(await page.locator('.ho-output-card').count(), 0);
    assert.equal(await page.getByText('Your changes are ready for review.', { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Message actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Send to agent', exact: true }).waitFor();
  });
  test(`D5 chat Back uses its parent after Flow and dashboard history at ${width}`, async t => {
    const page = await fixture(t, width);
    for (const origin of [{ kind: 'dashboards' }, { kind: 'details', bot: server.fixture.bot.id, tab: 'activity', flow: true }]) {
      await page.evaluate(async ({ origin, id }) => {
        const { navigation } = await import('/src/configStore.ts');
        navigation.navigate(origin);
        navigation.navigate({ kind: 'chat', bot: id });
      }, { origin, id: server.fixture.bot.id });
      await page.locator('.chat__header').waitFor();
      await capture(page, 'D5', width);
      assert.equal(await page.locator('.shell-back').getAttribute('aria-label'), 'Back to Bots');
      assert.equal(await page.getByRole('button', { name: /^Back/ }).count(), 1);
      await page.locator('.shell-back').click();
      await page.waitForFunction(() => location.hash === '#bots');
    }
    await page.goto(`${server.base}/#bot/${server.fixture.bot.id}`);
    await page.getByRole('button', { name: 'Back to Bots', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: 'Back to Bots', exact: true }).waitFor();
  });
  test(`D6 MCP empty state and normal Add target at ${width}`, async t => {
    const page = await fixture(t, width, '#settings/mcp');
    await page.getByRole('button', { name: 'Add MCP server', exact: true }).waitFor();
    await capture(page, 'D6', width);
    assert.equal(await page.getByRole('heading', { name: 'No MCP servers yet', exact: true }).count(), 1);
    const box = await page.getByRole('button', { name: 'Add MCP server', exact: true }).boundingBox();
    assert.ok(box.height >= 44); assert.ok(box.width < 240);
    const copy = page.locator('.mcp-empty p');
    assert.match(await copy.innerText(), /tools.*Bots/);
    assert.ok(await copy.evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 13));
    await page.getByRole('button', { name: 'Add MCP server', exact: true }).click();
    await page.locator('.mcp-editor').waitFor();
    assert.equal(await page.locator('.mcp-empty').count(), 0);
  });
  test(`D8 System theme label persists the existing system value at ${width}`, async t => {
    const page = await fixture(t, width, '#settings/general');
    const group = page.getByRole('radiogroup', { name: 'Theme', exact: true }); await group.waitFor();
    await capture(page, 'D8', width);
    assert.deepEqual(await group.getByRole('radio').allTextContents(), ['Light', 'Dark', 'System']);
    await group.getByRole('radio', { name: 'System', exact: true }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem('swarm.theme')), 'system');
    await page.reload();
    assert.equal(await page.getByRole('radio', { name: 'System', exact: true }).getAttribute('aria-checked'), 'true');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  });
}

for (const width of [390, 1280]) {
  test(`D2 output markdown keeps raw HTML and unsafe URLs inert at ${width}`, async t => {
    const page = await fixture(t, width);
    await outputChat(page, { text: '**Review**\n<img src=x onerror="window.rawHtmlRan=true">\n[Unsafe](javascript:alert(1))', declared: 'agent' });
    const card = page.locator('.ho-output-card'); await card.waitFor();
    assert.equal(await card.locator('img, script, [onerror], a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => window.rawHtmlRan), undefined);
  });
  test(`D3 real artifacts retain Output cards at ${width}`, async t => {
    for (const part of [
      { id: 'file', kind: 'file', artifactId: 'artifact', filename: 'report.md', mime: 'text/markdown', size: 10, sha256: 'fixture' },
      { id: 'data', kind: 'data', name: 'Results', bytes: 10, sha256: 'fixture' },
      { id: 'url', kind: 'link', url: 'https://example.test/report', title: 'Report', relation: 'result' },
    ]) {
      const page = await fixture(t, width);
      await outputChat(page, { text: 'Your report is ready.', parts: [part] });
      const card = page.locator('.ho-output-card'); await card.waitFor();
      assert.equal(await card.getByRole('button', { name: 'Send to agent', exact: true }).count(), 1);
      assert.equal(await card.getByRole('link', { name: 'Open', exact: true }).count(), 1);
    }
  });
  test(`D6 populated MCP list and load errors do not show the empty state at ${width}`, async t => {
    const page = await fixture(t, width, '#settings/mcp');
    await page.route('**/api/mcp/servers', route => route.fulfill({ json: { canManage: true, servers: [{ id: 'mcp_fixture', name: 'Research tools', transport: 'http', url: 'https://example.test/mcp', enabled: false, botIds: [], tools: [] }] } }));
    await page.reload();
    await page.getByRole('button', { name: 'Manage Research tools', exact: true }).waitFor();
    assert.equal(await page.locator('.mcp-server').count(), 1);
    assert.equal(await page.locator('.mcp-empty').count(), 0);
    await page.route('**/api/mcp/servers', route => route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } }));
    await page.reload();
    await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
    assert.equal(await page.locator('.mcp-empty').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Add MCP server', exact: true }).count(), 0);
  });
}

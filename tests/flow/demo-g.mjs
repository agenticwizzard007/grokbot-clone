import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { layoutServer } from '../layout-fixture.mjs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
const { fixtures } = await tsImport('./fixtures.mts', import.meta.url);
const { buildFlowModel } = await tsImport('../../server/src/flow/build.ts', import.meta.url);
const { assertAutoLinkAcyclic } = await tsImport('../../server/src/handoffs/chain.ts', import.meta.url);
const evidence = path.resolve('.context/flow/demo'); fs.mkdirSync(evidence, { recursive: true });
const app = await layoutServer(), clients = new Set();
const events = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': app.base, 'Access-Control-Allow-Credentials': 'true' });
  res.write('data: {"type":"hello"}\n\n'); clients.add(res); req.on('close', () => clients.delete(res));
});
events.listen(0, '127.0.0.1'); await once(events, 'listening');
const eventUrl = `http://127.0.0.1:${events.address().port}/events`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let lastPage;
const report = { checks: [], screenshots: [], destinations: [], providerCalls: [], integrationRequests: ['HO-I: shared cold Flow and loop routes, focus targets and main SSE bridge', 'HO-B: production link service mount'] };
const pass = (name, detail) => { report.checks.push({ name, detail }); console.log(`PASS ${name}${detail ? ': ' + detail : ''}`); };
try {
  for (const width of [390,1280]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: app.base }]);
    await context.addInitScript(() => { localStorage.setItem('swarm.theme', 'light'); localStorage.setItem('swarm.sidebarCollapsed', '1'); });
    const rosterResponse = await context.request.get(`${app.base}/api/bots`), roster = await rosterResponse.json();
    const rich = structuredClone(fixtures.rich), empty = structuredClone(fixtures.empty), suggested = structuredClone(fixtures.suggestions);
    rich.bot.id = app.fixture.bot.id; empty.bot.id = roster.bots.find(b => b.id !== rich.bot.id && b.kind !== 'room').id; suggested.bot.id = 'flow-suggestion-fixture';
    for (const link of rich.links) { if (link.fromBotId === 'flow-rich') link.fromBotId = rich.bot.id; else link.fromBotId = empty.bot.id; if (link.toBotId === 'flow-rich') link.toBotId = rich.bot.id; else link.toBotId = empty.bot.id; }
    const inputs = [rich,empty,suggested], models = new Map(inputs.map(i => [i.bot.id, buildFlowModel(i)]));
    let links = rich.links.map(l => ({ ...l, userId: app.fixture.userId, trigger: 'any_run', template: '', autoApproveLoops: false, createdAt: 1, updatedAt: 1 })), saves = 0;
    const page = await context.newPage(); lastPage = page; page.setDefaultTimeout(15000); const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', async route => { const url = new URL(route.request().url()); if (!['127.0.0.1','localhost'].includes(url.hostname)) { report.providerCalls.push(url.origin); return route.abort(); } return route.fallback(); });
    await page.route('**/api/events', route => route.continue({ url: eventUrl }));
    await page.route(/\/api\/bots$/, async route => {
      if (route.request().method() !== 'GET') return route.fallback();
      const data = structuredClone(roster);
      for (const input of inputs) { let bot = data.bots.find(b => b.id === input.bot.id); if (!bot) { bot = { ...data.bots[0], id: input.bot.id }; data.bots.push(bot); } Object.assign(bot, { name: input.bot.name, instructions: input.bot.instructions, onboarding: { status: 'active' } }); }
      return route.fulfill({ json: data });
    });
    await page.route(/\/api\/bots\/[^/]+\/flow$/, route => route.fulfill({ json: models.get(decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3])), headers: { 'X-Flow-Has-Runs': '0' } }));
    await page.route(/\/api\/bots\/[^/]+\/flow\/refresh$/, route => route.fulfill({ json: { accepted: true, retryAfter: 600 } }));
    await page.route(/\/api\/handoff-links\?/, async route => {
      const fromBotId = new URL(route.request().url()).searchParams.get('botId');
      if (route.request().method() === 'GET') return route.fulfill({ json: { links: links.filter(l => l.fromBotId === fromBotId || l.toBotId === fromBotId) } });
      const body = route.request().postDataJSON(); saves++;
      const next = body.links.map((l,i) => ({ ...l, id: links.find(old => old.fromBotId === fromBotId && old.toBotId === l.toBotId)?.id || `link-${i}`, fromBotId, userId: app.fixture.userId, createdAt: 1, updatedAt: 1 }));
      try { assert.ok(next.length <= 5); assertAutoLinkAcyclic([...links.filter(l => l.fromBotId !== fromBotId), ...next]); }
      catch { return route.fulfill({ status: 422, json: { code: 'cycle_detected', error: 'Automatic links cannot form a cycle. Use a loop instead.' } }); }
      links = [...links.filter(l => l.fromBotId !== fromBotId), ...next]; return route.fulfill({ json: { links: next } });
    });
    const screenshot = async name => { const file = path.join(evidence, `${name}-${width}.png`); await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(file); };
    async function show(input) {
      await page.goto(`${app.base}/#bot/${input.bot.id}/details/activity`);
      await page.getByRole('navigation', { name: 'Conversation details sections' }).getByRole('button', { name: 'Flow', exact: true }).click();
      await page.locator('.flow-chart').waitFor();
      await page.waitForFunction(() => document.querySelectorAll('.flow-lane').length === 5);
    }
    for (const [index,input] of inputs.entries()) {
      await show(input);
      const issues = await page.evaluate(inspectAlignment); assert.deepEqual(issues, []); pass(`${width} ${['rich','empty','suggestions'][index]} alignment`, '0 issues');
      const labels = await page.locator('.flow-lane .layout-section__header').allTextContents(); assert.deepEqual(labels.map(s => s.replace(/^\d/,'')), ['Triggers','Inputs','Steps','Outputs','Handoffs']);
      const geometry = await page.locator('.flow-lane').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return { width: r.width, top: r.top }; }));
      assert.ok(Math.max(...geometry.map(r => r.width)) - Math.min(...geometry.map(r => r.width)) < 1);
      if (width === 1280) assert.equal(new Set(geometry.map(r => r.top)).size, 1); else assert.equal(new Set(geometry.map(r => r.top)).size, 5);
      if (width === 390) assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
      assert.equal(await page.locator('.flow-lanes > li > section ol').count(), 5);
      assert.equal(await page.locator('.flow-chart button').evaluateAll(nodes => nodes.every(n => n.getAttribute('aria-label') || n.textContent.trim())), true);
      await screenshot(['rich','empty','suggestions'][index]); pass(`${width} ${['rich','empty','suggestions'][index]} structure and accessibility`, 'ordered lanes, named controls, equal widths');
    }
    await show(rich);
    const nodes = await page.locator('[data-flow-node]').evaluateAll(nodes => nodes.map(n => ({ id: n.dataset.flowNode, kind: n.dataset.kind })));
    await page.locator('[data-flow-node]').first().focus();
    for (let i = 1; i < nodes.length; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.dataset.flowNode), nodes[i].id); }
    pass(`${width} keyboard reading order`, `${nodes.length} nodes`);
    rich.routines[0].schedule = 'Tuesdays 10:00'; models.set(rich.bot.id, buildFlowModel(rich, { version: 2, generatedAt: 1 }));
    for (const client of clients) client.write(`data: ${JSON.stringify({ type: 'routines', botId: rich.bot.id })}\n\n`);
    await page.getByText('Tuesdays 10:00', { exact: true }).waitFor(); await screenshot('routine-updated'); pass(`${width} live routine update`, 'SSE refetch');
    for (const node of nodes.filter(n => n.kind !== 'loop')) {
      await show(rich);
      await page.locator(`[data-flow-node="${node.id}"]`).click();
      const modelNode = models.get(rich.bot.id).lanes.flatMap(l => l.nodes).find(n => n.id === node.id);
      if (['inbound_handoff','handoff_to','handoff_from'].includes(node.kind)) { await page.getByRole('dialog', { name: 'Handoff links' }).waitFor(); await screenshot(`destination-${node.kind}`); await page.keyboard.press('Escape'); }
      else { await page.waitForTimeout(250); await screenshot(`destination-${node.kind}`); await page.goBack(); }
      await page.locator('.flow-chart').waitFor();
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.flowNode), node.id, `${node.kind} return focus`);
      report.destinations.push({ width, kind: node.kind, target: modelNode.target });
    }
    pass(`${width} node destinations and return focus`, `${nodes.filter(n => n.kind !== 'loop').length} clicks; loop route reserved for HO-I`);
    await show(rich); await page.getByRole('button', { name: 'Add handoff', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Handoff links' }); await dialog.waitFor();
    await dialog.getByLabel('Agent', { exact: true }).selectOption(suggested.bot.id); await dialog.getByRole('button', { name: 'Add link', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' }); assert.equal(saves, 1); pass(`${width} add link`, '1 save');
    await page.locator('[data-kind="handoff_to"]').click(); await dialog.waitFor(); await dialog.getByLabel('Mode', { exact: true }).selectOption('auto');
    links.find(l => l.id === 'receive').mode = 'auto';
    await dialog.getByRole('button', { name: 'Save link', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: 'cycle' }).waitFor();
    await screenshot('cycle-refused'); pass(`${width} auto cycle refusal`, 'inline error');
    await dialog.getByRole('button', { name: 'Remove link', exact: true }).click(); await dialog.waitFor({ state: 'hidden' }); pass(`${width} remove link`, 'saved');
    assert.deepEqual(errors, []); await context.close();
  }
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`FLOW DEMO ${report.checks.length} passed, 0 failed. Output: ${path.join(evidence, 'report.json')}`);
} catch (error) { if (lastPage && !lastPage.isClosed()) { await lastPage.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }); fs.writeFileSync(path.join(evidence, 'failure.html'), await lastPage.content()); } fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ ...report, error: String(error) }, null, 2)); throw error; }
finally { await browser.close(); for (const client of clients) client.end(); await new Promise(r => events.close(r)); await app.close(); }

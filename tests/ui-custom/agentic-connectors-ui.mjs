import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { agentFixture } from './agent-fixture.mjs';

const output = path.resolve('.context/ui-custom/agentic-connectors');
fs.mkdirSync(output, { recursive: true });
const server = await agentFixture();
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const sources = [
  { id: 'email.recent', title: 'Recent email', type: 'list', options: { limit: 5 } },
  { id: 'calendar.upcoming', title: 'Upcoming events', type: 'table', options: { columns: ['title', 'startsAt'], limit: 5 } },
  { id: 'crm.deals', title: 'Open deals', type: 'list', options: { limit: 5 } },
];
const screenshots = [], errors = [];
let passed = 0;
try {
  const current = (await server.request('GET', '/ui/config')).body;
  const preview = await server.request('POST', '/ui/patches/preview', { intent: 'Add connected data', patch: [{ op: 'add', path: '/dashboards/-', value: {
    id: '$new1', name: 'Connected data', icon: 'layout-dashboard', widgets: [
      ...sources.map((source, index) => ({ id: `$new${index + 2}`, type: source.type, title: source.title, span: 6, rows: 3,
        source: { id: source.id, params: {} }, options: source.options })),
      { id: '$new5', type: 'agent', title: 'My summary', span: 6, rows: 3, options: { prompt: 'Summarize my open tasks', display: 'text', schedule: 'manual' } },
    ],
  } }] }, current.revision);
  assert.equal(preview.status, 200, JSON.stringify(preview));
  const applied = await server.request('POST', `/ui/previews/${preview.body.previewId}/apply`, {}, current.revision);
  assert.equal(applied.status, 200, JSON.stringify(applied));
  const dashboard = (await server.request('GET', '/ui/config')).body.doc.dashboards.at(-1);
  const data = await server.request('POST', '/ui/data', { requests: sources.map(source => ({ key: source.id, source: source.id, params: {} })) });
  assert.equal(data.status, 200);
  for (const source of sources) {
    assert.equal(data.body.results[source.id].ok, true);
    assert.equal(data.body.results[source.id].available, false);
    assert.deepEqual(data.body.results[source.id].rows, []);
  }
  passed++; console.log('PASS three connector sources return unavailable without errors');
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
  await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  for (const width of [320, 390, 500, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${server.base}/#dash/${dashboard.id}`);
    for (const source of sources) {
      const region = page.getByRole('region', { name: source.title, exact: true });
      await region.scrollIntoViewIfNeeded();
      await region.getByText('Connect an app to see your data.', { exact: true }).waitFor();
      const connect = region.getByRole('link', { name: 'Connect', exact: true });
      assert.equal(await connect.getAttribute('href'), '#settings/apps');
      assert.equal(await region.locator('.dashboard-widget-error').count(), 0);
      assert.equal(await region.getByRole('button', { name: 'Ask your agent', exact: true }).count(), 0);
      assert.equal(await region.locator('h2, p, a').evaluateAll(elements => elements.every(el => el.scrollWidth <= el.clientWidth + 1)), true);
    }
    await page.getByRole('region', { name: 'My summary', exact: true }).getByText('No answer yet', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const screenshot = path.join(output, `connect-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true }); screenshots.push(screenshot);
    await page.getByRole('region', { name: 'Recent email', exact: true }).getByRole('link', { name: 'Connect', exact: true }).click();
    await page.waitForURL('**/#settings/apps');
    await page.locator('.app.is-app-settings').waitFor();
    passed++; console.log(`PASS ${width}px: Connect state, settings navigation and agent fallback`);
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed, screenshots, errors }, null, 2));
  console.log(`Agentic connector UI: ${passed}/${passed} passed; output ${output}`);
} finally {
  await browser.close();
  fs.writeFileSync(path.join(output, 'server.log'), server.logs.join(''));
  await server.close();
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { tsImport } from 'tsx/esm/api';
import { clientFixture } from '../unit/client-fixture.mjs';
import { seedDashboardData } from '../dashboard-fixture.mjs';
import { output, handoff, events } from '../../handoffs/ui-d-fixture.mjs';
import { recordedRun } from '../../handoffs/ui-e-fixture.mjs';

const { APP_SECTIONS, BOT_TABS } = await tsImport('../../../web/src/lib/navigation.ts', import.meta.url);
// Use the navigation suite's actual list, including aliases and unknown routes.
const navigation = fs.readFileSync(new URL('../../navigation-every-route-ui.mjs', import.meta.url), 'utf8');
const list = navigation.match(/const routes = (\[[\s\S]*?\n\]);/);
assert.ok(list, 'Navigation route inventory must be available');
export const navigationRoutes = vm.runInNewContext(list[1], { APP_SECTIONS, BOT_TABS, output });

export async function accessibilityFixture() {
  const server = await clientFixture();
  try {
  seedDashboardData(server.db, server.fixture);
  server.db.prepare('INSERT INTO account_preferences(user_id,ui_adapt,updated_at) VALUES(?,1,?) ON CONFLICT(user_id) DO UPDATE SET ui_adapt=1').run(server.fixture.userId, Date.now());
  const { DEFAULT_CONFIG } = await tsImport('../../../server/src/ui-config/index.ts', import.meta.url);
  const doc = structuredClone(DEFAULT_CONFIG);
  doc.dashboards = [{ id: 'd_a11y0001', name: 'My week', icon: 'layout-dashboard', widgets: [
    { id: 'w_a11y0001', type: 'table', title: 'Task table', span: 6, rows: 3, source: { id: 'tasks.list', params: { limit: 10 } }, options: { columns: ['title', 'state', 'botName'], limit: 10 } },
    { id: 'w_a11y0002', type: 'list', title: 'Open tasks', span: 6, rows: 3, source: { id: 'tasks.list', params: {} }, options: { limit: 10 } },
    ...['text', 'stat', 'list'].map((kind, i) => ({ id: `w_a11y000${i + 3}`, type: 'agent', title: `Agent ${kind}`, span: 6, rows: 3, options: { prompt: 'Summarize my tasks', display: kind, schedule: 'manual' } })),
    { id: 'w_a11y0006', type: 'chart', title: 'Usage', span: 6, rows: 3, source: { id: 'usage.series', params: { range: '7d', metric: 'cost' } }, options: { kind: 'bar' } },
  ] }, { id: 'd_a11y0002', name: 'Blank dashboard', icon: 'layout-dashboard', widgets: [] }];
  const response = await fetch(`${server.base}/api/ui/config`, { method: 'PUT', headers: { cookie: 'swarm_session=layout-test-token', origin: server.base, 'content-type': 'application/json', 'if-match': '"0"' }, body: JSON.stringify(doc) });
  assert.equal(response.status, 200, await response.text());
  const profile = await fetch(`${server.base}/api/ui/requirements`, { method: 'PUT', headers: { cookie: 'swarm_session=layout-test-token', origin: server.base, 'content-type': 'application/json', 'if-match': '"0"' }, body: JSON.stringify({ patch: [
    { op: 'replace', path: '/role', value: 'Project coordinator' }, { op: 'replace', path: '/goals', value: ['Review open tasks', 'Plan the next launch'] },
    { op: 'replace', path: '/workflows', value: [{ name: 'Weekly review', cadence: 'weekly' }] },
  ] }) });
  assert.equal(profile.status, 200, await profile.text());
  // Rapid route and zoom coverage revisits the same immutable seed queries.
  // Read each from the real local API once rather than exhaust its production
  // 30-batch/minute budget. Live refresh behavior has its own dashboard suites.
  const dataReads = new Map();
  return { ...server,
    async usage(page, state) {
      const response = await page.context().request.get(`${server.base}/api/usage/summary`);
      assert.equal(response.status(), 200);
      const summary = await response.json();
      const cli = state.startsWith('cli-');
      const percent = { normal: 24.68, warning: 80, critical: 100, 'no-limit': null, 'cli-known': 82.5, 'cli-unknown': null }[state];
      assert.notEqual(percent, undefined, 'Usage state must be registered');
      summary.plan = { ...summary.plan, name: cli ? 'Claude Pro plan' : 'API credits', provider: cli ? 'claude-cli' : null,
        billing: cli ? 'plan' : 'api', unit: cli ? 'percent' : 'usd', usedCents: cli ? 0 : percent === null ? 1234 : percent * 50,
        limitCents: cli || percent === null ? null : 5000, percentUsed: percent, resetsAt: Date.UTC(2026, 11, 1) };
      summary.ownKeys = { ...summary.ownKeys, usedCents: 237, requests: 2 };
      await page.route('**/api/usage/summary', route => route.fulfill({ json: summary }));
    },
    async preset(id) {
      const { presetConfig } = await tsImport('../../../server/src/ui-config/presets.ts', import.meta.url);
      const next = presetConfig(id); next.theme.mode = 'system'; next.dashboards = doc.dashboards;
      const headers = { cookie: 'swarm_session=layout-test-token', origin: server.base, 'content-type': 'application/json' };
      const current = await (await fetch(`${server.base}/api/ui/config`, { headers })).json();
      const response = await fetch(`${server.base}/api/ui/config`, { method: 'PUT', headers: { ...headers, 'if-match': `"${current.revision}"` }, body: JSON.stringify(next) });
      assert.equal(response.status, 200, await response.text());
    },
    async previewCard(page) {
      const title = 'Review dashboard layout';
      const preview = await server.preview([{ op: 'replace', path: '/layout/chat/width', value: 'wide' }], title);
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const bot = server.db.prepare('SELECT generation,next_seq FROM bots WHERE id=?').get(server.fixture.bot.id);
      const body = { type: 'card', card: 'ui_preview', previewId: preview.previewId, title, lines: preview.summary, warnings: [], moreCount: 0, status: 'pending' };
      server.db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,?,?,?,?,?,?)').run(server.fixture.bot.id, bot.generation, bot.next_seq, bot.next_seq, 'card', JSON.stringify(body), Date.now());
      server.db.prepare('UPDATE bots SET next_seq=?,rev=? WHERE id=?').run(bot.next_seq + 1, bot.next_seq, server.fixture.bot.id);
      await page.reload();
      await page.getByRole('region', { name: title, exact: true }).waitFor();
      await page.getByRole('region', { name: title, exact: true }).scrollIntoViewIfNeeded();
    },
    async context(browser, width, theme) {
    const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 900 }, colorScheme: theme, reducedMotion: 'reduce' });
    const run = recordedRun();
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== server.base) return route.abort();
      const p = url.pathname;
      let json;
      if (p === '/api/ui/data' && route.request().method() === 'POST') {
        const { requests } = route.request().postDataJSON();
        json = { results: Object.fromEntries(await Promise.all(requests.map(async request => {
          const key = JSON.stringify([request.source, request.params]);
          if (!dataReads.has(key)) dataReads.set(key, (async () => {
            const response = await fetch(`${server.api}/api/ui/data`, { method: 'POST', headers: { cookie: 'swarm_session=layout-test-token', origin: server.base, 'content-type': 'application/json' }, body: JSON.stringify({ requests: [{ ...request, key: 'seed' }] }) });
            assert.equal(response.status, 200, await response.clone().text());
            return (await response.json()).results.seed;
          })());
          return [request.key, await dataReads.get(key)];
        }))) };
      }
      if (p === '/api/loops') json = { loops: [run.detail.loop], next: null };
      if (p === '/api/loops/lp_converged') json = run.detail;
      if (p === '/api/loops/lp_converged/events') json = { events: run.events, next: null };
      if (p === '/api/handoffs/ho_fixture') json = { handoff, events };
      if (p === `/api/outputs/${output.id}`) json = { output };
      if (p.includes(`/api/outputs/${output.id}/parts/`)) json = { output, part: output.parts[0], text: 'Placeholder output body.', next: null };
      const widget = p.match(/\/widgets\/d_a11y0001\/w_a11y000([345])\/result$/);
      if (widget) {
        const result = widget[1] === '3' ? { kind: 'text', text: 'Review the launch plan and open tasks.' } : widget[1] === '4' ? { kind: 'stat', value: '12', label: 'Tasks', delta: '3 added' } : { kind: 'list', rows: Array.from({ length: 10 }, (_, i) => ({ title: `Task ${i + 1}`, subtitle: 'Review the next step', status: 'Working', action: { type: 'open', route: '#tasks' } })) };
        json = { dashboardId: 'd_a11y0001', widgetId: `w_a11y000${widget[1]}`, state: 'ready', doc: result, runAt: Date.now(), durationMs: 100 };
      }
      return json ? route.fulfill({ json }) : route.continue();
    });
    await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
    await context.addInitScript(() => localStorage.setItem('swarm.sidebarCollapsed', '0'));
    return context;
  }, async open(page, hash) {
    if (!page.a11yTraffic) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
      const pending = new Set(); let last = Date.now();
      page.a11yTraffic = { pending, last: () => last };
      page.on('request', request => { if (request.resourceType() !== 'eventsource') { pending.add(request); last = Date.now(); } });
      const done = request => { if (pending.delete(request)) last = Date.now(); };
      page.on('requestfinished', done); page.on('requestfailed', done);
    }
    hash = hash.replaceAll('coordinator', server.fixture.bot.id).replaceAll('project-room', server.fixture.room);
    await page.goto('about:blank');
    // The old document can leave cancelled requests in flight during navigation.
    // Quiescence and loaded-widget assertions apply to the new document only.
    page.a11yTraffic.pending.clear();
    await page.goto(`${server.base}/${hash}`);
    await page.locator('.shell-header').waitFor();
    await page.waitForFunction(() => !document.querySelector('.shell-loading'));
    await page.evaluate(() => document.fonts.ready);
    await page.locator('[data-layout="page"]:visible').first().waitFor();
    const deadline = Date.now() + 15000;
    while (page.a11yTraffic.pending.size || Date.now() - page.a11yTraffic.last() < 200) {
      assert.ok(Date.now() < deadline, `Screen did not settle: ${hash}; pending ${[...page.a11yTraffic.pending].map(r => r.url()).join(', ')}`);
      await page.waitForTimeout(50);
    }
    if (hash === '#first-run') await page.locator('.first-run__progress').waitFor();
    if (hash.startsWith('#dash/d_') && !hash.includes('d_a11y0002')) {
      for (const widget of await page.locator('[data-widget-id]').all()) {
        await widget.scrollIntoViewIfNeeded();
        if (await widget.getAttribute('data-widget-type') === 'agent') await widget.locator('.dashboard-agent-answer, .dashboard-agent-stat, .dashboard-agent-list').waitFor();
        else {
          await page.waitForFunction(id => document.querySelector(`[data-widget-id="${id}"]`)?.dataset.widgetState === 'ready', await widget.getAttribute('data-widget-id'));
        }
      }
      await page.locator('.dashboard-heading').scrollIntoViewIfNeeded();
    }
  } };
  } catch (error) { await server.close(); throw error; }
}

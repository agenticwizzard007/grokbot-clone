// Seeded local server only. Real API/ledger reconciliation plus controlled quota states.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { chromium } from 'playwright';
import { layoutServer } from './layout-fixture.mjs';
import { readableWords } from './paper-label-geometry.mjs';

const evidence = '.context/usg-b/shots';
fs.mkdirSync(evidence, { recursive: true });
fs.mkdirSync('.context/usg-b', { recursive: true });
const server = await layoutServer({ customization: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
let passed = 0;
try {
  const db = new Database(server.dbPath);
  const events = JSON.parse(fs.readFileSync('tests/fixtures/usage-summary.json', 'utf8')).events;
  events.push({ id: 'native-whole', keyKind: 'native', cost: 12.29, source: 'provider' });
  const now = Date.now();
  for (const event of events) db.prepare(`INSERT INTO usage_events (user_id,kind,provider,model,cost_usd,cost_source,key_kind,request_id,created_at)
    VALUES (?,'chat','openrouter','placeholder',?,?,?,?,?)`).run(server.fixture.userId, event.cost, event.source, event.keyKind, event.id, now);
  const directCents = db.prepare("SELECT cost_usd FROM usage_events WHERE user_id=? AND key_kind='native'").all(server.fixture.userId).reduce((sum, row) => sum + (row.cost_usd === null ? 0 : Math.round(row.cost_usd * 100)), 0);
  db.close();
  const context = await browser.newContext();
  await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
  const response = await context.request.get(`${server.base}/api/usage/summary`);
  assert.equal(response.status(), 200);
  const original = await response.json();
  assert.equal(original.plan.usedCents, directCents);
  assert.equal(directCents, 1234);
  const batch = await context.request.post(`${server.base}/api/ui/data`, { data: { requests: [
    { key: 'week', source: 'usage.summary', params: { range: '7d' } },
    { key: 'days', source: 'usage.series', params: { range: '7d', metric: 'cost' } },
    { key: 'meter', source: 'usage.windows', params: {} },
  ] } });
  const body = await batch.json();
  assert.equal(batch.status(), 200, JSON.stringify(body));
  const results = body.results;
  assert.equal(results.week.value.costUsd * 100, original.week.planUsedCents);
  assert.equal(Math.round(results.days.rows.reduce((sum, day) => sum + day.value, 0) * 100), original.week.planUsedCents);
  assert.deepEqual(results.meter.value.plan, original.plan);
  assert.deepEqual(results.meter.value.ownKeys, original.ownKeys);
  fs.writeFileSync('.context/usg-b/api-ledger.json', JSON.stringify({ directCents, summary: original, widgets: results }, null, 2));
  await context.close();
  console.log(`PASS API and three widget sources reconcile to ledger: ${directCents} cents`); passed++;

  for (const width of [320, 390, 500, 1280]) for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 900 }, reducedMotion: 'reduce', colorScheme: theme });
    await ctx.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
    await ctx.addInitScript(theme => {
      localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0');
      window.streams = [];
      window.EventSource = class {
        static CLOSED = 2;
        constructor() { window.streams.push(this); setTimeout(() => this.onopen?.(), 0); }
        close() { window.streams = window.streams.filter(stream => stream !== this); }
      };
      window.emitUsage = detail => window.streams.forEach(stream => stream.onmessage?.({ data: JSON.stringify(detail) }));
    }, theme);
    const page = await ctx.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let snapshot = structuredClone(original), hold = true, pending = [], reads = 0, fail = false;
    snapshot.ownKeys = { ...snapshot.ownKeys, usedCents: 0, requests: 0 };
    const fulfill = route => route.fulfill(fail ? { status: 503, json: { error: 'Temporarily unavailable' } } : { json: snapshot });
    await page.route('**/api/usage/summary', route => { reads++; if (hold) pending.push(route); else return fulfill(route); });
    await page.route('**/api/usage/provider', route => { errors.push('Meter requested provider billing'); return route.abort(); });
    await page.route('**/*', route => new URL(route.request().url()).origin === server.base ? route.fallback() : (errors.push('External request attempted'), route.abort()));
    await page.goto(`${server.base}/#bots`);
    await page.locator('.shell-header').waitFor();
    await page.waitForFunction(async () => (await import('/src/customization/store.ts')).useCustomization.getState().status === 'ready');
    await page.evaluate(async mode => {
      const { patchUiConfig, dismissUndo } = await import('/src/customization/store.ts');
      const result = await patchUiConfig([{ op: 'replace', path: '/theme/mode', value: mode }]);
      if (!result.ok) throw new Error('Theme fixture did not apply');
      dismissUndo();
    }, theme);
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme);
    if (width <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    const meter = page.locator('.sidebar-usage:visible');
    await meter.getByText('Loading usage...', { exact: true }).waitFor();
    const loadingHeight = (await meter.boundingBox()).height;
    hold = false; await Promise.all(pending.splice(0).map(fulfill));
    await meter.getByText('No limit', { exact: true }).waitFor();
    assert.equal((await meter.boundingBox()).height, loadingHeight, 'loading reserves meter height');
    assert.equal(await meter.locator('.plan-usage__amount').innerText(), '$12.34');
    const refresh = async () => {
      const before = reads; await page.evaluate(() => window.emitUsage({ type: 'usage' }));
      await page.waitForFunction(() => true);
      for (let i = 0; reads === before && i < 100; i++) await page.waitForTimeout(10);
      assert.ok(reads > before, 'SSE usage refetches the summary');
    };
    const states = [
      { name: 'normal', cents: 1234, limit: 5000, percent: 24.68, text: '24.7% used', level: 'normal' },
      { name: 'warning', cents: 4000, limit: 5000, percent: 80, text: '80% used', level: 'warning' },
      { name: 'critical', cents: 6250, limit: 5000, percent: 125, text: '100% used', level: 'critical' },
      { name: 'no-limit', cents: 1234, limit: null, percent: null, text: 'No limit', level: 'normal' },
      { name: 'cli-unknown', cents: 0, limit: null, percent: null, text: 'Quota unavailable', level: 'normal', cli: true },
      { name: 'cli-known', cents: 0, limit: null, percent: 82.5, text: '82.5% used', level: 'warning', cli: true },
    ];
    for (const state of states) {
      snapshot.plan = { ...original.plan, name: state.cli ? 'Claude Pro plan' : 'API credits', provider: state.cli ? 'claude-cli' : null,
        billing: state.cli ? 'plan' : 'api', unit: state.cli ? 'percent' : 'usd', usedCents: state.cents, limitCents: state.limit, percentUsed: state.percent };
      await refresh();
      await meter.getByText(state.text, { exact: true }).waitFor();
      assert.equal(await meter.locator('.plan-usage').getAttribute('data-level'), state.level);
      if (!state.cli) assert.equal(await meter.locator('.plan-usage__amount').innerText(), state.limit === null ? '$12.34' : `$${(state.cents / 100).toFixed(2)} of $50.00`);
      assert.equal(await meter.getByRole('progressbar').count(), state.percent === null ? 0 : 1);
      if (state.percent !== null) assert.equal(Number(await meter.getByRole('progressbar').getAttribute('value')), Math.min(100, state.percent));
      if (state.cli) assert.doesNotMatch(await meter.innerText(), /No limit|\$/);
      if (state.level !== 'normal') assert.match(await meter.innerText(), state.level === 'critical' ? /Limit reached/ : /Near limit/);
      assert.equal(await meter.locator('.plan-usage__own').count(), 0);
      assert.equal(await meter.and(page.getByRole('button', { name: new RegExp(snapshot.plan.name) })).count(), 1, 'Compact meter retains the plan name for assistive technology');
      await readableWords(meter);
      if (width <= 760) assert.ok((await meter.boundingBox()).height <= 73, 'Phone quota states fit the compact meter');
      const issues = await meter.evaluate(el => {
        const r = el.getBoundingClientRect(), issues = [];
        if (r.left < 0 || r.right > innerWidth || r.bottom > innerHeight) issues.push('Outside viewport');
        for (const child of el.querySelectorAll('.plan-usage *')) {
          if (child.closest('.sr-only')) continue;
          const s = getComputedStyle(child);
          if (s.textOverflow === 'ellipsis') issues.push('Ellipsis');
          if (child.scrollWidth > child.clientWidth + 1 && child.clientWidth > 0) issues.push(`Overflow ${child.className}`);
          if (child.matches('strong, .plan-usage__amount') && s.fontSize !== '14px') issues.push('Primary type');
          if (child.matches('.plan-usage__status, .plan-usage__reset') && parseFloat(s.fontSize) < 13) issues.push('Secondary type');
        }
        return issues;
      });
      assert.deepEqual(issues, [], `${width} ${theme} ${state.name}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if ([390, 1280].includes(width) && ['normal', 'warning', 'no-limit'].includes(state.name)) await page.screenshot({ path: `${evidence}/${width}-${theme}-${state.name}.png` });
      console.log(`PASS ${width} ${theme} ${state.name}`); passed++;
    }
    // Run idle must refetch even if a usage notification was lost.
    snapshot.plan = { ...original.plan, usedCents: 1235 };
    await page.evaluate(botId => { window.emitUsage({ type: 'live', state: { botId, isRunning: true, revision: Date.now(), activity: '', pending: [], awaiting: null } }); window.emitUsage({ type: 'live', state: { botId, isRunning: false, revision: Date.now() + 1, activity: '', pending: [], awaiting: null } }); }, server.fixture.bot.id);
    await meter.getByText('$12.35', { exact: true }).waitFor();
    // Keep the loaded values and height throughout slow and failed refreshes.
    hold = true; const beforeHeight = (await meter.boundingBox()).height; await refresh();
    assert.equal((await meter.boundingBox()).height, beforeHeight);
    assert.equal(await meter.getByText('$12.35', { exact: true }).count(), 1);
    fail = true; hold = false; await Promise.all(pending.splice(0).map(fulfill));
    await meter.getByText('Update unavailable').waitFor();
    assert.equal((await meter.boundingBox()).height, beforeHeight);
    fail = false; snapshot.ownKeys = original.ownKeys; await refresh();
    await meter.getByText(/On your own keys \(does not count toward the plan\)/).waitFor();
    assert.match(await meter.innerText(), /\$2.37 On your own keys/);
    if (width <= 760) assert.ok((await meter.boundingBox()).height <= 73, 'Own-key detail stays compact on phone');
    await readableWords(meter);
    // Short viewports retain the amount and quota state.
    await page.setViewportSize({ width, height: 500 });
    await meter.getByText('$12.35', { exact: true }).waitFor();
    assert.ok((await meter.boundingBox()).y >= 0);
    assert.ok((await meter.boundingBox()).y + (await meter.boundingBox()).height <= 500);
    await page.setViewportSize({ width, height: 900 });
    if (width === 1280) {
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      assert.match(await meter.getAttribute('aria-label'), /API credits.*\$12.35.*No limit/);
      assert.equal((await meter.boundingBox()).width, 40);
      const hit = await meter.evaluate(el => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.left - 1, r.top + r.height / 2) === el; });
      assert.ok(hit, '44px hit area surrounds 40px rail control');
      await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
    }
    // API billing opens Usage; CLI billing opens Models & access with the same figures.
    await meter.click();
    await page.waitForURL('**/#settings/usage');
    await page.goto(`${server.base}/#bots`);
    if (width <= 760) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    snapshot.plan = { ...original.plan, name: 'Claude Pro plan', provider: 'claude-cli', billing: 'plan', unit: 'percent', percentUsed: 82.5 };
    await refresh();
    await meter.getByText('82.5% used', { exact: true }).waitFor();
    await meter.click();
    await page.waitForURL('**/#settings/subscriptions');
    const access = page.locator('.subscription-settings .plan-usage');
    await access.getByText('82.5% used', { exact: true }).waitFor();
    assert.match(await access.innerText(), /Claude Pro plan/);
    assert.match(await access.innerText(), /\$2.37 On your own keys/);
    await readableWords(access);
    assert.deepEqual(errors, []);
    await ctx.close();
    console.log(`PASS ${width} ${theme} live, idle, loading, error, own keys, short viewport and navigation`); passed++;
  }
  console.log(`PASS ${passed} checks`);
} finally { await browser.close(); await server.close(); }

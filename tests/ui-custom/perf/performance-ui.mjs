import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { runSuite, fixtureContext, configAvailable, api, patch, open, until, requireModules, requireFeature } from '../fixtures/harness.mjs';
import { ROOT } from '../fixtures/server.mjs';
import { contracts } from '../fixtures/presets.mjs';
import { THEME_PATCH, dashboardPatch } from '../fixtures/matrix.mjs';
import { seedLoad } from './load.mjs';

const baselinePath = path.join(ROOT, 'tests/ui-custom/perf/baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const measurements = {}, details = {};
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
function measure(name, value) {
  assert.ok(Number.isFinite(value) && value >= 0, `${name} must be measured`);
  measurements[name] = value;
  assert.ok(value < baseline.budgets[name] || name === 'dashboardCLS' && value <= baseline.budgets[name], `${name}: ${value} exceeds budget ${baseline.budgets[name]}`);
  if (typeof baseline.measurements[name] === 'number') assert.ok(value <= Math.max(baseline.measurements[name], Number.EPSILON) * baseline.regressionLimit, `${name}: more than 25 percent regression`);
  console.log(`MEASURE ${name}: ${value} (budget ${baseline.budgets[name]})`);
}
async function withConfig(args, fn) {
  const { context } = await fixtureContext(args.browser, args.server);
  try { const current = await configAvailable(context.request, args.server.base); await fn({ ...args, context, current }); }
  finally { await context.close(); }
}
const cases = [
  { name: 'config sizes and 50-read p95', run: args => withConfig(args, async ({ context, server, current }) => {
    const durations = [], sizes = [];
    for (let i = 0; i < 55; i++) {
      const start = performance.now(); const response = await context.request.get(`${server.base}/api/ui/config`); const text = await response.text();
      assert.equal(response.status(), 200);
      if (i >= 5) durations.push(performance.now() - start);
      sizes.push(Buffer.byteLength(JSON.stringify(JSON.parse(text).doc)));
      measureOnceGzip(text);
    }
    measure('configReadP95Ms', percentile(durations, .95));
    measure('configMedianBytes', percentile(sizes, .5)); measure('configMaxBytes', Math.max(...sizes));
    details.configRead = { samples: durations, method: 'loopback HTTP round trip, conservative upper bound on server time', documents: 'default fixture' };
    function measureOnceGzip(text) { const size = gzipSync(text).length; measurements.configGzipBytes = Math.max(measurements.configGzipBytes || 0, size); }
    measure('configGzipBytes', measurements.configGzipBytes);
  }) },
  { name: '100-operation validation p95', run: async () => {
    const { DEFAULT_CONFIG, previewPatch } = await contracts();
    const ops = Array.from({ length: 100 }, (_, i) => ({ op: 'replace', path: '/theme/mode', value: i % 2 ? 'light' : 'dark' }));
    const samples = [];
    for (let i = 0; i < 110; i++) { const start = performance.now(); const result = previewPatch(DEFAULT_CONFIG, ops, { ctx: { userId: 'qa-temp-perf', botIds: [] } }); assert.equal(result.ok, true); if (i >= 10) samples.push(performance.now() - start); }
    measure('patchP95Ms', percentile(samples, .95)); details.patch = { samples, operations: 100 };
  } },
  { name: 'boot, dashboard chunk and font budgets', run: async () => {
    requireModules('web/public/ui-boot.js', 'web/src/dashboards/DashboardGrid.tsx');
    measure('bootBytes', fs.statSync(path.join(ROOT, 'web/public/ui-boot.js')).size);
    const manifestPath = path.join(ROOT, 'web/dist/.vite/manifest.json');
    requireFeature(fs.existsSync(manifestPath), 'Production build required: npm run build -w web');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = Object.entries(manifest).find(([key, value]) => key.includes('DashboardView') || value.src?.includes('DashboardView'));
    assert.ok(entry, 'Dashboard route must be a lazy manifest entry');
    const visited = new Set(), eager = new Set();
    const collect = (key, set) => { if (set.has(key)) return; set.add(key); for (const dep of manifest[key]?.imports || []) collect(dep, set); };
    for (const [key, value] of Object.entries(manifest)) if (value.isEntry) collect(key, eager);
    collect(entry[0], visited);
    const bytes = [...visited].filter(key => !eager.has(key)).reduce((sum, key) => sum + gzipSync(fs.readFileSync(path.join(ROOT, 'web/dist', manifest[key].file))).length, 0);
    assert.ok(bytes > 0); measure('dashboardGzipBytes', bytes);
    const fonts = fs.readdirSync(path.join(ROOT, 'web/public/fonts')).filter(file => file.startsWith('atkinson-') && file.endsWith('.woff2'));
    assert.ok(fonts.length); measure('fontMaxBytes', Math.max(...fonts.map(file => fs.statSync(path.join(ROOT, 'web/public/fonts', file)).size)));
  } },
  { name: '24-request batch p95 with 10k tasks and 100 Bots', run: args => withConfig(args, async ({ context, server }) => {
    requireModules('server/src/ui/sources/tasks.ts');
    details.load = seedLoad(server);
    const sources = [
      ['tasks.counts', {}], ['tasks.list', { limit: 25 }], ['bots.status', { limit: 12 }],
      ['usage.summary', { range: '30d' }], ['usage.series', { range: '30d', metric: 'cost' }], ['runs.counts', { range: '30d' }],
    ];
    const requests = Array.from({ length: 24 }, (_, i) => ({ key: `load${i}`, source: sources[i % sources.length][0], params: sources[i % sources.length][1] }));
    const samples = [];
    // Keep below 30 batches/minute; a benchmark must not turn off the production limiter.
    for (let i = 0; i < 25; i++) {
      const start = performance.now(); const result = await api(context.request, server.base, '/data', 'POST', { requests });
      for (const entry of Object.values(result.results)) assert.equal(entry.ok, true);
      if (i >= 5) samples.push(performance.now() - start);
    }
    measure('dataBatchP95Ms', percentile(samples, .95)); details.data = { samples, requests: 24, cache: 'first five warmup, twenty warm samples' };
  }) },
  { name: 'cached first paint, token batch, dashboard content and CLS', run: args => withConfig(args, async ({ context, server }) => {
    requireModules('web/src/customization/applier.ts', 'web/src/dashboards/DashboardGrid.tsx');
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__ucPerf = { batches: [], cls: 0, first: null };
      let batch;
      const original = CSSStyleDeclaration.prototype.setProperty;
      CSSStyleDeclaration.prototype.setProperty = function(name, value, priority) {
        if (name.startsWith('--')) { if (!batch) { batch = { start: performance.now(), end: 0, count: 0 }; window.__ucPerf.batches.push(batch); queueMicrotask(() => { batch = null; }); } batch.count++; }
        const result = original.call(this, name, value, priority); if (batch) batch.end = performance.now(); return result;
      };
      new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__ucPerf.cls += entry.value; }).observe({ type: 'layout-shift', buffered: true });
      requestAnimationFrame(() => { const css = getComputedStyle(document.documentElement); window.__ucPerf.first = { pane: css.getPropertyValue('--color-bg-pane'), font: css.getPropertyValue('--font-stack'), mode: document.documentElement.dataset.theme }; });
    });
    await open(page, server.base); await patch(context, server.base, THEME_PATCH);
    await until(() => page.evaluate(() => JSON.parse(localStorage.getItem('swarm.ui.v1') || '{}').doc?.theme.mode === 'dark'), 'Theme cache not written');
    const expected = await page.evaluate(() => { const css = getComputedStyle(document.documentElement); return { pane: css.getPropertyValue('--color-bg-pane'), font: css.getPropertyValue('--font-stack'), mode: document.documentElement.dataset.theme }; });
    await page.reload(); await page.locator('.shell-header').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__ucPerf.first), expected, 'First animation frame flashed defaults');
    await patch(context, server.base, dashboardPatch()); const doc = (await configAvailable(context.request, server.base)).doc;
    // Warm the route before measuring actual visible fixture content.
    await open(page, server.base, `#dash/${doc.dashboards[0].id}`); await page.getByText('Fixture task 1', { exact: true }).first().waitFor();
    await open(page, server.base, '#bots');
    await page.evaluate(() => { window.__ucPerf.cls = 0; }); const start = performance.now();
    await page.evaluate(id => { location.hash = `#dash/${id}`; }, doc.dashboards[0].id);
    await page.getByText('Fixture task 1', { exact: true }).first().waitFor();
    measure('dashboardFirstContentMs', performance.now() - start);
    await page.waitForTimeout(1000); measure('dashboardCLS', await page.evaluate(() => window.__ucPerf.cls));
    const batches = await page.evaluate(() => window.__ucPerf.batches);
    assert.ok(batches.length, 'Instrumented the real applier');
    const { REGISTRY } = await contracts();
    const names = REGISTRY.tokens.flatMap(token => token.cssVars);
    const sixtyWrites = await page.evaluate(names => {
      const root = document.documentElement, css = getComputedStyle(root);
      const values = names.map(name => [name, css.getPropertyValue(name)]);
      const start = performance.now();
      for (let i = 0; i < 60; i++) root.style.setProperty(...values[i % values.length]);
      return performance.now() - start;
    }, names);
    details.tokens = { actualBatches: batches, registryWriteCount: 60, registryWriteMs: sixtyWrites };
    measure('applyTokensMs', Math.max(sixtyWrites, ...batches.map(batch => batch.end - batch.start)));
  }) },
];
const result = await runSuite('performance', cases);
const report = { recordedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length }, measurements, details, counts: result.counts };
fs.writeFileSync(path.join(result.out, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
const complete = Object.keys(baseline.budgets).every(name => Number.isFinite(measurements[name])) && !result.counts.fail && !result.counts.skip;
if (process.env.UC_RECORD_BASELINE === '1') {
  assert.ok(complete, 'Refusing to record an incomplete performance baseline');
  fs.writeFileSync(baselinePath, JSON.stringify({ ...baseline, status: 'measured', recordedAt: report.recordedAt, commit: report.commit, environment: report.environment, measurements }, null, 2) + '\n');
} else if (baseline.status !== 'measured') {
  console.log('PENDING performance regression baseline: integrated measurements required');
  if (process.env.UC_REQUIRE_FULL === '1') process.exitCode = 1;
}

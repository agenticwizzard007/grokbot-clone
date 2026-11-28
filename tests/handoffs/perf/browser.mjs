import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, browserSession, api } from '../e2e/fixture.mjs';
import { startLoop } from '../e2e/loop-journey.mjs';
const evidence = path.resolve('.context/handoffs/perf-h');
const server = await fixture(evidence, { extraSeed: 'tests/handoffs/perf/seed.mts' });
const metrics = {}, p95 = xs => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * .95) - 1];
const record = (name, samples, budget) => { metrics[name] = { p95: p95(samples), budget, samples: samples.length, unit: 'ms', pass: p95(samples) < budget }; console.log(`${metrics[name].pass ? 'PASS' : 'FAIL'} ${name}: ${p95(samples).toFixed(2)} ms < ${budget} ms`); };
try {
  for (const width of [390, 1280]) {
    const view = await browserSession(server, width), { page } = view;
    try {
      await page.addInitScript(() => {
        const original = window.fetch;
        window.fetch = async (...args) => {
          const result = await original(...args), pathname = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).pathname;
          if (window.hohMeasure?.api === pathname) window.hohMeasure.apiAt = performance.now();
          return result;
        };
        new MutationObserver(() => {
          const m = window.hohMeasure;
          if (!m || m.pending || m.elapsed !== undefined || !m.apiAt || !document.querySelector(m.selector)) return;
          m.pending = true;
          requestAnimationFrame(() => requestAnimationFrame(() => { m.elapsed = performance.now() - m.apiAt; }));
        }).observe(document, { subtree: true, childList: true, attributes: true });
        window.addEventListener('swarm:event', event => {
          const m = window.hohMeasure;
          if (m?.event && event.detail.type === 'loop' && event.detail.id === m.id && event.detail.status === m.status) m.apiAt = performance.now();
        });
      });
      await page.goto(server.base);
      const detail = await api(page, `/loops/${server.data.perfLoop}`);
      assert.equal(detail.iteration, 4); assert.equal(detail.steps.length, 12);
      for (const kind of ['loop', 'flow']) {
        const samples = [];
        for (let n = 0; n < 12; n++) {
          await page.evaluate(() => { location.hash = '#bots'; }); await page.waitForURL(/#bots$/);
          await page.locator('.ho-loop-timeline, .flow-chart').waitFor({ state: 'detached' });
          const config = kind === 'loop' ? { api: `/api/loops/${server.data.perfLoop}`, selector: '.ho-loop-timeline > li:nth-child(4)', hash: `#loop/${server.data.perfLoop}` } : { api: `/api/bots/${server.data.maker}/flow`, selector: '.flow-chart', hash: `#bot/${server.data.maker}/details/flow` };
          await page.evaluate(config => { window.hohMeasure = config; location.hash = config.hash; }, config);
          await page.waitForFunction(() => window.hohMeasure.elapsed !== undefined);
          // Exclude the first route load (Vite transforms are development-only).
          if (n) samples.push(await page.evaluate(() => window.hohMeasure.elapsed));
        }
        record(`${kind === 'loop' ? 'loopRender12Steps' : 'flowPaint'}-${width}`, samples, kind === 'loop' ? 300 : 50);
      }
      const loop = await startLoop(page, server.data, 'slow');
      const updates = [];
      for (let n = 0; n < 6; n++) {
        const status = n % 2 ? 'running' : 'paused', action = n % 2 ? 'resume' : 'pause';
        await page.evaluate(({ id, status }) => { window.hohMeasure = { event: true, id, status, selector: `.ho-loop-status-${status}` }; }, { id: loop, status });
        await api(page, `/loops/${loop}/${action}`, 'POST', {});
        await page.waitForFunction(() => window.hohMeasure.elapsed !== undefined);
        updates.push(await page.evaluate(() => window.hohMeasure.elapsed));
      }
      record(`timelineSse-${width}`, updates, 100);
      await api(page, `/loops/${loop}/stop`, 'POST', {});
    } finally { await view.close(); }
  }
} finally {
  await server.close();
  const report = { measuredAt: new Date().toISOString(), metrics, notes: ['Local seeded app; rendering fixture has 4 iterations and 12 completed steps.', 'Browser timings run from API response or SSE event to the second animation frame after the matching DOM appears.', 'One cold development module transform is excluded. No API responses are replaced.'] };
  fs.writeFileSync(path.join(evidence, 'browser.json'), JSON.stringify(report, null, 2) + '\n');
  const backend = JSON.parse(fs.readFileSync(path.join(evidence, 'server.json'), 'utf8'));
  const baseline = { ...backend, browser: report };
  fs.writeFileSync(path.join(evidence, 'measured.json'), JSON.stringify(baseline, null, 2) + '\n');
  if (process.env.HANDOFFS_UPDATE_BASELINE === '1') fs.writeFileSync('tests/handoffs/perf/baseline.json', JSON.stringify(baseline, null, 2) + '\n');
}
assert.ok(Object.values(metrics).every(m => m.pass), 'All measured browser budgets must pass');
console.log(`PASS browser performance: ${Object.keys(metrics).length} budgets`);

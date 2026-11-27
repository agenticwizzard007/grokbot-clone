import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
if (!process.env.HO_H_PERF_CHILD) {
  const child = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1]], { stdio: 'inherit', env: { ...process.env, HO_H_PERF_CHILD: '1' } }); process.exit(child.status ?? 1);
}
const { fixture, output, hooks, jobs, app, db, cleanup } = await import('../server-fixture.test.mts');
const { flowApi } = await import('../../../server/src/flow/routes.ts');
const { Hono } = await import('hono');
const flowApp = new Hono().route('/api', flowApi);
const report = { measuredAt: new Date().toISOString(), environment: `${process.platform} ${process.arch} ${process.version}`, metrics: {} };
const p95 = xs => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * .95) - 1];
const measure = async (name, limit, fn, count = 50) => {
  const samples = []; for (let i = 0; i < count; i++) { const start = performance.now(); await fn(i); samples.push(performance.now() - start); }
  report.metrics[name] = { p95: p95(samples), budget: limit, unit: 'ms', samples: count, pass: p95(samples) < limit };
  console.log(`${report.metrics[name].pass ? 'PASS' : 'FAIL'} ${name}: p95 ${p95(samples).toFixed(2)} ms < ${limit} ms`);
};
try {
  const f = fixture();
  const work = Array.from({ length: 50 }, () => { const job = jobs.acceptJob(f.maker.id, { type: 'user' }); jobs.beginJob(job.id); jobs.finishJob(job.id, true); return job; });
  await measure('outputCreation', 20, i => hooks.onJobFinished({ userId: f.userId, botId: f.maker.id, jobId: work[i].id, status: 'completed', finalText: `Placeholder result ${i}.` }));
  const o = output(f);
  await measure('handoffPost', 80, async i => { const r = await app.request('/api/handoffs', { method: 'POST', headers: f.headers, body: JSON.stringify({ source: { outputId: o.id }, toBotId: f.checker.id, instruction: 'Review placeholder.', idempotencyKey: `perf-${i}` }) }); assert.equal(r.status, 201); });
  await measure('flowCold', 150, async () => { db.prepare('DELETE FROM bot_flow_cache WHERE bot_id=?').run(f.maker.id); const r = await flowApp.request(`/api/bots/${f.maker.id}/flow`, { headers: f.headers }); assert.equal(r.status, 200); });
  await measure('flowWarm', 15, async () => { const r = await flowApp.request(`/api/bots/${f.maker.id}/flow`, { headers: f.headers }); assert.equal(r.status, 200); });
  const manifest = JSON.parse(fs.readFileSync('web/dist/.vite/manifest.json', 'utf8'));
  const entry = manifest['index.html'];
  const staticFiles = new Set();
  const visit = key => { const value = manifest[key]; if (!value || staticFiles.has(value.file)) return; staticFiles.add(value.file); for (const child of value.imports ?? []) visit(child); };
  visit('index.html');
  const bytes = [...staticFiles].reduce((sum, file) => sum + gzipSync(fs.readFileSync(path.join('web/dist', file))).length, 0);
  for (const route of ['src/handoffs/loops/LoopRun.tsx', 'src/handoffs/loops/LoopsPage.tsx', 'src/handoffs/HandoffDetail.tsx', 'src/handoffs/OutputViewer.tsx', 'src/flow/FlowTab.tsx']) {
    assert.equal(manifest[route]?.isDynamicEntry, true, `Lazy route ${route}`);
    assert.equal(staticFiles.has(manifest[route].file), false, `Route excluded from entry imports: ${route}`);
  }
  const unchanged = spawnSync('git', ['diff', '--quiet', 'origin/main', '--', 'web', 'package-lock.json'], { encoding: 'utf8' });
  assert.equal(unchanged.status, 0, 'Zero added entry bytes requires unchanged web source and dependencies versus origin/main. Measure both builds if production code differs.');
  const base = spawnSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' });
  assert.equal(base.status, 0);
  report.bundle = { entry: entry.file, entryGzipBytes: bytes, baseRevision: base.stdout.trim(), comparison: 'Verified unchanged web source and lockfile versus main after HO integration. This measures HO-H additions, not the total historical HO feature cost.', addedEntryGzipBytes: 0, budgetBytes: 40 * 1024, pass: true,
    lazyRoutes: Object.entries(manifest).filter(([name]) => /handoffs|flow/.test(name)).map(([name, value]) => ({ name, file: value.file, gzipBytes: gzipSync(fs.readFileSync(path.join('web/dist', value.file))).length })) };
} finally {
  cleanup(); fs.mkdirSync('.context/handoffs/perf-h', { recursive: true });
  fs.writeFileSync('.context/handoffs/perf-h/server.json', JSON.stringify(report, null, 2) + '\n');
}
assert.ok(Object.values(report.metrics).every(metric => metric.pass));
console.log(`PASS performance server: ${Object.keys(report.metrics).length + 1} budgets`);

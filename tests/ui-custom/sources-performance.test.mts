import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { seedDashboard, dashboardParams } from '../fixtures/dashboard.seed.mts';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-sources-perf-'));
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(temp, 'test.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'),
  SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'fixture-session', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0',
  DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', COMPOSIO_API_KEY: '', APP_URL: 'http://localhost:1', SERVER_URL: 'http://localhost:1' });
const fixture = await seedDashboard({ performance: true });
const { db } = await import('../../server/src/db.js');
const { DataExecutor } = await import('../../server/src/ui/sources/executor.js');
const { SOURCES } = await import('../../server/src/ui/sources/catalog.js');
const { createDataApi } = await import('../../server/src/ui/data-routes.js');
const { Hono } = await import('hono');
let clock = Date.now();
const executor = new DataExecutor(() => clock);
const app = new Hono().route('/api/ui', createDataApi({ executor, clock: () => clock, enabled: () => true }));
after(() => { executor.close(); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

test('24 source requests meet p95 below 150 ms with 10000 tasks, 100 Bots and 90 days of usage', async () => {
  assert.equal(fixture.taskCount, 10000); assert.equal(fixture.botCount, 100);
  const requests = [
    ...SOURCES.slice(0, 14).map(source => ({ key: source.id, source: source.id, params: dashboardParams(source.id) })),
    ...['today', '30d', 'month'].flatMap(range => [
      { key: `summary-${range}`, source: 'usage.summary', params: { range } },
      { key: `series-${range}`, source: 'tasks.series', params: { range } },
      { key: `runs-${range}`, source: 'runs.series', params: { range, group: 'day' } },
    ]),
    { key: 'usage-tokens', source: 'usage.series', params: { range: '30d', metric: 'tokens' } },
  ];
  assert.equal(requests.length, 24);
  const samples: number[] = [];
  for (let n = 0; n < 21; n++) {
    // Expire result caches between samples. The process is warm after sample zero.
    clock += 10_000;
    const start = performance.now();
    const response = await app.request('/api/ui/data', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `swarm_session=${fixture.users[0].token}` }, body: JSON.stringify({ requests }) });
    assert.equal(response.status, 200);
    const { results } = await response.json();
    const elapsed = performance.now() - start;
    assert.ok(Object.values(results).every((result: any) => result.ok), JSON.stringify(results));
    assert.equal(results['tasks.counts'].count, 10000);
    if (n) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  const report = { tasks: 10000, bots: 100, usageDays: 90, requestsPerBatch: 24, samples: samples.length, cache: 'expired between samples', p95Ms: p95, budgetMs: 150 };
  const out = path.resolve('.context/ui-custom/demo-f-server'); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'performance.json'), JSON.stringify(report, null, 2));
  console.log(`DATA PERFORMANCE: ${samples.length} batches, 24 requests, p95 ${p95.toFixed(2)} ms, budget 150 ms`);
  assert.ok(p95 < 150, `p95 ${p95.toFixed(2)} ms exceeds 150 ms`);
});

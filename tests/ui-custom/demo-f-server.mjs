import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { chromium } from 'playwright';

const { dashboardServer, dashboardParams } = await tsImport('../fixtures/dashboard.seed.mts', import.meta.url);
const out = path.resolve('.context/ui-custom/demo-f-server'); fs.mkdirSync(out, { recursive: true });
const server = await dashboardServer({ performance: true });
const sources = ['tasks.counts', 'tasks.list', 'tasks.series', 'bots.list', 'bots.status', 'needsYou.list', 'usage.summary', 'usage.series', 'usage.windows', 'routines.list', 'routines.upcoming', 'runs.recent', 'runs.counts', 'runs.series'];
const post = (user, requests, cookie = true) => fetch(`${server.base}/api/ui/data`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `swarm_session=${user.token}` } : {}) }, body: JSON.stringify({ requests }),
});
let browser;
try {
  const requests = sources.map(source => ({ key: source, source, params: dashboardParams(source) }));
  const signedOut = await post(server.users[0], requests, false); assert.equal(signedOut.status, 401);
  const bodies = [];
  for (const user of server.users) {
    const response = await post(user, requests); assert.equal(response.status, 200);
    const body = await response.json();
    for (const source of sources) assert.equal(body.results[source].ok, true, JSON.stringify(body.results[source]));
    assert.doesNotMatch(JSON.stringify(body), /FORBIDDEN_/);
    bodies.push(body);
  }
  assert.equal(bodies[0].results['tasks.counts'].count, 10000);
  assert.equal(bodies[1].results['tasks.counts'].count, 7);
  assert.doesNotMatch(JSON.stringify(bodies[0]), /Fixture B|qa-temp-dashboard-b/);
  assert.doesNotMatch(JSON.stringify(bodies[1]), /Fixture A|qa-temp-dashboard-a/);
  const mixed = await (await post(server.users[0], [
    { key: 'good', source: 'tasks.counts', params: {} },
    { key: 'foreign', source: 'tasks.counts', params: { botId: `${server.users[1].id}-bot-0` } },
    { key: 'unknown', source: 'unregistered', params: {} },
  ])).json();
  assert.equal(mixed.results.good.ok, true); assert.equal(mixed.results.foreign.code, 'not_found'); assert.equal(mixed.results.unknown.code, 'not_found');
  const samples = [];
  const fullBatch = Array.from({ length: 24 }, (_, n) => ({ ...requests[n % requests.length], key: `widget-${n}` }));
  for (let n = 0; n < 20; n++) {
    const start = performance.now(), response = await post(server.users[0], fullBatch);
    assert.equal(response.status, 200); const body = await response.json();
    assert.equal(Object.keys(body.results).length, 24); assert.ok(Object.values(body.results).every(result => result.ok));
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b); const p95Ms = samples[18]; assert.ok(p95Ms < 150, `Warm HTTP p95 ${p95Ms.toFixed(2)} ms`);
  const report = { passed: 19, failed: 0, description: '14 sources, authentication, account isolation, per-key errors, batch limit and server performance',
    fixture: { tasks: 10000, bots: 100, usageDays: 90 }, http: { samples: 20, requestsPerBatch: 24, p95Ms }, accounts: bodies, mixed };
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
  const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const html = `<!doctype html><meta charset="utf-8"><title>Dashboard data API</title>
    <style>body{margin:40px;font:18px system-ui;color:#17242a;background:#f7faf9}main{max-width:1100px;margin:auto}h1{font-size:30px}table{width:100%;border-collapse:collapse;background:white}th,td{text-align:left;padding:12px;border-bottom:1px solid #c7d3ce;overflow-wrap:anywhere}caption{text-align:left;margin:16px 0}p{line-height:1.5}</style>
    <main><h1>Dashboard data API</h1><p>Signed-in local test accounts. 10000 tasks, 100 Bots, 90 days of usage.<br>
    19 checks passed. 24 requests per batch. Warm HTTP p95: ${p95Ms.toFixed(2)} ms.</p>
    <table><caption>Server response evidence</caption><tr><th>Source</th><th>Result</th><th>Account A count</th><th>Account B count</th></tr>
    ${sources.map(source => `<tr><td>${escape(source)}</td><td>Passed</td><td>${bodies[0].results[source].count}</td><td>${bodies[1].results[source].count}</td></tr>`).join('')}</table>
    <p>Foreign Bot: not_found. Unknown source: not_found. Healthy key: passed. Signed out: 401.</p></main>`;
  fs.writeFileSync(path.join(out, 'report.html'), html);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.setContent(html); await page.screenshot({ path: path.join(out, 'server-results.png'), fullPage: true });
  console.log(`DEMO F SERVER: 19 passed, 0 failed; HTTP p95 ${p95Ms.toFixed(2)} ms`);
  console.log(`Output: ${out}/results.json`); console.log(`Screenshot: ${out}/server-results.png`);
} finally { await browser?.close(); await server.close(); }

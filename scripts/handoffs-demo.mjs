import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, browserSession, api, screenshot } from '../tests/handoffs/e2e/fixture.mjs';
import { runUiQuality, assertVisibleCopy } from '../tests/handoffs/e2e/visual-quality.mjs';
import { recordLoop, sendHandoff } from '../tests/handoffs/e2e/loop-journey.mjs';

const evidence = path.resolve(process.env.HANDOFFS_EVIDENCE || '.context/handoffs/demo-h');
fs.mkdirSync(evidence, { recursive: true });
const remote = process.env.BASE_URL;
if (remote) for (const key of ['HANDOFFS_TEST_SESSION', 'HANDOFFS_TEST_USER_ID', 'HANDOFFS_TEST_MAKER', 'HANDOFFS_TEST_CHECKER']) assert.ok(process.env[key], `Missing ${key}`);
if (remote) assert.equal(process.env.HANDOFFS_TEST_PROVIDER, 'scripted', 'Deployed test account must use the handoff scripted mock provider');
const server = remote ? { base: remote, token: process.env.HANDOFFS_TEST_SESSION,
  data: { maker: process.env.HANDOFFS_TEST_MAKER, checker: process.env.HANDOFFS_TEST_CHECKER }, close: async () => {} } : await fixture(evidence);
const uiQuality = await runUiQuality(evidence);
const report = { uiQuality, passed: 0, failed: 0, mode: remote ? 'deployed test account' : 'seeded local', runs: [], handoffs: [], screenshots: [] };
try {
  for (const theme of ['light', 'dark']) for (const width of [320, 390, 500, 1280]) {
    const view = await browserSession(server, width, { theme }), { page } = view;
    try {
      await page.goto(server.base);
      if (remote) {
        const { user } = await api(page, '/auth/me'); assert.equal(user?.id, process.env.HANDOFFS_TEST_USER_ID, 'Test account identity');
        const response = await api(page, '/bots'), bots = response.bots ?? response;
        for (const [id, name] of [[server.data.maker, 'Maker'], [server.data.checker, 'Checker']]) assert.ok(bots.some(b => b.id === id && b.name === name && b.kind !== 'room'), `Expected test Bot ${name}`);
      }
      const handoff = await sendHandoff(page, server.data, evidence, width);
      report.handoffs.push({ width, theme, ...handoff }); report.screenshots.push(...handoff.screenshots); report.passed++;
      for (const mode of ['converge', 'cap']) {
        const run = await recordLoop(page, server.data, mode, evidence, width);
        report.runs.push({ ...run, theme }); report.screenshots.push(...run.screenshots); report.passed++;
        console.log(`PASS ${width} ${theme} ${mode}: ${run.result}`);
      }
      await page.goto(`${server.base}/#bot/${server.data.maker}/details/flow`);
      await page.locator('.flow-chart').waitFor();
      report.screenshots.push(await screenshot(page, evidence, 'maker-flow', width)); report.passed++;
      await assertVisibleCopy(page); assert.deepEqual(view.errors, []);
    } catch (error) {
      report.failed++; report.error = error.stack;
      await page.screenshot({ path: path.join(evidence, `failure-${width}-${theme}.png`), fullPage: true });
      fs.writeFileSync(path.join(evidence, `failure-${width}-${theme}.html`), await page.content()); throw error;
    } finally { await view.close(); }
  }
  if (server.requests) { const requests = await server.requests(); report.providerRequests = requests.length; fs.writeFileSync(path.join(evidence, 'provider-requests.json'), JSON.stringify(requests, null, 2)); }
  assert.notEqual(uiQuality.status, 'fail', 'HO-P UI quality gate');
  const qualityFiles = report.screenshots.map(file => file.replace(/\.png$/, '.quality.json'));
  report.visualQuality = qualityFiles.map(file => ({ file, ...JSON.parse(fs.readFileSync(file, 'utf8')) }));
  assert.deepEqual(report.visualQuality.flatMap(item => item.issues), [], 'Every demo capture meets the minimum type scale');
  console.log(`PASS demo of record: ${report.passed} checks, ${report.failed} failures. ${path.join(evidence, 'report.json')}`);
} finally { fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n'); await server.close(); }

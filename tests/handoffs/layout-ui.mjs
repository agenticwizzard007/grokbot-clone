import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
import { readableWords } from '../paper-label-geometry.mjs';
import { checkAccessibility } from './ui-d-fixture.mjs';
import { inspectFlowAccessibility } from '../flow/accessibility.mjs';
import { fixture, browserSession, api } from './e2e/fixture.mjs';
import { sendHandoff, startLoop } from './e2e/loop-journey.mjs';

export async function auditRoute(page, width) {
  await page.evaluate(() => document.fonts.ready);
  const selector = await page.locator('main.paper-shell').count() ? 'main.paper-shell' : '.shell-content > :not(.shell-header):not(.phone-tabs)';
  assert.deepEqual(await page.evaluate(inspectAlignment, { selector }), [], 'Shared Paper alignment checker');
  await page.getByText('Loading loops', { exact: true }).waitFor({ state: 'hidden' });
  // The existing handoff helper exempts expandable summaries, never labels.
  for (const label of await page.locator(`${selector} :is(button,a,label,h1,h2,.layout-row):not(.flow-sr):not(.sr-only):visible`).elementHandles()) await readableWords(label);
  try { await checkAccessibility(page); }
  catch (error) {
    // The composer's autosize textarea is clipped inside an aria-hidden probe and is
    // not focusable. Older shared fallback checks mistake it for a control.
    if (!Array.isArray(error.actual) || !error.actual.length || error.actual.some(html => !html.startsWith('<textarea tabindex="-1"'))) throw error;
    const hidden = await page.locator('textarea[tabindex="-1"]').evaluateAll(nodes => nodes.every(el => !!el.closest('[aria-hidden="true"]') && getComputedStyle(el).visibility === 'hidden' && el.tabIndex < 0));
    if (!hidden) throw error;
  }
  if (await page.locator('.flow-tab').count()) assert.deepEqual(await page.evaluate(inspectFlowAccessibility), []);
  if (width <= 760) assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1, 'One Back on phone');
}
export async function auditRoutes(page, server, width, ids) {
  const checks = [], settings = fs.readFileSync('web/src/components/config/settingsNavigation.tsx', 'utf8');
  const routes = [ ['#loops', '.ho-loop-heading'], [`#loop/${ids.loop}`, '[data-loop-revision]'],
    [`#handoff/${ids.handoff}`, '.ho-heading'], [`#output/${ids.output}`, '.ho-prose'],
    [`#bot/${server.data.maker}/details/flow`, '.flow-chart'] ];
  if (/['"]agents['"]/.test(settings)) routes.push(['#settings/agents', '.ho-settings']);
  else checks.push({ route: '#settings/agents', status: 'skip', reason: 'HO-I stage 2 has not merged: Settings Agents route is absent.' });
  for (const [route, marker] of routes) {
    try {
      await page.goto(`${server.base}/${route}`); await page.locator(marker).first().waitFor(); await auditRoute(page, width);
      // Warm hash route and browser navigation use the same real entry point.
      await page.evaluate(() => { location.hash = '#bots'; }); await page.waitForURL(/#bots$/);
      await page.goBack(); await page.locator(marker).first().waitFor(); await auditRoute(page, width);
      await page.reload(); await page.locator(marker).first().waitFor(); await auditRoute(page, width);
      checks.push({ route, status: 'pass', modes: ['cold', 'warm', 'reload'] });
    } catch (error) { checks.push({ route, status: 'fail', error: error.message }); }
  }
  return checks;
}
export async function runLayout() {
  const evidence = path.resolve('.context/handoffs/layout-h'), server = await fixture(evidence), results = [];
  try {
    for (const width of [390, 1280]) {
      const view = await browserSession(server, width), { page } = view;
      try {
        await page.goto(server.base);
        const handoff = await sendHandoff(page, server.data, evidence, width);
        const loop = await startLoop(page, server.data, 'slow');
        await page.getByRole('button', { name: 'Stop', exact: true }).click();
        await page.getByText('Stopped by you.', { exact: true }).waitFor();
        const output = (await api(page, `/handoffs/${handoff.id}`)).sourceOutputId;
        results.push(...(await auditRoutes(page, server, width, { loop, handoff: handoff.id, output })).map(r => ({ width, ...r })));
      } finally { await view.close(); }
    }
  } finally { await server.close(); fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(results, null, 2)); }
  const failed = results.filter(r => r.status === 'fail');
  console.log(`HO-H layout: ${results.filter(r => r.status === 'pass').length} pass, ${failed.length} fail, ${results.filter(r => r.status === 'skip').length} skip`);
  for (const failure of failed) console.error(JSON.stringify(failure));
  assert.equal(failed.length, 0);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await runLayout();

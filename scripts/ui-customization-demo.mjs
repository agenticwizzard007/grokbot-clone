// Full product story, always on a disposable seeded server and scripted mock provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSuite, fixtureContext, configAvailable, open, snapshot, api, button, requireModules, until } from '../tests/ui-custom/fixtures/harness.mjs';
import { reset, themeJourney, dashboardJourney, recoveryJourney } from '../tests/ui-custom/e2e/journeys-ui.mjs';

export async function runStory() {
  const screenshots = [];
  const result = await runSuite('story', [390, 1280].map(width => ({ name: `product story ${width}`, run: async ({ server, browser, out }) => {
    const { context, external } = await fixtureContext(browser, server, width);
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      await open(page, server.base);
      const baseline = await snapshot(page, out, `baseline-${width}`);
      screenshots.push({ step: 'baseline only', width, file: baseline });
      await configAvailable(context.request, server.base);
      requireModules('web/src/components/config/AppearanceSettings.tsx');
      await reset(context, server);
      const capture = async step => screenshots.push({ step, width, file: await snapshot(page, out, `${width}-${step}`) });
      const args = { page, context, server, capture };
      await themeJourney(args);
      await dashboardJourney(args);
      const current = await configAvailable(context.request, server.base);
      await api(context.request, server.base, '/undo', 'POST', { steps: 1 }, 200, current.revision);
      await capture('dashboard-undo');
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await open(page, server.base, '#settings/appearance'); await capture('appearance');
      await reset(context, server); await capture('reset');
      await recoveryJourney(args);
      assert.deepEqual(external, [], 'Story must use only local assets');
    } finally { await context.close(); }
  } })));
  fs.writeFileSync(path.join(result.out, 'manifest.json'), JSON.stringify({
    status: result.counts.fail ? 'failed' : result.counts.skip ? 'pending dependencies' : 'complete',
    counts: result.counts, screenshots,
    note: 'Baseline screenshots do not establish customization acceptance. See report.json for skipped dependencies.',
  }, null, 2) + '\n');
  console.log(`Story manifest: ${result.out}/manifest.json`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runStory();

// Product story uses disposable fixture accounts and the scripted mock provider only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSuite, fixtureContext, open, snapshot, api } from '../tests/ui-custom/fixtures/harness.mjs';
import { reset, dashboardJourney, recoveryJourney } from '../tests/ui-custom/e2e/journeys-ui.mjs';
import { requirementsUseCases, requirementsChangeReset } from '../tests/ui-custom/e2e/requirements-journeys.mjs';

import { inspectScreenQuality } from '../tests/ui-custom/e2e/screen-quality.mjs';

export async function runStory() {
  const screenshots = [];
  const stories = [
    ['dashboard chat and persistence', async args => {
      await dashboardJourney(args);
      await api(args.context.request, args.server.base, '/undo', 'POST', { steps: 1 });
      await args.page.reload(); await args.page.locator('.shell-header').waitFor();
      await args.capture('dashboard-resize-undo');
    }],
    ['requirements use cases', requirementsUseCases],
    ['requirements change and reset', requirementsChangeReset],
    ['safe mode recovery', recoveryJourney],
  ];
  const result = await runSuite('story', [390, 1280].flatMap(width => stories.map(([name, run]) => ({ name: `${name} ${width}`, run: async ({ server, browser, out }) => {
    const { context, external } = await fixtureContext(browser, server, width);
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      await reset(context, server); await open(page, server.base);
      const capture = async step => {
        const file = await snapshot(page, out, `${width}-${step}`);
        screenshots.push({ step, width, file });
        assert.deepEqual(await page.evaluate(inspectScreenQuality, { selector: 'body', typography: false }), [], `Visible test text in ${step}`);
      };
      await run({ page, context, server, capture });
      assert.deepEqual(external, [], 'Story must use only local assets');
    } finally { await context.close(); }
  } }))));
  fs.writeFileSync(path.join(result.out, 'manifest.json'), JSON.stringify({
    status: result.counts.fail ? 'failed' : result.counts.skip ? 'pending dependencies' : 'complete',
    counts: result.counts, screenshots,
    note: 'Only listed steps were captured. Skipped journeys do not satisfy acceptance.',
  }, null, 2) + '\n');
  console.log(`Story manifest: ${result.out}/manifest.json`);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runStory();

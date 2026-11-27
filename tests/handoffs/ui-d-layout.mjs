import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, checkAccessibility, checkLayout } from './ui-d-fixture.mjs';

const evidence = path.resolve('.context/ho-d/layout'); fs.mkdirSync(evidence, { recursive: true });
const f = await fixture(), report = [];
try {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    for (const view of ['card', 'sheet', 'row', 'detail', 'viewer', 'list', 'settings']) {
      for (const state of view === 'row' ? ['ready', 'error'] : ['ready', 'loading', 'empty', 'error']) {
        const page = await f.page({ view, state, width, theme });
        try {
          await checkLayout(page);
          const accessibility = await checkAccessibility(page);
          if (['detail', 'viewer'].includes(view)) assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
          const screenshot = path.join(evidence, `${view}-${state}-${width}-${theme}.png`);
          await page.screenshot({ path: screenshot, fullPage: true });
          report.push({ width, theme, view, state, accessibility, screenshot });
          console.log(`PASS ${view} ${state} ${width} ${theme}: alignment, ${accessibility}`);
        } finally { await page.close(); }
      }
    }
  }
} finally { await f.close(); fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(`PASS ${report.length}/${report.length} handoff component views`);

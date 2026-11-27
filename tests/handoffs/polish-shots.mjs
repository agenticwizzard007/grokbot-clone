import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { polishFixture, screens } from './polish-fixture.mjs';
import { runQuality } from './ui-quality.mjs';

export async function captureShots({ phase = process.env.HO_POLISH_PHASE || 'after', output = process.env.HO_POLISH_OUTPUT || '/workspace/swarm-qa/handoffs/shots/polish' } = {}) {
  fs.mkdirSync(output, { recursive: true });
  const fixture = await polishFixture(), report = [];
  try {
    for (const name of screens.slice(0,15)) for (const width of ['receipt','loop-timeline','flow-tab'].includes(name) ? [320,390,500,1280] : [390,1280]) {
      const state = await fixture.open(name, width, 'light');
      const { page } = state;
      if (['receipt','loop-timeline','loop-graph','flow-tab'].includes(name)) {
        const height = await page.locator('.transcript, .ho-route, .flow-page').evaluateAll(els => Math.max(...els.map(el => el.scrollHeight)));
        if (height > 1000) await page.setViewportSize({width,height:Math.min(5000,height+160)});
      }
      await page.locator(state.selector).first().scrollIntoViewIfNeeded();
      const file = path.join(output, `${name}-${width}-${phase}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const wordsIn = selector => page.locator(selector).evaluateAll(els => els.map(el => el.innerText).join(' ').trim().split(/\s+/).filter(Boolean).length);
      const words = await wordsIn(name === 'sidebar-loops' ? '.sidebar [role="menu"]' : state.selector);
      const dialog = page.locator('dialog[open], [role="dialog"]:visible');
      const mainWords = await wordsIn(name === 'sidebar-loops' ? '.sidebar [role="menu"]' : await dialog.count() ? 'dialog[open], [role="dialog"]:visible' : await page.locator('.shell-content').count() ? '.shell-content' : '#root');
      report.push({ name, width, file, words, mainWords }); console.log(`PASS ${name} ${width} ${phase}`);
      await state.close();
    }
  } finally { await fixture.close(); fs.writeFileSync(path.join(output, `${phase}.json`), JSON.stringify(report, null, 2)); }
  console.log(`POLISH SHOTS ${report.length} passed, 0 failed. Output: ${output}/${phase}.json`);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await captureShots();
  if (process.env.HO_POLISH_PHASE !== 'before') await runQuality();
}

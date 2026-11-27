import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { clientFixture, signedInPage, patch } from './unit/client-fixture.mjs';
const { presetConfig } = await tsImport('../../server/src/ui-config/presets.ts', import.meta.url);
const output = path.resolve('.context/ui-custom/demo-d'); fs.mkdirSync(output, { recursive: true });
const server = await clientFixture(), browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const images = [], results = [];
try {
  const { page } = await signedInPage(browser, server);
  const screenshot = async name => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(120); const file = `${name}.png`; await page.screenshot({ path: path.join(output, file) }); images.push(file); };
  const teal = presetConfig('forest'); teal.theme.mode = 'dark';
  const serif = presetConfig('paper'); serif.theme.font.scale = 'xlarge'; serif.theme.density = 'comfortable';
  for (const [name, doc] of [['teal-dark', teal], ['serif-xlarge-comfortable', serif], ['high-contrast', presetConfig('contrast')]]) {
    const result = await patch(page, [{ op: 'replace', path: '/preset', value: doc.preset }, { op: 'replace', path: '/theme', value: doc.theme }]);
    results.push({ name, revision: result.revision });
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: width < 760 ? 844 : 900 });
      for (const [route, hash] of [['bots', '#bots'], ['chat', `#bot/${server.fixture.bot.id}`]]) {
        await page.goto(`${server.base}/${hash}`); await page.locator(route === 'chat' ? '.composer__input' : '.pb-bots').waitFor();
        await screenshot(`${name}-${route}-${width}`); console.log(`PASS demo ${name} ${route} ${width}`);
      }
    }
  }
  const preview = await server.preview([{ op: 'replace', path: '/theme/mode', value: 'dark' }], 'Dark mode preview');
  assert.equal(preview.ok, true); await page.getByRole('status', { name: 'Appearance preview' }).waitFor();
  for (const width of [390, 1280]) { await page.setViewportSize({ width, height: width < 760 ? 844 : 900 }); await screenshot(`preview-${width}`); }
  await page.getByRole('status', { name: 'Appearance preview' }).getByRole('button', { name: 'Discard', exact: true }).click();
  await page.getByRole('status', { name: 'Appearance preview' }).waitFor({ state: 'hidden' }); console.log('PASS demo discard');
  await page.goto(`${server.base}/?ui=safe#bots`); await page.getByRole('status', { name: 'Appearance recovery' }).waitFor();
  for (const width of [390, 1280]) { await page.setViewportSize({ width, height: width < 760 ? 844 : 900 }); await screenshot(`safe-mode-${width}`); }
  console.log('PASS demo safe mode');
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: 15, configs: results, screenshots: images }, null, 2));
  const sheet = await browser.newPage({ viewport: { width: 1560, height: 1200 } });
  await sheet.setContent(`<html><head><style>body{margin:0;padding:16px;background:#edf0f3;font:16px system-ui}main{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}figure{margin:0;background:white;padding:8px}img{width:100%;height:420px;object-fit:contain;object-position:top}figcaption{min-height:44px;overflow-wrap:anywhere}</style></head><body><h1>Client runtime</h1><main>${images.map(name => `<figure><img src="data:image/png;base64,${fs.readFileSync(path.join(output, name)).toString('base64')}"><figcaption>${name.replace('.png', '')}</figcaption></figure>`).join('')}</main></body></html>`);
  await sheet.screenshot({ path: path.join(output, 'contact-sheet.png'), fullPage: true }); await sheet.close();
  console.log(`Demo D: 15/15 passed. Output: ${output}`);
} finally { await browser.close(); await server.close(); }

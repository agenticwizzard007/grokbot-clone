import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { layoutServer } from '../../layout-fixture.mjs';
const root = path.resolve('.'), output = path.join(root, '.context/ui-custom/contracts'); fs.mkdirSync(output, { recursive: true });
const probe = path.join(output, 'browser-probe.ts');
fs.writeFileSync(probe, `import { DEFAULT_CONFIG, MemoryUiConfigService, REGISTRY, effectiveTokens, previewPatch, type UiConfig, type PatchOp } from '@shared/ui-config';
export function run() {
  const doc: UiConfig = structuredClone(DEFAULT_CONFIG);
  const ops: PatchOp[] = [{ op: 'replace', path: '/theme/mode', value: 'dark' }];
  const service = new MemoryUiConfigService();
  return { light: effectiveTokens(doc, 'light'), dark: effectiveTokens(doc, 'dark'), result: previewPatch(doc, ops, { ctx: {} }), widgets: REGISTRY.widgets.length, sources: REGISTRY.sources.length, saved: service.get('QA-Temp-browser') };
}
`);
fs.writeFileSync(path.join(output, 'tsconfig.json'), JSON.stringify({ extends: '../../../web/tsconfig.json', compilerOptions: { types: [] }, include: ['./browser-probe.ts'] }));
const types = spawnSync(process.execPath, [path.join(root, 'web/node_modules/typescript/bin/tsc'), '-p', path.join(output, 'tsconfig.json')], { encoding: 'utf8' });
assert.equal(types.status, 0, types.stdout + types.stderr); console.log('PASS browser @shared/ui-config TypeScript contract');
const server = await layoutServer();
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => { const url = new URL(route.request().url()); return ['127.0.0.1', 'localhost'].includes(url.hostname) ? route.continue() : route.abort(); });
    await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
    await context.addInitScript(() => localStorage.setItem('swarm.theme', 'light'));
    const page = await context.newPage(); await page.goto(`${server.base}/#bots`); await page.locator('[data-layout="page"]:visible').first().waitFor();
    const result = await page.evaluate(async url => (await import(url)).run(), `/@fs${probe}`);
    assert.deepEqual(result.light, {}); assert.deepEqual(result.dark, {}); assert.equal(result.widgets, 10); assert.equal(result.sources, 14); assert.equal(result.result.ok, true); assert.equal(result.saved.revision, 0);
    await page.evaluate(() => document.fonts.ready); await page.screenshot({ path: path.join(output, `default-${width}.png`), fullPage: true });
    fs.writeFileSync(path.join(output, `browser-${width}.json`), JSON.stringify(result, null, 2));
    console.log(`PASS browser engine import and default UI at ${width}`); await context.close();
  }
} finally { await browser?.close(); await server.close(); }
console.log('Browser contracts: 3/3 passed');

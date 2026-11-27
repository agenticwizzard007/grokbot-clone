import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { shellFixture } from './shell-fixture.mjs';
import { ROUTES, inspectAlignment } from '../layout-alignment-ui.mjs';
import { preparePbeState } from '../paper-pbe-states.mjs';
const { presetPatch } = await tsImport('../../server/src/ui-config/presets.ts', import.meta.url);
const server = await shellFixture();
const output = path.resolve('.context/ui-custom/e-presets'); fs.mkdirSync(output, { recursive: true });
const results = [];
try {
  for (const preset of ['focus', 'calm']) {
    await server.patch(presetPatch(preset));
    for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
      await server.patch([{ op: 'replace', path: '/theme/mode', value: theme }]);
      const page = await server.page(width, theme);
      for (const route of ROUTES.filter(route => route.enforce)) {
        const hash = route.hash.replace('{bot}', server.fixture.bot.id).replace('{room}', server.fixture.room);
        let issues;
        try {
          if (route.signedOut) {
            await page.context().clearCookies();
            if (route.code) await page.route('**/api/auth/phone/start', r => r.fulfill({ json: { id: 'fixture-code', delivery: 'sent', textNumber: null, line: null } }));
            await page.goto('about:blank'); await page.goto(`${server.base}/${hash.replace(/^\//, '')}`);
            await page.locator('.signin, .access-signin, .join').first().waitFor();
            if (route.code) { await page.locator('input[type=tel]').fill('+15555550123'); await page.getByRole('button', { name: 'Continue with phone', exact: true }).click(); await page.getByRole('textbox', { name: '6-digit code' }).waitFor(); }
          } else await server.open(page, hash);
          if (route.state) await preparePbeState(page, route.state, server.fixture.bot.id);
          await page.locator(route.hash.includes('/details/') ? '.pb-details [data-layout="page"]:visible' : '[data-layout="page"]:visible').first().waitFor();
          await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(100);
          issues = await page.evaluate(inspectAlignment);
        } catch (error) { issues = [error.message.split('\n')[0]]; }
        results.push({ preset, route: route.name, width, theme, issues });
        console.log(`${issues.length ? 'FAIL' : 'PASS'} ${preset} ${route.name} ${width} ${theme}: ${issues.length} issues`);
        if (issues.length) { console.log(issues.join('\n')); await page.screenshot({ path: path.join(output, `${preset}-${route.name.replaceAll('/', '-')}-${width}-${theme}.png`) }); }
      }
      await page.context().close();
    }
  }
  const failed = results.filter(result => result.issues.length).length;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ passed: results.length - failed, failed, results }, null, 2));
  assert.equal(failed, 0, 'focus and calm keep every enforced route aligned');
  console.log(`PASS preset alignment: ${results.length} route views, 0 failures. ${output}/report.json`);
} finally { await server.close(); }

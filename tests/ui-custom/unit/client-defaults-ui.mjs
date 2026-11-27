import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { layoutServer } from '../../layout-fixture.mjs';
import { ROUTES } from '../../layout-alignment-ui.mjs';
import { preparePbeState } from '../../paper-pbe-states.mjs';

const output = path.resolve('.context/ui-custom/defaults'); fs.mkdirSync(output, { recursive: true });
const baseline = process.env.CLIENT_BASELINE === '1';
const server = await layoutServer({ root: path.resolve(baseline ? process.env.CLIENT_MAIN_ROOT || '.context/main-baseline' : '.') });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const report = [];
try {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: width <= 760 ? 844 : 900 }, reducedMotion: 'reduce', colorScheme: theme });
    await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
    await context.addInitScript(theme => { localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0'); }, theme);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    for (const route of ROUTES) {
      const key = `${width}-${theme}-${route.name.replaceAll('/', '-')}`;
      if (baseline && process.env.CLIENT_RESUME === '1' && fs.existsSync(path.join(output, `${key}.json`))) { report.push(key); continue; }
      if (route.signedOut) await context.clearCookies();
      if (route.code) await page.route('**/api/auth/phone/start', request => request.fulfill({ json: { id: 'layout-code', delivery: 'sent', textNumber: null, line: null } }));
      const hash = route.hash.replace('{bot}', server.fixture.bot.id).replace('{room}', server.fixture.room);
      await page.goto('about:blank'); await page.goto(`${server.base}/${hash.replace(/^\//, '')}`);
      await page.locator(route.signedOut ? '.signin, .access-signin, .join' : '.shell-header').first().waitFor();
      if (route.code) { await page.locator('input[type=tel]').fill('+15555550123'); await page.getByRole('button', { name: 'Continue with phone', exact: true }).click(); await page.getByRole('textbox', { name: '6-digit code' }).waitFor(); }

      await page.locator('[data-layout="page"]:visible').first().waitFor();
      await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400);
      if (route.state) { await page.waitForFunction(async id => (await import('/src/store.ts')).useStore.getState().bots.some(bot => bot.id === id), server.fixture.bot.id); await preparePbeState(page, route.state, server.fixture.bot.id); }
      const result = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement), tokens = {};
        // Resolve CSS lengths, so calc(24px * 1) and 24px compare as rendered values.
        const probe = document.createElement('div'); probe.style.position = 'fixed'; probe.style.visibility = 'hidden'; probe.style.setProperty('transition', 'none', 'important'); document.body.append(probe);
        for (const name of [...root].filter(name => name.startsWith('--'))) {
          if (['--font-scale', '--stack-gap', '--card-pad', '--ui-sidebar-width', '--ui-content-width'].includes(name)) continue;
          const raw = root.getPropertyValue(name).trim();
          if (/^(--text-|--line-)/.test(name)) { probe.style.width = `var(${name})`; tokens[name] = getComputedStyle(probe).width; }
          else tokens[name] = raw;
        }
        probe.remove();
        const nodes = [...document.querySelectorAll('[data-layout], .shell-header, .sidebar, .composer, .composer__input, .phone-tabs, h1, h2')].filter(el => el.checkVisibility() && el.getBoundingClientRect().width);
        return { tokens, nodes: nodes.map(el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return { tag: el.tagName, class: el.className, rect: [r.x, r.y, r.width, r.height].map(n => Math.round(n * 100) / 100), font: s.font, background: s.backgroundColor, padding: s.padding, gap: s.gap, radius: s.borderRadius }; }) };
      });
      if (baseline) fs.writeFileSync(path.join(output, `${key}.json`), JSON.stringify(result, null, 2));
      else { const expected = JSON.parse(fs.readFileSync(path.join(output, `${key}.json`), 'utf8')); assert.deepEqual(result, expected, key); }
      report.push(key); console.log(`PASS default geometry ${key}`);
    }
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
fs.writeFileSync(path.join(output, baseline ? 'baseline.json' : 'comparison.json'), JSON.stringify({ passed: report.length, views: report }, null, 2));
console.log(`Default snapshots: ${report.length}/${report.length} passed (${baseline ? 'main recorded' : 'main matched'})`);

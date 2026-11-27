import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { layoutServer } from '../../layout-fixture.mjs';
import { ROUTES } from '../../layout-alignment-ui.mjs';
import { preparePbeState } from '../../paper-pbe-states.mjs';

const output = path.resolve('.context/ui-custom/defaults'); fs.mkdirSync(output, { recursive: true });
const baseline = process.env.CLIENT_BASELINE === '1';
const baselineSpec = JSON.parse(fs.readFileSync(new URL('./client-defaults-baseline.json', import.meta.url), 'utf8'));
const fingerprint = createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).update(JSON.stringify(baselineSpec)).digest('hex');
const recorded = fs.existsSync(path.join(output, 'baseline.json')) ? JSON.parse(fs.readFileSync(path.join(output, 'baseline.json'), 'utf8')) : null;
const validBaseline = recorded?.fingerprint === fingerprint && recorded?.passed === baselineSpec.routeViews;

if (!baseline && !validBaseline) {
  const root = path.resolve('.'), checkout = path.join(output, 'main');
  if (!fs.existsSync(checkout)) {
    execFileSync('git', ['worktree', 'add', '--detach', checkout, baselineSpec.commit], { stdio: 'inherit' });
    for (const relative of ['node_modules', 'web/node_modules']) fs.symlinkSync(path.join(root, relative), path.join(checkout, relative), 'dir');
  }
  execFileSync(process.execPath, [new URL(import.meta.url).pathname], { stdio: 'inherit', env: { ...process.env, CLIENT_BASELINE: '1', CLIENT_MAIN_ROOT: checkout } });
}
const server = await layoutServer({ root: path.resolve(baseline ? process.env.CLIENT_MAIN_ROOT || '.context/main-baseline' : '.') });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const report = [];
try {
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: width <= 760 ? 844 : 900 }, reducedMotion: 'reduce', colorScheme: theme,
      locale: 'en-US', timezoneId: 'UTC' });
    // History timestamps come from Date.now() in the local seed. Their digit widths
    // can wrap a row onto another line, so both checkouts must render identical data.
    await context.route('**/api/learning/bots/*/history*', async request => {
      const response = await request.fetch();
      if (!response.ok()) { await request.fulfill({ response }); return; }
      const data = await response.json();
      if (Array.isArray(data.entries)) data.entries = data.entries.map(entry => ({ ...entry,
        occurredAt: Date.parse(baselineSpec.historyTimestamp), recordedAt: Date.parse(baselineSpec.historyTimestamp) }));
      await request.fulfill({ response, json: data });
    });
    await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
    await context.addInitScript(theme => { localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0'); }, theme);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    for (const route of ROUTES) {
      if (process.env.CLIENT_ROUTES && !process.env.CLIENT_ROUTES.split(',').includes(route.name)) continue;
      const key = `${width}-${theme}-${route.name.replaceAll('/', '-')}`;
      if (baseline && validBaseline && process.env.CLIENT_RESUME === '1' && fs.existsSync(path.join(output, `${key}.json`))) { report.push(key); continue; }
      if (route.signedOut) await context.clearCookies();
      if (route.code) await page.route('**/api/auth/phone/start', request => request.fulfill({ json: { id: 'layout-code', delivery: 'sent', textNumber: null, line: null } }));
      const hash = route.hash.replace('{bot}', server.fixture.bot.id).replace('{room}', server.fixture.room);
      await page.goto('about:blank'); await page.goto(`${server.base}/${hash.replace(/^\//, '')}`);
      await page.locator(route.signedOut ? '.signin, .access-signin, .join' : '.shell-header').first().waitFor();
      if (route.code) { await page.locator('input[type=tel]').fill('+15555550123'); await page.getByRole('button', { name: 'Continue with phone', exact: true }).click(); await page.getByRole('textbox', { name: '6-digit code' }).waitFor(); }

      await page.locator('[data-layout="page"]:visible').first().waitFor();
      await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400);
      if (route.state) { await page.waitForFunction(async id => (await import('/src/store.ts')).useStore.getState().bots.some(bot => bot.id === id), server.fixture.bot.id); await page.locator('.composer__input:not([disabled])').waitFor(); await page.waitForFunction(async id => (await import('/src/store.ts')).useStore.getState().transcripts[id]?.loaded, server.fixture.bot.id); await preparePbeState(page, route.state, server.fixture.bot.id); await page.waitForTimeout(400); }
      const result = await page.evaluate(() => {
        // Ignore transient chat scroll restoration when comparing structure.
        for (const element of document.querySelectorAll('*')) if (element.scrollTop) element.scrollTop = 0;
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
fs.writeFileSync(path.join(output, baseline ? 'baseline.json' : 'comparison.json'), JSON.stringify({ fingerprint, passed: report.length, views: report }, null, 2));
console.log(`Default snapshots: ${report.length}/${report.length} passed (${baseline ? 'main recorded' : 'main matched'})`);

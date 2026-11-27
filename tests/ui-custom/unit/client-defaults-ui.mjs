import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { layoutServer } from '../../layout-fixture.mjs';
import { ROUTES } from '../../layout-alignment-ui.mjs';
import { preparePbeState } from '../../paper-pbe-states.mjs';
import { installSnapshotReadiness, waitForSnapshotReadiness } from '../../handoffs/defaults-readiness.mjs';
import { compareDefaultView } from './client-defaults-compare.mjs';

const output = path.resolve('.context/ui-custom/defaults'); fs.mkdirSync(output, { recursive: true });
const baseline = process.env.CLIENT_BASELINE === '1';
const baselineSpec = JSON.parse(fs.readFileSync(new URL('./client-defaults-baseline.json', import.meta.url), 'utf8'));
const fingerprint = createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).update(JSON.stringify(baselineSpec)).digest('hex');
const recorded = fs.existsSync(path.join(output, 'baseline.json')) ? JSON.parse(fs.readFileSync(path.join(output, 'baseline.json'), 'utf8')) : null;
const validBaseline = recorded?.fingerprint === fingerprint && recorded?.passed === baselineSpec.routeViews;

if (!baseline && !validBaseline) {
  const root = path.resolve('.'), checkout = path.join(output, `main-${baselineSpec.commit}`);
  if (!fs.existsSync(checkout)) {
    execFileSync('git', ['worktree', 'add', '--detach', checkout, baselineSpec.commit], { stdio: 'inherit' });
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
    // Each checkout needs its own Vite cache when local checks run concurrently.
    const dependencies = path.join(checkout, 'web/node_modules'); fs.mkdirSync(dependencies);
    for (const entry of fs.readdirSync(path.join(root, 'web/node_modules'))) {
      if (entry !== '.vite' && entry !== '.vite-temp') fs.symlinkSync(path.join(root, 'web/node_modules', entry), path.join(dependencies, entry));
    }
  }
  execFileSync(process.execPath, [new URL(import.meta.url).pathname], { stdio: 'inherit', env: { ...process.env, CLIENT_BASELINE: '1', CLIENT_MAIN_ROOT: checkout } });
}
const server = await layoutServer({ root: path.resolve(baseline ? process.env.CLIENT_MAIN_ROOT || '.context/main-baseline' : '.') });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const report = [], reviewed = [];
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
    await context.addInitScript(theme => { if (location.origin === 'null') return; localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0'); }, theme);
    const page = await context.newPage(); page.setDefaultTimeout(15000); await installSnapshotReadiness(page);
    const pending = new Set(); let lastRequest = 0;
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === server.base && (['/api/handoff-settings', '/api/handoff-task-links'].includes(url.pathname)
        || /^\/api\/bots\/[^/]+\/flow$/.test(url.pathname))) {
        pending.add(request); lastRequest = Date.now();
      }
    });
    const finished = request => { if (pending.delete(request)) lastRequest = Date.now(); };
    page.on('requestfinished', finished); page.on('requestfailed', finished);
    // History routing must not disable caching of this checkout's immutable assets.
    const network = await context.newCDPSession(page);
    await network.send('Network.setCacheDisabled', { cacheDisabled: false });
    for (const route of ROUTES) {
      if (process.env.CLIENT_ROUTES && !process.env.CLIENT_ROUTES.split(',').includes(route.name)) continue;
      const key = `${width}-${theme}-${route.name.replaceAll('/', '-')}`;
      if (baseline && validBaseline && process.env.CLIENT_RESUME === '1' && fs.existsSync(path.join(output, `${key}.json`))) { report.push(key); continue; }
      if (route.signedOut) await context.clearCookies();
      if (route.code) await page.route('**/api/auth/phone/start', request => request.fulfill({ json: { id: 'layout-code', delivery: 'sent', textNumber: null, line: null } }));
      const hash = route.hash.replace('{bot}', server.fixture.bot.id).replace('{room}', server.fixture.room);
      const setups = route.name === 'chat' ? page.waitForResponse(response => new URL(response.url()).pathname === `/api/bots/${server.fixture.bot.id}/coworker-setups`) : null;
      await page.goto('about:blank'); await page.goto(`${server.base}/${hash.replace(/^\//, '')}`);
      await page.locator(route.signedOut ? '.signin, .access-signin, .join' : '.shell-header').first().waitFor();
      if (route.code) { await page.locator('input[type=tel]').fill('+15555550123'); await page.getByRole('button', { name: 'Continue with phone', exact: true }).click(); await page.getByRole('textbox', { name: '6-digit code' }).waitFor(); }

      await page.locator('[data-layout="page"]:visible').first().waitFor();
      // A lazy details route can briefly expose the underlying chat Page.
      if (route.hash.includes('/details/')) await page.locator('.pb-details [data-layout="page"]:visible').waitFor();
      if (route.name === 'chat' || route.name === 'room') {
        await page.locator('.composer__input:not([disabled])').waitFor();
        await page.waitForFunction(async id => (await import('/src/store.ts')).useStore.getState().transcripts[id]?.loaded,
          route.name === 'room' ? server.fixture.room : server.fixture.bot.id);
        await page.locator('.empty-chat').waitFor();
        if (setups) {
          const data = await (await setups).json();
          await page.waitForFunction(count => document.querySelectorAll('.coworker-setup').length === count, data.setups.length);
        }
      }
      await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(400);
      if (route.state) { await page.waitForFunction(async id => (await import('/src/store.ts')).useStore.getState().bots.some(bot => bot.id === id), server.fixture.bot.id); await page.locator('.composer__input:not([disabled])').waitFor(); await page.waitForFunction(async id => (await import('/src/store.ts')).useStore.getState().transcripts[id]?.loaded, server.fixture.bot.id); await preparePbeState(page, route.state, server.fixture.bot.id); await page.waitForTimeout(400); }
      // ActionPreview is lazy: compare the complete card, never its loading fallback.
      if (route.state === 'approval' || route.state === 'declined') await page.locator('.approval-card .tool-preview').waitFor();
      // Configuration Markdown also loads lazily when its file reader enters view.
      if (route.name === 'bot-setup/files') {
        const markdown = page.locator('.agent-config__content:not([hidden]) .agent-config__file .md');
        await markdown.scrollIntoViewIfNeeded();
        await markdown.locator('h1, h2, p').first().waitFor();
      }
      // HO-I enables task and message actions after its policy request resolves.
      // Wait for Flow and handoff responses and their renders before measuring boxes.
      const deadline = Date.now() + 15000;
      while (pending.size || Date.now() - lastRequest < 500) {
        if (Date.now() > deadline) throw new Error(`${key}: Flow and handoff data did not settle`);
        await page.waitForTimeout(50);
      }
      await page.evaluate(() => document.fonts.ready);
      await waitForSnapshotReadiness(page);
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
      else {
        const expected = JSON.parse(fs.readFileSync(path.join(output, `${key}.json`), 'utf8'));
        if (compareDefaultView(key, result, expected, baselineSpec.reviewedDifferences) === 'reviewed') {
          const reason = baselineSpec.reviewedDifferences[key].reason;
          reviewed.push({ view: key, reason, before: expected.nodes, after: result.nodes, tokensMatch: true });
          console.log(`REVIEWED default geometry ${key}: ${reason}`);
        } else console.log(`PASS default geometry ${key}`);
      }
      report.push(key); if (baseline) console.log(`PASS default geometry ${key}`);
    }
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
fs.writeFileSync(path.join(output, baseline ? 'baseline.json' : 'comparison.json'), JSON.stringify({ fingerprint, passed: report.length, matched: report.length - reviewed.length, reviewed, views: report }, null, 2));
console.log(`Default snapshots: ${report.length}/${report.length} passed (${baseline ? 'main recorded' : `${report.length - reviewed.length} matched, ${reviewed.length} reviewed`})`);

// Local seeded route audit. Other streams turn on enforcement as they migrate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { preparePbeState } from './paper-pbe-states.mjs';
import { layoutServer } from './layout-fixture.mjs';
import { readableWords } from './paper-label-geometry.mjs';
import { qualityServer } from './ui-custom/fixtures/server.mjs';
import { MATRIX, WIDTHS, MODES, matrixDocument, THEME_PATCH } from './ui-custom/fixtures/matrix.mjs';
import { api, configAvailable, fixtureContext, put, requireModules, MissingFeature, agentPreview } from './ui-custom/fixtures/harness.mjs';
import { presetDocument } from './ui-custom/fixtures/presets.mjs';

export const ROUTES = [
  { name: 'bots', hash: '#bots', owner: 'PB-D', enforce: true },
  { name: 'chat', hash: '#bot/{bot}', owner: 'PB-E', enforce: true },
  { name: 'room', hash: '#bot/{room}', owner: 'PB-D', enforce: true },
  ...['', '/group'].map(suffix => ({ name: `create-bot${suffix}`, hash: `#new-bot${suffix}`, owner: 'PB-D', enforce: true })),
  ...['activity', 'tasks', 'files', 'files/reports', 'setup', 'setup/responsibilities', 'setup/harness', 'setup/files', 'setup/history'].map(tab => ({ name: `bot-${tab}`, hash: `#bot/{bot}/details/${tab}`, owner: 'PB-D', enforce: true })),
  ...['general', 'skills', 'memories', 'routines', 'analytics', 'learning'].map(tab => ({ name: `bot-settings-${tab}`, hash: `#bot/{bot}/settings/${tab}`, owner: 'PB-D', enforce: true })),
  { name: 'settings', hash: '#settings', owner: 'PB-C', enforce: true },
  ...['general', 'account', 'messaging', 'usage', 'learning', 'computer', 'permissions', 'subscriptions', 'keys', 'apps', 'mcp'].map(section => ({ name: `settings-${section}`, hash: `#settings/${section}`, owner: 'PB-C', enforce: true })),
  ...['tasks', 'team', 'goals', 'reports'].flatMap(tab => [
    { name: tab, hash: `#${tab}`, owner: 'PB-E', enforce: true },
    { name: `scoped-${tab}`, hash: `#bot/{bot}/${tab}`, owner: 'PB-E', enforce: true },
  ]),
  ...['empty', 'loading', 'approval', 'declined', 'voice', 'error'].map(state => ({ name: `chat-${state}`, hash: '#bot/{bot}', state, owner: 'PB-E', enforce: true })),
  { name: 'first-run', hash: '#first-run', owner: 'PB-E', enforce: true },
  { name: 'search', hash: '#search', owner: 'PB-E', enforce: true },
  { name: 'connect-apps', hash: '#apps/connect', owner: 'PB-C', enforce: true },
  { name: 'sign-in', hash: '', signedOut: true, owner: 'PB-E', enforce: true },
  { name: 'sign-in-code', hash: '', signedOut: true, code: true, owner: 'PB-E', enforce: true },
  { name: 'join', hash: '/join/layout-fixture', signedOut: true, owner: 'PB-E', enforce: true },
];

/** Browser-side geometry checks, also reused by the Settings matrix. */
export function inspectAlignment({ selector = '.shell-content > :not(.shell-header):not(.phone-tabs), .signin, .access-signin, .join', requirePage = true } = {}) {
  const roots = [...document.querySelectorAll(selector)];
  const visible = el => el.checkVisibility() && el.getBoundingClientRect().width > 0;
  const all = [...new Set(roots.flatMap(root => [root, ...root.querySelectorAll('*')]))].filter(visible);
  const issues = [];
  if (!all.length) issues.push('No visible route surface');
  const label = el => `${el.dataset.layout || el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${(el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 55)}`;
  const rect = el => el.getBoundingClientRect();
  const close = (a, b) => Math.abs(a - b) <= 1;
  const textRect = el => {
    const range = document.createRange(); range.selectNodeContents(el);
    return range.getBoundingClientRect();
  };
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('Horizontal document overflow');
  for (const el of all) {
    const r = rect(el), cs = getComputedStyle(el);
    if (r.left < -1 || r.right > innerWidth + 1) {
      // A closed popup has no visibility; a scrollable carousel is still a layout issue.
      issues.push(`Outside viewport: ${label(el)}`);
    }
    // The approved stable composer has 36px controls inside its 52/84px frame.
    const controlHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--control-h')) || 44;
    const floor = innerWidth <= 480 ? Math.max(44, controlHeight) : Math.max(40, controlHeight);
    const minControl = el.closest('.composer') ? 35 : floor - 1;
    if (el.matches('button, [role="button"], [data-layout="row"]') && r.height < minControl) issues.push(`Below ${floor}px (${r.height}): ${label(el)}`);
    if (el.dataset.layout === 'page') {
      if (!close(parseFloat(cs.paddingLeft), parseFloat(cs.paddingRight))) issues.push(`Unequal Page padding: ${label(el)}`);
      const p = rect(el.parentElement);
      if (!close(r.left - p.left, p.right - r.right)) issues.push(`Page is not centered: ${label(el)}`);
    }
    if (el.dataset.layout === 'button-group') {
      const children = [...el.children].filter(visible).map(rect);
      if (children.some(r => !close(r.width, children[0].width))) issues.push(`Unequal ButtonGroup widths: ${label(el)}`);
    }
    if (el.matches('[role="tablist"], [role="radiogroup"], .seg, .segmented, .cfg-seg, .task-filters, nav[aria-label$="sections"]')) {
      const children = [...el.children].filter(visible).map(rect);
      if (children.some(r => !close(r.width, children[0].width))) issues.push(`Unequal segmented cells: ${label(el)} (${children.map(r => r.width.toFixed(2)).join(', ')})`);
    }
    if (el.matches('.layout-section__header')) {
      const title = el.querySelector(':scope > h2');
      const actions = [...el.children].filter(child => child !== title && visible(child));
      for (const action of actions) {
        if (!title || !visible(title)) continue;
        const tr = textRect(title), ar = textRect(action);
        if (!close(tr.top + tr.height / 2, ar.top + ar.height / 2)) issues.push(`Section action text not centered: ${label(el)} (${Math.abs(tr.top + tr.height / 2 - ar.top - ar.height / 2).toFixed(2)}px)`);
        if (!close(rect(action).right, rect(el.closest('[data-layout="section"]')).right)) issues.push(`Section action right edge: ${label(el)}`);
        const ts = getComputedStyle(title);
        const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale')) || 1;
        if (!close(parseFloat(ts.fontSize), 13 * scale) || !close(parseFloat(ts.lineHeight), 18 * scale) || ts.fontWeight !== '600') issues.push(`Section title style: ${label(el)}`);
      }
    }
  }
  for (const column of all.filter(el => el.matches('.settings-general'))) {
    const left = rect(column.closest('.layout-page__content')).left;
    for (const child of [...column.children].filter(visible)) {
      if (!close(rect(child).left, left)) issues.push(`Page child left edge: ${label(child)}`);
    }
    for (const block of [...column.querySelectorAll('[data-layout="card"], .layout-section__footer')].filter(visible)) {
      if (!close(rect(block).left, left)) issues.push(`Page block left edge: ${label(block)}`);
    }
    const diagnostics = column.querySelector('.settings-diagnostics');
    if (diagnostics && !close(textRect(diagnostics).left, left)) issues.push(`Diagnostics text left edge: ${(textRect(diagnostics).left - left).toFixed(2)}px inset`);
  }
  if (requirePage && !all.some(el => el.dataset.layout === 'page')) issues.push('No shared Page primitive');
  const cards = all.filter(el => {
    if (el.dataset.layout === 'card') return true;
    if (el.matches('button, input, textarea, select, a, svg, [role="button"], [role="switch"], [role="tab"]') || el.closest('[data-layout="button-group"]')) return false;
    const cs = getComputedStyle(el), r = rect(el);
    return parseFloat(cs.borderTopLeftRadius) >= 8 && parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none' && r.width >= 120 && r.height >= 44;
  });
  const groups = new Map();
  for (const card of cards) {
    const parent = card.dataset.layout === 'card' ? card.closest('[data-layout="section"]') ?? card.closest('[data-layout="page"]') ?? card.parentElement : card.parentElement;
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(card);
  }
  for (const siblings of groups.values()) for (let i = 0; i < siblings.length; i++) for (let j = i + 1; j < siblings.length; j++) {
    const a = siblings[i], b = siblings[j];
    if (a.contains(b) || b.contains(a)) continue;
    const ar = rect(a), br = rect(b);
    const sameRow = Math.min(ar.bottom, br.bottom) > Math.max(ar.top, br.top) + 1;
    const sameColumn = Math.min(ar.right, br.right) > Math.max(ar.left, br.left) + 1;
    const inDashboardGrid = a.parentElement === b.parentElement && getComputedStyle(a.parentElement).display === 'grid' && /span/.test(getComputedStyle(a).gridColumn + getComputedStyle(b).gridColumn);
    if (!inDashboardGrid && sameRow && !close(ar.width, br.width)) issues.push(`Unequal row card widths: ${label(a)} / ${label(b)}`);
    if (!inDashboardGrid && !sameRow && sameColumn && (!close(ar.left, br.left) || !close(ar.right, br.right))) issues.push(`Unequal column card edges: ${label(a)} / ${label(b)}`);
  }
  return [...new Set(issues)];
}

/** Grid geometry uses computed tracks, so breakpoint spans are audited as rendered. */
export function inspectDashboardGrid() {
  const issues = [];
  const grids = [...document.querySelectorAll('[data-layout="page"] *')].filter(el => getComputedStyle(el).display === 'grid' && [...el.children].some(child => /span/.test(getComputedStyle(child).gridColumn)));
  if (!grids.length) return ['No dashboard grid found'];
  for (const grid of grids) {
    const cs = getComputedStyle(grid), gap = parseFloat(cs.columnGap), tracks = cs.gridTemplateColumns.split(' ').map(parseFloat);
    const expected = innerWidth >= 1024 ? 12 : innerWidth >= 481 ? 6 : 2;
    if (tracks.length !== expected) issues.push(`Expected ${expected} dashboard columns, got ${tracks.length}`);
    const children = [...grid.children].filter(el => el.checkVisibility());
    for (const child of children) {
      const style = getComputedStyle(child), rect = child.getBoundingClientRect();
      const span = Number(style.gridColumn.match(/span\s+(\d+)/)?.[1] || 1);
      if (Math.abs(rect.width - (tracks[0] * span + gap * (span - 1))) > 1) issues.push('Dashboard span does not fill its tracks');
      if (rect.left < -1 || rect.right > innerWidth + 1) issues.push('Dashboard widget outside viewport');
      for (const other of children) {
        if (child === other) continue;
        const b = other.getBoundingClientRect();
        if (Math.abs(rect.top - b.top) <= 1 && style.gridRow === getComputedStyle(other).gridRow && Math.abs(rect.height - b.height) > 1) issues.push('Same-row widget heights differ');
      }
    }
  }
  return [...new Set(issues)];
}

export const CUSTOM_ROUTES = [
  { name: 'settings-appearance', hash: '#settings/appearance', owner: 'UC-H', enforce: true },
  { name: 'dashboard-fixture', hash: '#dash/d_00000001', owner: 'UC-H', enforce: true, dashboard: true },
  { name: 'preview-banner', hash: '#bot/{bot}', owner: 'UC-H', enforce: true, preview: true },
  { name: 'safe-mode-banner', hash: '?ui=safe#bots', owner: 'UC-H', enforce: true, safe: true },
];
async function main() {
  const evidence = path.resolve(process.env.LAYOUT_EVIDENCE || '.context/layout-alignment'); fs.mkdirSync(evidence, { recursive: true });
  const server = process.env.LAYOUT_ROOT ? await layoutServer({ root: path.resolve(process.env.LAYOUT_ROOT) }) : await qualityServer({ extraSeed: false });
  let browser; const report = [], skipped = [];
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
    const probe = await fixtureContext(browser, server);
    let defaults, customization = false;
    try {
      defaults = (await configAvailable(probe.context.request, server.base)).doc;
      requireModules('web/src/customization/applier.ts', 'web/src/components/config/AppearanceSettings.tsx', 'web/src/dashboards/DashboardGrid.tsx', 'server/src/agent/ui-tools.ts');
      customization = true;
    } catch (error) {
      if (!(error instanceof MissingFeature)) throw error;
      skipped.push(error.message); console.log(`SKIP customization matrix: ${error.message}`);
    } finally { await probe.context.close(); }
    const fixtures = customization ? MATRIX.filter(name => !process.env.UC_LAYOUT_FIXTURE || name === process.env.UC_LAYOUT_FIXTURE) : ['baseline'];
    assert.ok(fixtures.length, 'UC_LAYOUT_FIXTURE must name a registered matrix fixture');
    for (const fixture of fixtures) for (const width of (process.env.LAYOUT_WIDTHS ? process.env.LAYOUT_WIDTHS.split(',').map(Number) : WIDTHS)) for (const mode of MODES) {
      const { context } = await fixtureContext(browser, server, width);
      await context.addInitScript(value => { if (location.origin !== 'null') localStorage.setItem('swarm.theme', value); }, mode);
      await context.setExtraHTTPHeaders({});
      let doc;
      if (customization) {
        doc = matrixDocument(defaults, fixture, mode, await presetDocument(fixture === 'hostile' ? 'swarm' : fixture));
        await put(context, server.base, doc);
      }
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      const routes = [...ROUTES, ...(customization ? CUSTOM_ROUTES : [])].filter(route => (!process.env.LAYOUT_OWNER || route.owner === process.env.LAYOUT_OWNER) && (!process.env.LAYOUT_ROUTES || process.env.LAYOUT_ROUTES.split(',').includes(route.name)));
      for (const route of routes) {
        // Authentication must be restored after signed-out route cases.
        await context.clearCookies();
        if (!route.signedOut) await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
        const hash = route.hash.replace('{bot}', server.fixture.bot.id).replace('{room}', server.fixture.room);
        let issues, words;
        try {
          if (route.code) await page.route('**/api/auth/phone/start', r => r.fulfill({ json: { id: 'layout-code', delivery: 'sent', textNumber: null, line: null } }));
          await page.goto('about:blank'); await page.goto(server.base + '/' + hash.replace(/^\//, ''));
          await page.locator(route.signedOut ? '.signin, .access-signin, .join' : '.shell-header').first().waitFor();
          if (route.code) {
            await page.locator('input[type=tel]').fill('+15555550123');
            await page.getByRole('button', { name: 'Continue with phone', exact: true }).click();
            await page.getByRole('textbox', { name: '6-digit code' }).waitFor();
          }
          if (route.enforce) await page.locator('[data-layout="page"]:visible').first().waitFor();
          await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(350);
          if (route.state) await preparePbeState(page, route.state, server.fixture.bot.id);
          if (route.preview) await agentPreview(page, server, THEME_PATCH, 'Matrix preview');
          if (route.safe) await page.getByText(/safe mode/i).first().waitFor();
          if (route.enforce) await page.locator(route.hash.includes('/details/') ? '.pb-details [data-layout="page"]:visible' : '[data-layout="page"]:visible').first().waitFor();
          issues = await page.evaluate(inspectAlignment, {});
          for (const control of await page.locator('.shell-content :is([role="tablist"], [role="radiogroup"], .seg, .segmented, .cfg-seg, .task-filters, nav[aria-label$="sections"]):visible').all()) {
            try { await readableWords(control); } catch (e) { issues.push(e.message); }
          }
          if (['settings-general', 'bots', 'tasks'].includes(route.name)) {
            try { await readableWords(page.locator('.shell-content')); } catch (e) { issues.push(e.message); }
            const logos = await page.locator('.provider-icon:visible').evaluateAll(elements => elements.flatMap(el => {
              const r = el.getBoundingClientRect(), p = el.parentElement.getBoundingClientRect();
              return Math.abs(r.width - 16) > 1 || Math.abs(r.height - 16) > 1 || r.left < p.left - 1 || r.right > p.right + 1 || r.top < p.top - 1 || r.bottom > p.bottom + 1 ? ['Provider logo does not fit its 16px slot'] : [];
            }));
            issues.push(...logos);
            words = await page.locator('.shell-content').evaluate(root => [...root.querySelectorAll('*')].filter(el => el.checkVisibility() && !el.closest('.phone-tabs, .sr-only, [hidden]')).flatMap(el => [...el.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent)).join(' ').trim().split(/\s+/).filter(Boolean).length);
            if ([320, 390, 1280].includes(width)) await page.screenshot({ path: path.join(evidence, `${fixture}-${route.name}-${width}-${mode}.png`) });
          }
          if (['tasks', 'scoped-tasks'].includes(route.name)) {
            const banner = page.getByTestId('tasks-needs-input');
            const bannerIssues = [];
            try {
              assert.ok(await banner.isVisible(), 'Tasks needs-input banner missing for 1 waiting task');
              assert.match(await banner.innerText(), /1 task needs your input/);
              assert.equal(await banner.getAttribute('role'), 'status');
              assert.ok(await banner.evaluate(el => {
                const r = el.getBoundingClientRect(), heading = document.querySelector('.work-heading'), text = el.querySelector('span');
                return r.top >= heading.getBoundingClientRect().bottom && r.bottom <= innerHeight && heading.nextElementSibling === el && el.dataset.layout === 'card' && el.classList.contains('layout-card--warning') && text.getBoundingClientRect().height <= parseFloat(getComputedStyle(text).lineHeight) + 1;
              }), 'Waiting banner directly follows the header in the first viewport');
              // Review must recover the waiting task even from the Done filter.
              await page.locator('.task-filters .is-done').click();
              await banner.getByRole('button', { name: 'Review', exact: true }).click();
              const waiting = page.locator('.task-card').filter({ hasText: 'Review the launch summary before it goes to the whole company' });
              await waiting.waitFor();
              assert.equal(await page.locator('.task-column:visible').count(), 1);
              assert.ok(await waiting.evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), 'Review shows the waiting task in view');
              await waiting.click();
              await page.locator('.composer__input').waitFor();
              assert.ok(new URL(page.url()).hash.startsWith('#bot/'), 'Waiting task still opens its chat');
            } catch (e) { bannerIssues.push(e.message); }
            // A route response variant removes waiting tasks without mutating the fixture database.
            await page.route('**/api/**/tasks', async r => { const response = await r.fetch(); const body = await response.json(); await r.fulfill({ response, json: { ...body, tasks: body.tasks.filter(task => task.state !== 'needs_input') } }); });
            await page.route('**/api/tasks', async r => { const response = await r.fetch(); const body = await response.json(); await r.fulfill({ response, json: { ...body, tasks: body.tasks.filter(task => task.state !== 'needs_input') } }); });
            await page.route('**/api/needs-you', r => r.fulfill({ json: { items: [] } }));
            await page.goto('about:blank'); await page.goto(server.base + '/' + hash);
            await page.getByText('Collect press contacts', { exact: true }).waitFor();
            assert.equal(await banner.count(), 0, 'No waiting tasks means no needs-input banner');
            await page.unroute('**/api/**/tasks'); await page.unroute('**/api/tasks'); await page.unroute('**/api/needs-you');
            issues.push(...bannerIssues);
          }

          if (route.dashboard) issues.push(...await page.evaluate(inspectDashboardGrid));
          if (route.preview || route.safe) {
            const bannerIssues = await page.evaluate(inspectAlignment, { selector: '[role="status"], [role="alert"]', requirePage: false });
            issues.push(...bannerIssues);
          }
          if (customization && !route.signedOut && !route.safe && !route.preview) {
            assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), mode, 'Matrix must render the requested theme');
          }
        } catch (error) { issues = [`Could not open: ${error.message.split('\n')[0]}`]; }
        report.push({ ...route, fixture, mode, theme: mode, width, words, issues });
        console.log(`${issues.length ? route.enforce ? 'FAIL' : 'WARN' : 'PASS'} ${fixture} ${mode} ${route.owner} ${route.name} ${width}: ${issues.length} issues`);
        for (const issue of issues) console.log(`FAIL ${fixture} ${mode} ${route.name} ${width}: ${issue}`);
        if (issues.length) await page.screenshot({ path: path.join(evidence, `${fixture}-${mode}-${width}-${route.name.replaceAll('/', '-')}.png`), fullPage: true }).catch(() => {});
        if (route.code) await page.unroute('**/api/auth/phone/start');
      }
      await context.close();
    }
  } finally {
    await browser?.close(); await server.close();
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(evidence, 'matrix-status.json'), JSON.stringify({ skipped, complete: skipped.length === 0, views: report.length }, null, 2));
  }
  const failures = report.filter(r => r.enforce && r.issues.length).length;
  console.log(`${report.length - failures} passed, ${failures} failed, ${skipped.length} matrix dependencies skipped. ${report.length} route views audited. Report: ${evidence}/report.json`);
  assert.equal(failures, 0, 'Enforced routes follow the shared layout system');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

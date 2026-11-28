// Local seeded route audit. LAYOUT_ROOT can point at an untouched baseline checkout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { preparePbeState } from './paper-pbe-states.mjs';
import { layoutServer } from './layout-fixture.mjs';
import { readableWords } from './paper-label-geometry.mjs';
import { runDashboardPolish } from './ui-custom/demo-dash.mjs';
import { auditSidebarPolish } from './ui-custom/sidebar-polish-ui.mjs';

export const DASHBOARD_POLISH_ROUTES = ['sales-pipeline', 'operations', 'manager', 'create', 'sidebar', 'empty', 'empty-widget', 'edit', 'widget-settings', 'add-widget', 'ask-agent', 'approve-confirm', 'send-prefill'].map(name => ({ name: `dashboard-${name}`, owner: 'FIX-DASH', enforce: true }));

export { DASHBOARD_ROUTES } from './ui-custom/e2e/layout-x2.mjs';

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

// Kept separate from ROUTES because client-defaults-ui pins the original 208 views.
export const SUGGESTION_ROUTES = [
  { name: 'about-you', hash: '#settings/appearance/use' },
  { name: 'suggestion-preview', hash: '#settings/appearance/use' },
  { name: 'resulting-dashboard', hash: '#dash/{dashboard}' },
];

/** Browser-side geometry checks, also reused by the Settings matrix. */
export function inspectAlignment({ selector = '.shell-content > :not(.shell-header):not(.phone-tabs), .signin, .access-signin, .join', requirePage = true, sidebarOnly = false } = {}) {
  const issues = [], near = (a, b) => Math.abs(a - b) <= 1;
  for (const sidebar of document.querySelectorAll('.sidebar:not(.is-collapsed)')) {
    const box = sidebar.getBoundingClientRect();
    if (!sidebar.checkVisibility() || box.right <= 0 || box.left >= innerWidth) continue;
    const meter = sidebar.querySelector('.sidebar-usage');
    if (!meter?.checkVisibility()) continue;
    const footer = sidebar.querySelector('.sidebar__footer'), scroll = sidebar.querySelector('.sidebar__custom-scroll, .sidebar__scroll');
    const nav = sidebar.querySelector('.sidebar__nav, .sidebar__dashboards');
    const m = meter.getBoundingClientRect(), f = footer.getBoundingClientRect(), s = scroll.getBoundingClientRect();
    const css = getComputedStyle(sidebar), contentLeft = box.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft);
    const contentRight = box.right - parseFloat(css.borderRightWidth) - parseFloat(css.paddingRight);
    if (!near(m.left, contentLeft) || !near(m.right, contentRight)) issues.push(`G1 usage width/edges: ${m.width.toFixed(2)}px, sidebar content ${(contentRight - contentLeft).toFixed(2)}px`);
    if (nav) { const n = nav.getBoundingClientRect(); if (!near(m.left, n.left) || !near(m.right, n.right)) issues.push('G1 usage edges differ from navigation'); }
    if (f.top - m.bottom < -1 || f.top - m.bottom > 16) issues.push(`G1 usage/footer gap: ${(f.top - m.bottom).toFixed(2)}px`);
    if (!near(f.bottom, box.bottom - parseFloat(css.paddingBottom) - parseFloat(css.borderBottomWidth))) issues.push('G1 Settings is not pinned to sidebar bottom');
    if (s.bottom > m.top + 1 || scroll.contains(meter) || scroll.contains(footer)) issues.push('G1 usage or Settings overlaps the scroll area');
    if (m.top < box.top || f.bottom > innerHeight + 1) issues.push('G1 usage or Settings is outside the viewport');
    const mc = getComputedStyle(meter);
    if (mc.padding !== '16px' || mc.borderTopLeftRadius !== '12px') issues.push('G1 usage card needs 16px padding and 12px radius');
  }
  if (sidebarOnly) return issues;
  const roots = [...document.querySelectorAll(selector)];
  // Accessibility announcements are fully clipped, including their text descendants.
  const visible = el => el.checkVisibility() && el.getBoundingClientRect().width > 0 && !el.closest('.sr-only, .dashboard-sr-only, [style*="clip-path: inset(50%)"]');
  const all = [...new Set(roots.flatMap(root => [root, ...root.querySelectorAll('*')]))].filter(visible);
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
    const minControl = el.closest('.composer') ? 35 : 43;
    if (el.matches('button, [role="button"], [data-layout="row"]') && r.height < minControl) issues.push(`Below 44px (${r.height}): ${label(el)}`);
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
        if (ts.fontSize !== '13px' || ts.lineHeight !== '18px' || ts.fontWeight !== '600') issues.push(`Section title style: ${label(el)}`);
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
    if (sameRow && !close(ar.width, br.width)) issues.push(`Unequal row card widths: ${label(a)} / ${label(b)}`);
    if (!sameRow && sameColumn && (!close(ar.left, br.left) || !close(ar.right, br.right))) issues.push(`Unequal column card edges: ${label(a)} / ${label(b)}`);
  }
  return [...new Set(issues)];
}

async function main() {
  const evidence = path.resolve(process.env.LAYOUT_EVIDENCE || '.context/layout-alignment'); fs.mkdirSync(evidence, { recursive: true });
  const server = await layoutServer({ root: path.resolve(process.env.LAYOUT_ROOT || '.') });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const report = [];
  try {
    for (const width of (process.env.LAYOUT_WIDTHS || '320,390,500,1280').split(',').map(Number)) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: width <= 760 ? 844 : 900 }, reducedMotion: 'reduce', colorScheme: theme });
      await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
      await context.addInitScript(theme => { if (location.origin === 'null') return; localStorage.setItem('swarm.theme', theme); localStorage.setItem('swarm.sidebarCollapsed', '0'); }, theme);
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      for (const route of ROUTES.filter(route => (!process.env.LAYOUT_OWNER || route.owner === process.env.LAYOUT_OWNER) && (!process.env.LAYOUT_ROUTES || process.env.LAYOUT_ROUTES.split(',').includes(route.name)))) {
        if (route.signedOut) await context.clearCookies();
        const hash = route.hash.replace('{bot}', server.fixture.bot.id).replace('{room}', server.fixture.room);
        let issues, words;
        try {
          if (route.code) {
            await page.route('**/api/auth/phone/start', r => r.fulfill({ json: { id: 'layout-code', delivery: 'sent', textNumber: null, line: null } }));
          }
          await page.goto('about:blank'); await page.goto(server.base + '/' + hash.replace(/^\//, ''));
          await page.locator(route.signedOut ? '.signin, .access-signin, .join' : '.shell-header').first().waitFor();
          if (route.code) {
            await page.locator('input[type=tel]').fill('+15555550123');
            await page.getByRole('button', { name: 'Continue with phone', exact: true }).click();
            await page.getByRole('textbox', { name: '6-digit code' }).waitFor();
          }
          if (route.enforce) await page.locator('[data-layout="page"]:visible').first().waitFor();
          await page.evaluate(() => document.fonts.ready);
          await page.waitForTimeout(350);
          if (route.state) await preparePbeState(page, route.state, server.fixture.bot.id);
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
            if ([320, 390, 1280].includes(width)) await page.screenshot({ path: path.join(evidence, `${route.name}-${width}-${theme}.png`) });
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
        } catch (e) { issues = [`Could not open: ${e.message.split('\n')[0]}`]; }
        report.push({ ...route, width, theme, words, issues });
        console.log(`${issues.length ? route.enforce ? 'FAIL' : 'WARN' : 'PASS'} ${route.owner} ${route.name} ${width} ${theme}: ${issues.length} issues`);
        for (const issue of issues) console.log(`FAIL ${route.name} ${width} ${theme}: ${issue}`);
      }
      await context.close();
    }
  } finally { await browser.close(); await server.close(); }
  if (!process.env.LAYOUT_ROOT && (!process.env.LAYOUT_OWNER || process.env.LAYOUT_OWNER === 'UC-X2') && !process.env.LAYOUT_ROUTES) {
    const { auditDashboardRoutes } = await import('./ui-custom/e2e/layout-x2.mjs');
    report.push(...await auditDashboardRoutes(path.join(evidence, 'dashboards'), inspectAlignment));
    const polish = await runDashboardPolish({ output: path.join(evidence, 'dashboard-polish') });
    report.push(...polish.checks.map(name => ({ name, owner: 'FIX-DASH', enforce: true, issues: [] })));
    report.push(...await auditSidebarPolish(ROUTES, path.join(evidence, 'sidebar-polish')));
  }
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  assert.equal(report.filter(r => r.enforce && r.issues.length).length, 0, 'Enforced routes follow the shared layout system');
  console.log(`${report.length} route views audited. Report: ${evidence}/report.json`);
  if (!process.env.LAYOUT_OWNER && !process.env.LAYOUT_ROUTES || process.env.LAYOUT_OWNER === 'UC-Y') {
    const result = spawnSync(process.execPath, ['tests/ui-custom/e2e/suggest-dashboard-ui.mjs'], { stdio: 'inherit', env: { ...process.env, SUGGEST_EVIDENCE: path.join(evidence, 'suggestions') } });
    assert.equal(result.status, 0, 'Dashboard suggestion routes follow Paper layout and visible-copy rules');
  }
  await (await import('./handoffs/ho-routes.mjs')).auditHandoffRoutes(inspectAlignment);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

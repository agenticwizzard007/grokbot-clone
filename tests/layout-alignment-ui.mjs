// Local seeded route audit. Other streams turn on enforcement as they migrate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { layoutServer } from './layout-fixture.mjs';

export const ROUTES = [
  { name: 'bots', hash: '#bots', owner: 'PB-D', enforce: true },
  { name: 'chat', hash: '#bot/{bot}', owner: 'PB-E', enforce: false },
  { name: 'room', hash: '#bot/{room}', owner: 'PB-D', enforce: true },
  ...['', '/group'].map(suffix => ({ name: `create-bot${suffix}`, hash: `#new-bot${suffix}`, owner: 'PB-D', enforce: true })),
  ...['activity', 'tasks', 'files', 'files/reports', 'setup', 'setup/responsibilities', 'setup/harness', 'setup/files', 'setup/history'].map(tab => ({ name: `bot-${tab}`, hash: `#bot/{bot}/details/${tab}`, owner: 'PB-D', enforce: true })),
  ...['general', 'skills', 'memories', 'routines', 'analytics', 'learning'].map(tab => ({ name: `bot-settings-${tab}`, hash: `#bot/{bot}/settings/${tab}`, owner: 'PB-D', enforce: true })),
  { name: 'settings', hash: '#settings', owner: 'PB-C', enforce: true },
  ...['general', 'account', 'messaging', 'usage', 'learning', 'computer', 'permissions', 'subscriptions', 'keys', 'apps', 'mcp'].map(section => ({ name: `settings-${section}`, hash: `#settings/${section}`, owner: 'PB-C', enforce: true })),
  ...['tasks', 'team', 'goals', 'reports'].flatMap(tab => [
    { name: tab, hash: `#${tab}`, owner: 'PB-E', enforce: false },
    { name: `scoped-${tab}`, hash: `#bot/{bot}/${tab}`, owner: 'PB-E', enforce: false },
  ]),
  { name: 'search', hash: '#search', owner: 'PB-E', enforce: false },
  { name: 'connect-apps', hash: '#apps/connect', owner: 'PB-C', enforce: true },
  { name: 'sign-in', hash: '', signedOut: true, owner: 'PB-E', enforce: false },
  { name: 'sign-in-code', hash: '', signedOut: true, code: true, owner: 'PB-E', enforce: false },
  { name: 'join', hash: '/join/layout-fixture', signedOut: true, owner: 'PB-E', enforce: false },
];

/** Browser-side geometry checks, also reused by the Settings matrix. */
export function inspectAlignment({ selector = '.shell-content > :not(.shell-header):not(.phone-tabs), .signin, .access-signin, .join', requirePage = true } = {}) {
  const roots = [...document.querySelectorAll(selector)];
  const visible = el => el.checkVisibility() && el.getBoundingClientRect().width > 0;
  const all = [...new Set(roots.flatMap(root => [root, ...root.querySelectorAll('*')]))].filter(visible);
  const issues = [];
  if (!all.length) issues.push('No visible route surface');
  const label = el => `${el.dataset.layout || el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 55)}`;
  const rect = el => el.getBoundingClientRect();
  const close = (a, b) => Math.abs(a - b) <= 1;
  if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('Horizontal document overflow');
  for (const el of all) {
    const r = rect(el), cs = getComputedStyle(el);
    if (r.left < -1 || r.right > innerWidth + 1) {
      // A closed popup has no visibility; a scrollable carousel is still a layout issue.
      issues.push(`Outside viewport: ${label(el)}`);
    }
    if (el.matches('button, [role="button"], [data-layout="row"]') && r.height < 43) issues.push(`Below 44px (${r.height}): ${label(el)}`);
    if (el.dataset.layout === 'page') {
      if (!close(parseFloat(cs.paddingLeft), parseFloat(cs.paddingRight))) issues.push(`Unequal Page padding: ${label(el)}`);
      const p = rect(el.parentElement);
      if (!close(r.left - p.left, p.right - r.right)) issues.push(`Page is not centered: ${label(el)}`);
    }
    if (el.dataset.layout === 'button-group') {
      const children = [...el.children].filter(visible).map(rect);
      if (children.some(r => !close(r.width, children[0].width))) issues.push(`Unequal ButtonGroup widths: ${label(el)}`);
    }
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
  const evidence = path.resolve('.context/layout-alignment'); fs.mkdirSync(evidence, { recursive: true });
  const server = await layoutServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const report = [];
  try {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, reducedMotion: 'reduce' });
      await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
      await context.addInitScript(() => { localStorage.setItem('swarm.theme', 'light'); localStorage.setItem('swarm.sidebarCollapsed', '0'); });
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      for (const route of ROUTES) {
        if (route.signedOut) await context.clearCookies();
        const hash = route.hash.replace('{bot}', server.fixture.bot.id).replace('{room}', server.fixture.room);
        let issues;
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
          await page.waitForTimeout(350);
          issues = await page.evaluate(inspectAlignment, {});
        } catch (e) { issues = [`Could not open: ${e.message.split('\n')[0]}`]; }
        report.push({ ...route, width, issues });
        console.log(`${issues.length ? route.enforce ? 'FAIL' : 'WARN' : 'PASS'} ${route.owner} ${route.name} ${width}: ${issues.length} issues`);
      }
      await context.close();
    }
  } finally { await browser.close(); await server.close(); }
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  assert.equal(report.filter(r => r.enforce && r.issues.length).length, 0, 'Enforced routes follow the shared layout system');
  console.log(`${report.length} route views audited. Report: .context/layout-alignment/report.json`);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();

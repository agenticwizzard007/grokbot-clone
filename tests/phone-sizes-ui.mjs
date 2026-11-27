// Phone and tablet size sweep against a real local server with a seeded account.
// Every main view is opened at each size and checked for: content pushed past the right edge, page
// level horizontal scrolling, text smaller than 11px, phone inputs below 16px (iOS zooms on focus),
// and page or panel titles outside the shared type scale. Small tap targets are reported as warnings.
// Screenshots go to .context/phone-qa/. No provider, app or messaging credentials are used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const evidence = path.join(root, '.context/phone-qa');
fs.mkdirSync(evidence, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-phone-qa-'));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const apiPort = await port(), uiPort = await port(), base = `http://127.0.0.1:${uiPort}`, apiBase = `http://127.0.0.1:${apiPort}`;
const fixtureFile = path.join(temp, 'fixture.json');
const env = { ...process.env, PHONE_QA_FIXTURE_FILE: fixtureFile, DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), SWARM_ROLE: 'standalone', NODE_ENV: 'test', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'phone-qa-test', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', INKBOX_TUNNEL: '0', DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: base, SERVER_URL: base, DIRECT_API_KEY: '', OPENROUTER_API_KEY: '', WHATSAPP_DISABLED: '1' };
const children = [], logs = [];
function start(args, cwd = root, extra = {}) { const p = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(p); for (const s of [p.stdout, p.stderr]) s.on('data', d => logs.push(String(d))); return p; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, name) { for (let i = 0; i < 300; i++) { if (await fn()) return; await sleep(100); } throw new Error('Timed out: ' + name); }

// Phones (portrait and one landscape), small and large tablets, and a short laptop.
const SIZES = (process.env.PHONE_QA_SIZES ?? '320x568,360x740,375x667,390x844,393x852,402x874,412x915,430x932,440x956,844x390,768x1024,820x1180,1024x768')
  .split(',').map(s => { const [width, height] = s.split('x').map(Number); return { width, height, phone: width <= 760 }; });
const SETTINGS = ['general', 'account', 'keys', 'computer', 'messaging', 'permissions', 'apps', 'mcp', 'subscriptions', 'learning', 'usage'];
const BOT_TABS = ['general', 'skills', 'memories', 'routines', 'analytics', 'learning'];
const WORK_TABS = ['Tasks', 'Team', 'Goals', 'Reports'];

/** Runs in the page: layout and type checks for whatever is on screen. */
function inspect({ phone }) {
  const vw = document.documentElement.clientWidth, issues = [], warnings = [];
  const visible = el => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0 && r.bottom > 0 && r.top < innerHeight;
  };
  const describe = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} "${(el.innerText || el.getAttribute('aria-label') || el.value || '').trim().slice(0, 40)}"`;
  // A descendant of a scroll or clip container may extend past the edge on purpose (carousels, tables).
  const clipped = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') return p.getBoundingClientRect().right <= vw + 1; } return false; };
  if (document.scrollingElement.scrollWidth > vw + 1) issues.push(`page scrolls sideways: ${document.scrollingElement.scrollWidth}px content in a ${vw}px viewport`);
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.right > vw + 1 && !clipped(el) && cs.position !== 'fixed') {
      const key = describe(el); if (!seen.has(key)) { seen.add(key); issues.push(`past the right edge by ${Math.round(r.right - vw)}px: ${key}`); }
    }
    const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const size = parseFloat(cs.fontSize);
    if (ownText && size < 11) issues.push(`text below 11px (${size}px): ${describe(el)}`);
    if (phone && el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=file]):not([type=hidden]), textarea, select') && size < 16) issues.push(`phone input below 16px (${size}px, zooms on focus): ${describe(el)}`);
    if (el.matches('h1') && size > (phone ? 22 : 24) + 0.5) issues.push(`page title larger than the shared scale (${size}px): ${describe(el)}`);
    if (el.matches('h2') && size > 17.5 && !el.closest('.signin, .access-signin, .join')) issues.push(`section title larger than the panel title size (${size}px): ${describe(el)}`);
    const target = el.closest('label') ?? el, tr = target.getBoundingClientRect();
    if (phone && el.matches('button, a[href], [role=button], [role=tab], [role=switch]') && (tr.height < (el.matches('[role=switch], .toggle') ? 24 : 32) || tr.width < 24) && !el.closest('.md')) warnings.push(`small tap target ${Math.round(tr.width)}x${Math.round(tr.height)}: ${describe(el)}`);
  }
  return { issues, warnings: [...new Set(warnings)] };
}

const report = [];
let browser;
try {
  const seed = start(['--import', 'tsx', 'tests/fixtures/phone-qa.seed.mts']);
  assert.equal(await new Promise(r => seed.on('exit', r)), 0, logs.join(''));
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
  start(['--import', 'tsx', 'server/src/index.ts']);
  await until(() => fetch(apiBase + '/api/health').then(r => r.ok).catch(() => false), 'server');
  start([path.join(root, 'web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'], path.join(root, 'web'), { SWARM_API: apiBase });
  await until(() => fetch(base).then(r => r.ok).catch(() => false), 'web');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });

  for (const size of SIZES) {
    const label = `${size.width}x${size.height}`;
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.phone, hasTouch: size.phone, deviceScaleFactor: size.phone ? 2 : 1, reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'swarm_session', value: 'phone-qa-token', url: base }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.setDefaultTimeout(10000);
    const check = async (view, open) => {
      let entry;
      try {
        await open();
        await page.waitForTimeout(350);
        entry = { size: label, view, ...await page.evaluate(inspect, { phone: size.phone }) };
      } catch (e) {
        entry = { size: label, view, issues: [`could not open: ${String(e.message ?? e).split('\n')[0]}`], warnings: [] };
      }
      await page.screenshot({ path: path.join(evidence, `${label}-${view.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`) }).catch(() => {});
      report.push(entry);
    };
    const home = async () => { await page.goto('about:blank'); await page.goto(base + '/'); await page.locator('.app').waitFor(); await page.waitForLoadState('networkidle').catch(() => {}); };
    const route = async hash => {
      await page.goto('about:blank');
      await page.goto(`${base}/${hash}`);
      await page.locator('.app').waitFor();
    };
    const openQuinn = async () => {
      await route(`#bot/${encodeURIComponent(fixture.quinn.id)}`);
      await page.locator('.composer__input').waitFor();
    };

    await check('bot list', async () => { await home(); if (!size.phone) await page.locator('.sidebar').waitFor(); });
    await check('chat', async () => { await openQuinn(); await page.getByText('Copy draft', { exact: true }).waitFor(); });
    await check('details', async () => {
      await openQuinn();
      await page.getByRole('button', { name: /^(Open Quinn details|Show details|Details)$/ }).first().click();
      await page.getByRole('complementary', { name: 'Conversation details' }).waitFor();
    });
    await check('create a bot', async () => {
      await route('#new-bot');
      await page.getByRole('textbox', { name: /Bot name/ }).first().waitFor();
    });
    await check('search', async () => {
      await route('#search');
      await page.getByRole('dialog').first().waitFor();
    });
    for (const tab of WORK_TABS) {
      await check(`work ${tab}`, async () => {
        await route('#tasks');
        await page.locator('.tasks-view, .work-ui').first().waitFor();
        if (tab !== 'Tasks') await page.locator('.work-tabs').getByRole('button', { name: tab === 'Reports' ? 'Files' : tab, exact: true }).click();
      });
    }
    for (const section of SETTINGS) {
      await check(`settings ${section}`, async () => {
        await route(`#settings/${section}`);
        await page.locator('.app-settings, .access-settings').first().waitFor();
      });
    }
    for (const tab of BOT_TABS) {
      await check(`bot settings ${tab}`, async () => {
        await route(`#bot/${encodeURIComponent(fixture.quinn.id)}/settings/${tab}`);
        await page.locator('.bot-settings-page, .bot-settings').first().waitFor();
      });
    }
    if (errors.length) report.push({ size: label, view: 'page errors', issues: errors, warnings: [] });
    await context.close();
  }
} finally {
  await browser?.close();
  for (const c of children) c.kill();
  fs.rmSync(temp, { recursive: true, force: true });
}

fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 1));
const failing = report.filter(r => r.issues.length);
const warnCount = report.reduce((n, r) => n + r.warnings.length, 0);
for (const r of failing) { console.log(`FAIL ${r.size} ${r.view}`); for (const i of r.issues.slice(0, 8)) console.log('   ', i); }
console.log(`${report.length} views checked across ${SIZES.length} sizes: ${failing.length} with issues, ${warnCount} tap target warnings (see .context/phone-qa/report.json)`);
assert.equal(failing.length, 0, 'every view fits its screen and keeps the shared type scale');
console.log('PASS phone and tablet size sweep');

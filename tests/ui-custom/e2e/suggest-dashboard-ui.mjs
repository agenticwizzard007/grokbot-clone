import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import http from 'node:http';
import Database from 'better-sqlite3';

import { inspectAlignment, SUGGESTION_ROUTES } from '../../layout-alignment-ui.mjs';
import { readableWords } from '../../paper-label-geometry.mjs';

/** Browser-side gate for the profile and suggestion surfaces, independent of the screenshot theme. */
export function inspectSuggestionQuality() {
  const issues = [];
  let minContrast = Infinity, contrastSamples = 0;
  const forbidden = /mock|fixture|private|QA-|undefined|null|\[object/i;
  const visibleText = document.body.innerText;
  const match = visibleText.match(forbidden);
  if (match) issues.push(`Forbidden visible text: ${match[0]}`);
  const root = document.querySelector('.dashboard-page, .app-settings__page:has(.requirements-settings)');
  if (!root) return { issues, words: 0 };
  const visible = el => el.checkVisibility() && el.getBoundingClientRect().width > 1 && !el.closest('.sr-only, .dashboard-sr-only, [aria-hidden="true"], svg');
  const label = el => (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 55);
  const header = document.querySelector('.shell-header__title');
  if (header && visible(header) && [...root.querySelectorAll('h1,h2')].some(el => visible(el) && label(el) === label(header))) issues.push(`Duplicate title: ${label(header)}`);
  const titles = [...root.querySelectorAll('h1,h2')].filter(visible).map(label);
  if (titles.some((title, i) => titles.indexOf(title) !== i)) issues.push('Repeated page or section title');
  const rgb = color => {
    if (/^#[\da-f]{6}$/i.test(color.trim())) return [1, 3, 5].map(i => parseInt(color.trim().slice(i, i + 2), 16)).concat(1);
    const values = color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
    return [...values.slice(0, 3), values[3] ?? 1];
  };
  const blend = (a, b) => a.slice(0, 3).map((v, i) => v * a[3] + b[i] * (1 - a[3]));
  const background = el => {
    if (!el) return rgb(getComputedStyle(document.documentElement).getPropertyValue('--color-bg-pane'));
    const color = rgb(getComputedStyle(el).backgroundColor);
    return color[3] === 1 ? color : blend(color, background(el.parentElement));
  };
  const luminance = channels => channels.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode, el = node.parentElement;
    if (!el || !node.textContent.trim() || !visible(el) || el.matches('option,style,script')) continue;
    if (!/[a-z0-9]/i.test(node.textContent)) continue;
    const style = getComputedStyle(el), size = parseFloat(style.fontSize);
    const secondary = el.closest('.layout-section__header, .layout-row__subtitle, .dashboard-list-meta, .dashboard-muted, .dashboard-chart-labels, .dashboard-chart-legend, .dashboard-schedule, .dashboard-bot-grid');
    if (size < (secondary ? 13 : 14) - .1) issues.push(`Small text ${size}px: ${node.textContent.trim().slice(0, 50)}`);
    if (!el.closest(':disabled')) {
      const bg = background(el), fg = blend(rgb(style.color), bg), a = luminance(bg), b = luminance(fg);
      const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      contrastSamples++; minContrast = Math.min(minContrast, ratio);
      if (!Number.isFinite(ratio)) issues.push(`Unmeasured contrast: ${node.textContent.trim().slice(0, 50)}`);
      if (ratio < 4.5) issues.push(`Low text contrast ${ratio.toFixed(2)}: ${node.textContent.trim().slice(0, 50)}`);
    }
  }
  if (innerWidth <= 760) {
    const backs = [...document.querySelectorAll('.shell-back')].filter(visible).length;
    if (backs > 1 || (location.hash === '#settings/appearance/use' && backs !== 1)) issues.push(`Phone Back count: ${backs}`);
  }
  for (const el of [...root.querySelectorAll('*')].filter(visible)) {
    const style = getComputedStyle(el), rect = el.getBoundingClientRect();
    if (el.matches('button,[role="button"],input,select,textarea,[data-layout="row"]') && rect.height < 43) issues.push(`Short control: ${label(el)}`);
    if (el.matches('[data-layout="card"]')) {
      if (Math.abs(parseFloat(style.borderTopLeftRadius) - 12) > .1) issues.push(`Card radius: ${label(el)}`);
      for (const side of ['Left', 'Right', 'Top', 'Bottom']) if (Math.abs(parseFloat(style[`padding${side}`]) - 16) > .1) issues.push(`Card padding: ${label(el)}`);
    }
    if (el.dataset.layout === 'button-group') {
      const widths = [...el.children].filter(visible).map(child => child.getBoundingClientRect().width);
      if (widths.some(width => Math.abs(width - widths[0]) > 1)) issues.push(`Unequal button widths: ${label(el)}`);
    }
    for (const gap of [style.rowGap, style.columnGap]) if (/px$/.test(gap) && parseFloat(gap) > 0 && parseFloat(gap) % 8 !== 0 && !(parseFloat(gap) === 4 && el.closest('button,input,select'))) issues.push(`Off-scale gap ${gap}: ${label(el)}`);
    const step = el.closest('button,input,select,textarea,a,[role="button"],.cfg-chip,[data-layout="row"]') ? 4 : 8;
    for (const property of ['marginTop', 'marginBottom', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']) {
      const value = parseFloat(style[property]);
      if (value > 0 && value % step !== 0) issues.push(`Off-scale ${property} ${value}px: ${label(el)}`);
    }
    if (el.matches('.layout-section__header h2') && (style.fontSize !== '13px' || style.lineHeight !== '18px' || style.fontWeight !== '600')) issues.push(`Section header style: ${label(el)}`);
  }
  return { issues: [...new Set(issues)], words: root.innerText.trim().split(/\s+/).filter(Boolean).length, contrastSamples, minContrast: Number.isFinite(minContrast) ? minContrast : null };
}

async function suggestionFixture() {
  const root = path.resolve(process.env.SUGGEST_APP_ROOT || new URL('../../..', import.meta.url).pathname);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-agent-demo-'));
  async function port() { const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const value = listener.address().port; await new Promise(resolve => listener.close(resolve)); return value; }
  const apiPort = await port(), uiPort = await port(), modelPort = await port();
  const base = `http://127.0.0.1:${uiPort}`, api = `http://127.0.0.1:${apiPort}`, model = `http://127.0.0.1:${modelPort}`;
  const fixtureFile = path.join(temp, 'fixture.json');
  // Same seed and isolated credential policy as tests/layout-fixture.mjs.
  const env = { PATH: process.env.PATH, NODE_ENV: 'test', PHONE_QA_FIXTURE_FILE: fixtureFile, DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'), CLI_PROFILES_DIR: path.join(temp, 'profiles'), SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', SESSION_SECRET: 'ui-agent-fixture', COMPUTER_PROVIDER: 'local', INKBOX_TUNNEL: '0', DEV_LOGIN: '1', PORT: String(apiPort), APP_URL: base, SERVER_URL: base, WHATSAPP_DISABLED: '1', UI_CUSTOMIZATION: 'on', LLM_PROVIDER: 'direct', DIRECT_API_KEY: 'fixture-only', DIRECT_BASE_URL: `${model}/v1`, DIRECT_MODEL: 'gpt-4.1' };
  const preload = path.join(temp, 'offline.mjs');
  fs.writeFileSync(preload, `const local=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(input instanceof Request?input.url:input);if(['localhost','127.0.0.1'].includes(u.hostname))return local(input,init);return Promise.resolve(Response.json({data:[],items:[]}));};`);
  // Provider control stays outside chat history and every rendered screen.
  let script = '', prompt = '';
  const proxy = http.createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      let body = Buffer.concat(chunks).toString();
      if (request.url.startsWith('/v1/responses') && body) {
        const input = JSON.parse(body), user = [...(input.input ?? [])].reverse().find(item => item.role === 'user');
        if (user && script) user.content = `${prompt}\nmock: ${script}`;
        body = JSON.stringify(input);
      }
      const upstream = await fetch(`${model}${request.url}`, { method: request.method,
        headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-only' },
        ...(body ? { body } : {}) });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch { response.writeHead(502); response.end('Local provider unavailable'); }
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  env.DIRECT_BASE_URL = `http://127.0.0.1:${proxy.address().port}/v1`;
  const children = [], logs = [];
  const start = (args, cwd = root, extra = {}) => {
    const child = spawn(process.execPath, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(String(data))); return child;
  };
  const ready = async (url, child) => { for (let i = 0; i < 300; i++) { assert.equal(child.exitCode, null, logs.join('')); if (await fetch(url).then(r => r.ok).catch(() => false)) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(`Fixture did not start: ${logs.join('')}`); };
  const close = async () => { for (const child of children) if (child.exitCode === null) child.kill(); await Promise.all(children.filter(child => child.exitCode === null).map(child => once(child, 'exit'))); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); fs.rmSync(temp, { recursive: true, force: true }); };
  try {
    await ready(`${model}/_requests`, start(['tests/mock-provider.mjs', String(modelPort)]));
    const seed = start(['--import', preload, '--import', 'tsx', 'tests/fixtures/layout.seed.mts']);
    assert.equal((await once(seed, 'exit'))[0], 0, logs.join(''));
    await ready(`${api}/api/health`, start(['--import', preload, '--import', 'tsx', 'server/src/index.ts']));
    await ready(base, start(['--input-type=module', '-e', `
      import { createServer } from ${JSON.stringify(path.join(root, 'web/node_modules/vite/dist/node/index.js'))};
      const server = await createServer({ root: ${JSON.stringify(path.join(root, 'web'))}, cacheDir: ${JSON.stringify(path.join(temp, 'vite-cache'))}, server: { host: '127.0.0.1', port: ${uiPort}, strictPort: true } });
      await server.listen();
    `], path.join(root, 'web'), { SWARM_API: api }));
    const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));
    const db = new Database(env.DB_PATH);
    return { base, api, model, fixture, db, logs, setScript: (value, text) => { script = value; prompt = text; }, close: async () => { db.close(); await close(); }, request: async (method, route, input, revision) => {
      const response = await fetch(`${api}/api${route}`, { method, headers: { cookie: 'swarm_session=layout-test-token', origin: base, ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      return { status: response.status, body: await response.json() };
    } };
  } catch (error) { await close(); throw error; }
}

/** Send a chat message through the mock provider and wait for the real tool's preview card. */
async function proposeChat(fixture, tool, args, request, script = `${tool} ${JSON.stringify(args)}`) {
  const botId = fixture.fixture.bot.id;
  const after = fixture.db.prepare('SELECT coalesce(max(seq),0) seq FROM rows WHERE bot_id=?').get(botId).seq;
  const before = (await fixture.request('GET', '/ui/config')).body;
  const controlled = `${script} | say Preview ready. Press Apply to keep it.`;
  fixture.setScript?.(controlled, request);
  const message = fixture.setScript ? request : `${request}\nmock: ${controlled}`;
  const sent = await fixture.request('POST', `/bots/${botId}/messages`, { text: message });
  assert.equal(sent.status, 200, JSON.stringify(sent));
  const findCard = () => fixture.db.prepare("SELECT body FROM rows WHERE bot_id=? AND seq>? AND kind='card' AND json_extract(body,'$.card')='ui_preview' ORDER BY seq DESC LIMIT 1").get(botId, after);
  const wait = async check => {
    for (let n = 0; n < 300; n++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`Chat widget edit timed out: ${fixture.logs.join('')}`);
  };
  const card = JSON.parse((await wait(findCard)).body);
  await wait(() => fixture.db.prepare('SELECT state FROM agent_jobs WHERE id=?').get(card.jobId)?.state === 'completed');
  const calls = fixture.db.prepare("SELECT body FROM rows WHERE bot_id=? AND seq>? AND kind='tool-call' AND json_extract(body,'$.name')=? ORDER BY seq").all(botId, after, tool).map(row => JSON.parse(row.body));
  assert.ok(calls.length, `${tool} ran through the agent dispatcher`);
  assert.ok(calls.some(call => call.status === 'done'), JSON.stringify(calls));
  const requests = await fetch(`${fixture.model}/_requests`).then(response => response.json());
  const toolResults = (Array.isArray(requests) ? requests : requests.requests).flatMap(item => item.body?.input ?? [])
    .filter(item => item.type === 'function_call_output' && String(item.output).includes(card.previewId));
  assert.ok(toolResults.length, 'The mock provider received the real preview result');
  const current = (await fixture.request('GET', '/ui/config')).body;
  assert.deepEqual(current.doc, before.doc, 'Chat edits only preview until the user applies');
  assert.equal(current.revision, before.revision);
  return { message, tool, args, previewId: card.previewId, beforeRevision: before.revision, calls, toolResults };
}

export async function proposeChatWidgetEdit(fixture, tool, args, request) {
  assert.ok(['add_widget', 'remove_widget', 'move_widget', 'update_widget'].includes(tool));
  return proposeChat(fixture, tool, args, request);
}
export async function proposeChatSuggestion(fixture, fields, request) {
  const patch = Object.entries(fields).map(([key, value]) => ({ op: 'add', path: `/${key}`, value }));
  const script = `get_requirements {} | update_requirements ${JSON.stringify({ patch })} | preview_adaptation {}`;
  const proposed = await proposeChat(fixture, 'preview_adaptation', {}, request, script);
  const saved = await fixture.request('GET', '/ui/requirements');
  assert.equal(saved.status, 200, JSON.stringify(saved));
  for (const [key, value] of Object.entries(fields)) assert.deepEqual(saved.body.profile[key], value);
  assert.equal(saved.body.profile.updatedBy, 'agent');
  return { ...proposed, profile: saved.body.profile };
}

/** Isolated seeded server, local mock provider, real browser and apply flow. */
export async function runSuggestionUi(directory = '.context/ui-custom/suggest-dashboard-ui') {
  const before = process.env.SUGGEST_PHASE === 'before';
  const evidence = path.resolve(process.env.SUGGEST_EVIDENCE || directory); fs.mkdirSync(evidence, { recursive: true });
  const accounts = { sales: await suggestionFixture(), operations: await suggestionFixture() };
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const report = [], screenshots = [], quality = [], browserErrors = [];
  const profiles = {
    sales: { role: 'Sales', goals: ['Follow ups and pipeline'], workflows: [], focus: ['tasks', 'bots'] },
    operations: { role: 'Operations', goals: ['Daily summary and usage'], workflows: [], focus: ['routines', 'usage'] },
  };
  for (const fixture of Object.values(accounts)) {
    fixture.db.prepare('UPDATE users SET name=? WHERE id=?').run('Test User', fixture.fixture.userId);
    fixture.db.prepare("UPDATE tasks SET title='Draft the launch email' WHERE id='task_phoneqaPress'").run();
    fixture.db.prepare("UPDATE tasks SET title='Review the daily summary' WHERE id='task_phoneqaReview'").run();
    fixture.db.prepare('INSERT INTO account_preferences(user_id,updated_at,ui_custom_enabled,ui_adapt) VALUES(?,?,1,1) ON CONFLICT(user_id) DO UPDATE SET ui_custom_enabled=1,ui_adapt=1').run(fixture.fixture.userId, Date.now());
  }
  const variants = [320, 390, 500, 1280].flatMap(width => ([390, 1280].includes(width) ? ['light', 'dark'] : ['light']).map(theme => ({ width, theme })));
  const pass = (name, variant) => { report.push({ name, ...variant }); console.log(`PASS UC-Y ${variant.width} ${variant.theme}: ${name}`); };
  const check = (result) => { assert.equal(result.status, 200, JSON.stringify(result)); return result.body; };
  const capture = async (page, name, variant) => {
    await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(200);
    const audit = await page.evaluate(inspectSuggestionQuality);
    const selector = '.app-settings__page, .dashboard-page';
    if (await page.locator(selector).isVisible().catch(() => false)) audit.issues.push(...await page.evaluate(inspectAlignment, { selector }));
    if (!before && await page.locator(selector).isVisible().catch(() => false)) {
      try { await readableWords(page.locator(selector)); } catch (error) { audit.issues.push(error.message); }
    }
    quality.push({ name, ...variant, ...audit });
    const file = `${variant.width}-${variant.theme}-${name}.png`;
    await page.screenshot({ path: path.join(evidence, file), fullPage: true }); screenshots.push(file);
    if (!before) assert.deepEqual(audit.issues, [], `${name}: ${JSON.stringify(audit.issues)}`);
  };
  const nav = async page => {
    const state = await page.evaluate(async () => {
      const { useCustomization } = await import('/src/customization/store.ts');
      return useCustomization.getState().effective.layout;
    });
    const tabs = await page.locator('.phone-tabs button').allTextContents();
    if (!before) {
      assert.ok(!tabs.includes('More'));
      assert.equal(await page.locator('a[href^="#all"]').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'All sections', exact: true }).count(), 0);
    }
    if (await page.getByRole('button', { name: 'Open navigation', exact: true }).isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.sidebar:has([aria-label="Tasks"]) [aria-label="Tasks"]')?.getAttribute('title')?.startsWith('Pending'));
    const sidebar = await page.locator('.sidebar:visible .sidebar-island:not(.sidebar__dashboards *)').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') || node.textContent));
    return { state, tabs, sidebar };
  };
  try {
    for (const variant of variants) {
      const { width, theme } = variant, contexts = [], pages = {};
      try {
        for (const [kind, fixture] of Object.entries(accounts)) {
          for (const table of ['ui_previews', 'ui_config_history', 'ui_config', 'ui_requirements']) fixture.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(fixture.fixture.userId);
          const context = await browser.newContext({ baseURL: fixture.base, viewport: { width, height: width <= 760 ? 844 : 1000 }, colorScheme: theme, reducedMotion: 'reduce' }); contexts.push(context);
          await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: fixture.base }]);
          await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
          await context.addInitScript(({ id, theme }) => { if (location.origin !== 'null') { localStorage.setItem(`swarm.ui.migrated:${id}`, '1'); localStorage.setItem('swarm.sidebarCollapsed', '0'); localStorage.setItem('swarm.theme', theme); } }, { id: fixture.fixture.userId, theme });
          const page = await context.newPage(); pages[kind] = page; page.setDefaultTimeout(20000);
          page.on('pageerror', error => browserErrors.push(error.message));
          check(await fixture.request('PUT', '/ui/requirements', { patch: Object.entries(profiles[kind]).map(([key, value]) => ({ op: 'add', path: `/${key}`, value })) }, 0));
          await page.goto('/'); await page.locator('.shell-header').waitFor();
          await page.waitForFunction(async () => (await import('/src/customization/store.ts')).useCustomization.getState().status === 'ready' && !!location.hash);
        }
        const sales = accounts.sales, page = pages.sales;
        const initial = check(await sales.request('GET', '/ui/config'));
        assert.deepEqual(initial.doc, check(await accounts.operations.request('GET', '/ui/config')).doc);
        const home = await page.evaluate(() => location.hash);
        assert.equal(home.replace(/~[^/]+/, ''), (await pages.operations.evaluate(() => location.hash)).replace(/~[^/]+/, ''));
        const firstNav = await nav(page), secondNav = await nav(pages.operations);
        assert.deepEqual(firstNav, secondNav);
        await capture(page, 'sales-navigation', variant); await capture(pages.operations, 'operations-navigation', variant);
        pass('two profiles have identical API and browser navigation, tabs and home', variant);
        await page.goto(`/${SUGGESTION_ROUTES[0].hash}`);
        const screen = page.getByRole('region', { name: before ? 'About your use' : 'About you', exact: true }); await screen.waitFor();
        let card;
        if (before) {
          await screen.getByRole('textbox', { name: 'Role', exact: true }).waitFor();
          await capture(page, SUGGESTION_ROUTES[0].name, variant);
          // Save through the UI; it must not produce any config revision or preview.
          await screen.getByRole('textbox', { name: 'Goals', exact: true }).fill('Draft the launch email');
          await screen.getByRole('button', { name: 'Save changes', exact: true }).click();
          await screen.getByText('Saved', { exact: true }).waitFor();
          assert.deepEqual(check(await sales.request('GET', '/ui/config')), initial);
          pass('editing and saving the profile leaves the full config unchanged', variant);
          await screen.getByRole('button', { name: before ? 'Re-adapt' : 'Suggest a dashboard', exact: true }).scrollIntoViewIfNeeded();
          await capture(page, 'about-you-actions', variant);
          await screen.getByRole('button', { name: before ? 'Re-adapt' : 'Suggest a dashboard', exact: true }).click();
          card = screen.locator('.ui-preview-card'); await card.waitFor(); await card.scrollIntoViewIfNeeded();
        } else {
          await screen.getByText('Sales', { exact: true }).waitFor();
          assert.equal(await screen.getByRole('button').count(), 1);
          assert.equal(await screen.locator('input,textarea,select').count(), 0);
          await capture(page, SUGGESTION_ROUTES[0].name, variant);
          const profile = check(await sales.request('GET', '/ui/requirements'));
          const writes = [];
          const recordWrite = request => { if (request.method() !== 'GET' && /\/api\/(ui\/|bots\/[^/]+\/messages)/.test(request.url())) writes.push(request.url()); };
          page.on('request', recordWrite);
          await screen.getByRole('button', { name: 'Tell your agent', exact: true }).focus();
          await page.keyboard.press('Enter');
          await page.waitForURL(/#bot\//);
          await page.waitForFunction(() => document.querySelector('.composer__input')?.value === 'Help me describe my role and goals for my dashboards: ');
          assert.deepEqual(writes, []);
          page.off('request', recordWrite);
          assert.deepEqual(check(await sales.request('GET', '/ui/requirements')), profile);
          assert.deepEqual(check(await sales.request('GET', '/ui/config')), initial);
          pass('compact profile action opens an unsent draft without profile or layout writes', variant);
          await proposeChatSuggestion(sales, { ...profiles.sales, goals: ['Draft the launch email'] }, 'Suggest a sales dashboard for my launch follow ups.');
          await page.reload();
          card = page.locator('.ui-preview-card').last();
          await card.waitFor(); await card.scrollIntoViewIfNeeded();
          assert.deepEqual(check(await sales.request('GET', '/ui/config')), initial);
          pass('chat saves the profile and proposes a dashboard without changing layout', variant);
        }
        if (!before) {
          await card.getByText('Create dashboard: Sales', { exact: true }).waitFor();
          assert.ok((await card.locator('li').count()) >= 4 && (await card.locator('li').count()) <= 6);
        }
        await capture(page, SUGGESTION_ROUTES[1].name, variant);
        assert.deepEqual(check(await sales.request('GET', '/ui/config')), initial);
        await card.getByRole('button', { name: 'Apply', exact: true }).click();
        if (before) await card.getByText('Applied', { exact: true }).waitFor();
        else { await page.waitForFunction(() => location.hash.startsWith('#dash/')); await page.locator('.dashboard-page').waitFor(); }
        const applied = check(await sales.request('GET', '/ui/config'));
        assert.equal(applied.doc.dashboards.length, 1);
        if (!before) assert.deepEqual({ ...applied.doc, dashboards: initial.doc.dashboards }, initial.doc);
        pass('preview and Apply add exactly one dashboard', variant);
        const dashboard = applied.doc.dashboards[0];
        await page.goto(`/${SUGGESTION_ROUTES[2].hash.replace('{dashboard}', dashboard.id)}`); await page.locator('.dashboard-page').waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll('.dashboard-widget-cell')].every(cell => cell.dataset.widgetState === 'ready' || cell.getBoundingClientRect().top >= innerHeight));
        await capture(page, SUGGESTION_ROUTES[2].name, variant);
        await page.reload(); await page.locator('.dashboard-page').waitFor();
        assert.deepEqual(check(await sales.request('GET', '/ui/config')).doc, applied.doc);
        pass('dashboard persists after reload', variant);
        if (!before) {
          await page.goto('/'); await page.locator('.shell-header').waitFor(); await page.waitForFunction(expected => location.hash === expected, home); assert.equal(await page.evaluate(() => location.hash), home);
          const afterNav = await nav(page);
          assert.deepEqual(afterNav.state, firstNav.state); assert.deepEqual(afterNav.tabs, firstNav.tabs);
          assert.deepEqual(afterNav.sidebar, firstNav.sidebar);
          await capture(page, 'unchanged-navigation', variant);
          pass('suggestion does not change home, sidebar or phone tabs', variant);
          await page.goto(`/${SUGGESTION_ROUTES[0].hash}`); await screen.waitFor();
          const profile = check(await sales.request('GET', '/ui/requirements'));
          const cleared = check(await sales.request('DELETE', '/ui/requirements', {}, profile.revision));
          assert.equal(check(await sales.request('GET', '/ui/requirements')).profile, null);
          assert.deepEqual(check(await sales.request('GET', '/ui/config')).doc, applied.doc);
          check(await sales.request('PUT', '/ui/requirements', { undoReset: cleared.undoToken }, cleared.revision));
          await page.reload(); await screen.getByText('Sales', { exact: true }).waitFor();
          assert.equal(check(await sales.request('GET', '/ui/requirements')).profile.role, 'Sales');
          assert.deepEqual(check(await sales.request('GET', '/ui/config')).doc, applied.doc);
          pass('reset and Undo only change the profile', variant);
        }
      } finally { await Promise.all(contexts.map(context => context.close())); }
    }
    assert.deepEqual(browserErrors, []);
  } finally {
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ phase: before ? 'before' : 'after', passed: report.length, checks: report, quality, screenshots, browserErrors }, null, 2));
    await browser.close(); await Promise.all(Object.values(accounts).map(fixture => fixture.close()));
  }
  console.log(`UC-Y: ${report.length}/${report.length} passed; ${screenshots.length} screenshots; ${evidence}/report.json`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runSuggestionUi();

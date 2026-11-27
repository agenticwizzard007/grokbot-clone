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

import { inspectAlignment, ROUTES } from '../../layout-alignment-ui.mjs';
import { readableWords } from '../../paper-label-geometry.mjs';

/** Browser-side gate for the three UC-I surfaces, independent of the screenshot theme. */
export function inspectAdaptQuality() {
  const issues = [];
  let minContrast = Infinity, contrastSamples = 0;
  const forbidden = /\bmock\b|\bfixture\b|\bprivate\b|QA-|\bundefined\b|\bnull\b|\[object/i;
  const visibleText = document.body.innerText;
  const match = visibleText.match(forbidden);
  if (match) issues.push(`Forbidden visible text: ${match[0]}`);
  const root = document.querySelector('.dashboard-page, .app-settings__page:has([aria-label="About your use"]), .all-sections-page')
    || (location.hash === '#all' ? document.querySelector('.chat-pane [data-layout="page"]') : null);
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
    for (const gap of [style.rowGap, style.columnGap]) if (/px$/.test(gap) && parseFloat(gap) > 0 && parseFloat(gap) % 8 !== 0 && !(parseFloat(gap) === 4 && el.closest('button,input,select'))) issues.push(`Off-scale gap ${gap}: ${label(el)}`);
    if (el.matches('.layout-section__header h2') && (style.fontSize !== '13px' || style.lineHeight !== '18px' || style.fontWeight !== '600')) issues.push(`Section header style: ${label(el)}`);
  }
  return { issues: [...new Set(issues)], words: root.innerText.trim().split(/\s+/).filter(Boolean).length, contrastSamples, minContrast: Number.isFinite(minContrast) ? minContrast : null };
}

async function adaptationFixture() {
  const root = path.resolve(new URL('../../..', import.meta.url).pathname);
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
export async function proposeChatAdaptation(fixture, fields, request) {
  const patch = Object.entries(fields).map(([key, value]) => ({ op: 'add', path: `/${key}`, value }));
  const script = `get_requirements {} | update_requirements ${JSON.stringify({ patch })} | preview_adaptation {}`;
  const proposed = await proposeChat(fixture, 'preview_adaptation', {}, request, script);
  const saved = await fixture.request('GET', '/ui/requirements');
  assert.equal(saved.status, 200, JSON.stringify(saved));
  for (const [key, value] of Object.entries(fields)) assert.deepEqual(saved.body.profile[key], value);
  assert.equal(saved.body.profile.updatedBy, 'agent');
  return { ...proposed, profile: saved.body.profile };
}

/** Real UI, seeded SQLite, and the local mock provider. No provider credentials inherited. */
export async function runAdaptUi(directory = '.context/ui-custom/adapt-ui') {
  directory = process.env.ADAPT_EVIDENCE || directory;
  const phase = process.env.ADAPT_PHASE || 'after';
  const fixture = await adaptationFixture();
  const operationsFixture = await adaptationFixture();
  const evidence = path.resolve(directory); fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const report = [], screenshots = [], chatEdits = [], browserErrors = [], quality = [];
  let activeTheme = 'light';
  let active;
  const pass = (name, width, details = {}) => { report.push({ name, width, theme: activeTheme, ...details }); console.log(`PASS UC-I ${width}: ${name}`); };
  const accounts = {
    sales: { fixture, id: fixture.fixture.userId, cookie: 'layout-test-token' },
    operations: { fixture: operationsFixture, id: operationsFixture.fixture.userId, cookie: 'layout-test-token' },
  };
  for (const [kind, account] of Object.entries(accounts)) {
    account.fixture.db.prepare('UPDATE users SET name=? WHERE id=?').run(kind === 'sales' ? 'Sales workspace' : 'Operations workspace', account.id);
    account.fixture.db.prepare("UPDATE tasks SET title='Draft the launch email' WHERE id='task_phoneqaPress'").run();
    account.fixture.db.prepare("UPDATE tasks SET title='Review the daily summary' WHERE id='task_phoneqaReview'").run();
    account.fixture.db.prepare(`INSERT INTO account_preferences(user_id,updated_at,ui_custom_enabled,ui_adapt) VALUES(?,?,1,1)
      ON CONFLICT(user_id) DO UPDATE SET ui_custom_enabled=1,ui_adapt=1`).run(account.id, Date.now());
  }
  const request = async (page, method, route, data, revision) => {
    const response = await page.request.fetch(`/api/ui${route}`, { method, ...(data === undefined ? {} : { data }), headers: { ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }) } });
    assert.equal(response.status(), 200, `${method} ${route}: ${await response.text()}`); return response.json();
  };
  const resetUse = async (page, screen) => {
    await screen.getByRole('button', { name: 'Manage requirements', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Reset', exact: true }).click();
  };
  const capture = async (page, name, width) => {
    if (name.endsWith('-requirements')) await page.locator('.app-settings__main').evaluate(el => { el.scrollTop = 0; });
    if (name.endsWith('-chat-proposal') || name === 'chat-widget-preview' || name === 'support-preview') await page.locator('.ui-preview-card').last().scrollIntoViewIfNeeded();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.querySelectorAll('.dashboard-widget-cell')].every(cell => {
      const rect = cell.getBoundingClientRect();
      return !cell.checkVisibility() || rect.top >= innerHeight || rect.bottom <= 0 || cell.dataset.widgetState === 'ready';
    }));
    await page.waitForTimeout(150);
    const audit = await page.evaluate(inspectAdaptQuality);
    quality.push({ name, width, theme: activeTheme, ...audit });
    if (phase !== 'before') assert.deepEqual(audit.issues, [], `${width} ${activeTheme} ${name}: ${JSON.stringify(audit.issues)}`);
    const filename = `${width}${activeTheme === 'dark' ? '-dark' : ''}-${name}.png`;
    await page.screenshot({ path: path.join(evidence, filename), fullPage: true }); screenshots.push(filename);
  };
  const openChat = async (page, botId) => {
    await page.goto(`/#bot/${botId}`);
    await page.locator('.composer__input:not([disabled])').waitFor();
    await page.waitForFunction(async id => (await import('/src/store.ts')).useStore.getState().transcripts[id]?.loaded, botId);
  };
  try {
    const widths = (process.env.ADAPT_WIDTHS || '320,390,500,1280').split(',').map(Number);
    const variants = widths.flatMap(width => (process.env.ADAPT_DARK === '0' || ![390, 1280].includes(width) ? ['light'] : ['light', 'dark']).map(theme => ({ width, theme })));
    for (const { width, theme } of variants) {
      activeTheme = theme;
      const contexts = [];
      try {
        const pages = {};
        for (const [kind, account] of Object.entries(accounts)) {
          // These are freshly seeded fixture accounts in a temporary database only.
          for (const table of ['ui_previews', 'ui_config_history', 'ui_config', 'ui_requirements']) account.fixture.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(account.id);
          const context = await browser.newContext({ baseURL: account.fixture.base, viewport: { width, height: width <= 760 ? 844 : 1000 }, colorScheme: theme, reducedMotion: 'reduce' }); contexts.push(context);
          await context.addCookies([{ name: 'swarm_session', value: account.cookie, url: account.fixture.base }]);
          await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
          await context.addInitScript(id => { if (location.origin !== 'null') { localStorage.setItem(`swarm.ui.migrated:${id}`, '1'); localStorage.setItem('swarm.sidebarCollapsed', '0'); } }, account.id);
          const page = await context.newPage(); pages[kind] = page; active = page; page.setDefaultTimeout(20000);
          const errors = []; page.on('pageerror', e => { errors.push(e.message); browserErrors.push({ width, kind, message: e.message }); });
          await openChat(page, account.fixture.fixture.bot.id);
          const fields = kind === 'sales'
            ? { role: 'Sales', goals: ['Outreach and pipeline'], workflows: [{ name: 'Pipeline review', cadence: 'weekly' }], focus: ['tasks', 'routines', 'bots'] }
            : { role: 'Operations manager', goals: ['Daily report', 'Usage review'], workflows: [{ name: 'Daily report', cadence: 'daily' }], focus: ['routines', 'usage', 'apps'] };
          const chatProposal = await proposeChatAdaptation(account.fixture, fields, kind === 'sales' ? 'I run outbound sales. I need follow ups and a weekly pipeline review.' : 'I manage operations. I need a daily report and usage review.');
          const proposalCard = page.locator('.ui-preview-card').last();
          await proposalCard.waitFor(); await capture(page, `${kind}-chat-proposal`, width);
          await proposalCard.getByRole('button', { name: 'Apply', exact: true }).click();
          await proposalCard.getByText('Applied', { exact: true }).waitFor();
          chatEdits.push({ width, kind, ...chatProposal });
          pass(`${kind} requirements captured and proposed through chat`, width);
          await page.goto('/#settings/appearance/use');
          const screen = page.getByRole('region', { name: 'About your use', exact: true }); await screen.waitFor();
          await screen.getByLabel('Role', { exact: true }).fill(kind === 'sales' ? 'Sales' : 'Operations manager');
          await screen.getByLabel('Goals', { exact: true }).fill(kind === 'sales' ? 'Outreach and pipeline\nWeekly review' : 'Daily report\nUsage review\nTeam reports');
          assert.equal(await screen.getByRole('button', { name: kind === 'sales' ? 'Tasks' : 'Usage', exact: true }).getAttribute('aria-pressed'), 'true');
          const revision = (await request(page, 'GET', '/config')).revision;
          await screen.getByRole('button', { name: 'Save changes', exact: true }).click();
          await screen.getByText('Saved', { exact: true }).waitFor();
          assert.equal((await request(page, 'GET', '/config')).revision, revision, 'Saving requirements does not change appearance');
          if (phase !== 'before') assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '.app-settings' }), []);
          await readableWords(screen); await capture(page, `${kind}-requirements`, width);
          pass(`${kind} profile edit and alignment`, width);
          await screen.getByRole('button', { name: 'Re-adapt', exact: true }).click();
          const card = screen.locator('.ui-preview-card'); await card.getByRole('button', { name: 'Apply', exact: true }).waitFor();
          await capture(page, `${kind}-preview`, width);
          await card.getByRole('button', { name: 'Apply', exact: true }).click();
          await card.getByText('Applied', { exact: true }).waitFor();
          await page.goto('/');
          await page.waitForURL(/#dash\//); await page.getByText('Suggested Bots', { exact: true }).waitFor();
          const config = await request(page, 'GET', '/config');
          fs.writeFileSync(path.join(evidence, `${width}-${kind}-config.json`), JSON.stringify(config, null, 2));
          await capture(page, `${kind}-home`, width);
          assert.ok(await page.locator('.dashboard-stat, .dashboard-list, .dashboard-empty-data').count());
          await page.getByText('Suggested Bots', { exact: true }).scrollIntoViewIfNeeded();
          await capture(page, `${kind}-suggestions`, width);
          await page.locator('.dashboard-heading').scrollIntoViewIfNeeded();
          if (width <= 760) { await page.getByRole('navigation', { name: 'App navigation', exact: true }).waitFor(); assert.ok(await page.getByRole('button', { name: 'More', exact: true }).isVisible()); }
          assert.deepEqual(errors, []); pass(`${kind} home, navigation and suggestions`, width);
        }
        const sales = await request(pages.sales, 'GET', '/config'), ops = await request(pages.operations, 'GET', '/config');
        assert.notEqual(sales.doc.dashboards[0].name, ops.doc.dashboards[0].name);
        assert.notDeepEqual(sales.doc.layout.phoneTabs, ops.doc.layout.phoneTabs);
        assert.notDeepEqual(sales.doc.layout.sidebar.order, ops.doc.layout.sidebar.order);
        pass('use cases produce distinct apps', width);
        const salesPage = pages.sales, dashboard = sales.doc.dashboards[0];
        const widget = dashboard.widgets.find(item => item.type === 'list');
        assert.ok(widget, 'The sales home has a data list to resize');
        await capture(salesPage, 'chat-widget-before', width);
        await openChat(salesPage, fixture.fixture.bot.id);
        const chat = await proposeChatWidgetEdit(fixture, 'update_widget', {
          dashboardId: dashboard.id, widgetId: widget.id, set: { span: 12, rows: 2 },
        }, 'Make the follow ups widget full width and two rows tall.');
        const chatCard = salesPage.locator('.ui-preview-card').last();
        await chatCard.waitFor(); await capture(salesPage, 'chat-widget-preview', width);
        await chatCard.getByRole('button', { name: 'Apply', exact: true }).click();
        await chatCard.getByText('Applied', { exact: true }).waitFor();
        await salesPage.goto('/'); await salesPage.waitForURL(/#dash\//);
        await salesPage.getByText('Suggested Bots', { exact: true }).waitFor();
        const edited = await request(salesPage, 'GET', '/config');
        assert.equal(edited.doc.dashboards[0].widgets.find(item => item.id === widget.id).span, 12);
        assert.equal(edited.doc.dashboards[0].widgets.find(item => item.id === widget.id).rows, 2);
        await salesPage.reload(); await salesPage.getByText('Suggested Bots', { exact: true }).waitFor();
        assert.deepEqual((await request(salesPage, 'GET', '/config')).doc, edited.doc);
        await capture(salesPage, 'chat-widget-after', width);
        chatEdits.push({ width, ...chat, revision: edited.revision });
        pass('chat widget resize previews, applies and persists', width);
        const page = pages.operations; active = page;
        await capture(page, 'operations-before-support', width);
        // A managed path edited by hand must survive the next requirements change.
        const handOrder = [...ops.doc.layout.sidebar.order].reverse();
        await request(page, 'PATCH', '/config', [
          { op: 'replace', path: '/layout/sidebar/order', value: handOrder },
          { op: 'replace', path: '/layout/sidebar/width', value: 'wide' },
        ], ops.revision);
        await openChat(page, operationsFixture.fixture.bot.id);
        const changed = await proposeChatAdaptation(operationsFixture, { role: 'Support team', goals: ['Response queue'],
          workflows: [{ name: 'Queue review', cadence: 'daily' }], focus: ['tasks', 'chat', 'team'] }, 'Actually I now lead a support team. I need a daily response queue review.');
        assert.ok(changed.toolResults.some(item => {
          try { return JSON.parse(item.output).kept?.some(value => value.path === '/layout/sidebar/order'); } catch { return false; }
        }), 'The preview reports the hand-edited sidebar order as kept');
        chatEdits.push({ width, kind: 'support', ...changed });
        const supportCard = page.locator('.ui-preview-card').last();
        await supportCard.getByRole('button', { name: 'Apply', exact: true }).waitFor();
        await capture(page, 'support-preview', width);
        await supportCard.getByRole('button', { name: 'Apply', exact: true }).click(); await supportCard.getByText('Applied', { exact: true }).waitFor();
        await page.goto('/'); await page.waitForURL(/#dash\//); await page.getByText('Suggested Bots', { exact: true }).waitFor();
        await capture(page, 'support-after', width);
        const support = await request(page, 'GET', '/config'); assert.equal(support.doc.dashboards[0].name, 'Support queue'); assert.equal(support.doc.layout.sidebar.width, 'wide'); assert.deepEqual(support.doc.layout.sidebar.order, handOrder);
        pass('operations to support preserves a hand edit', width);
        await page.getByRole('button', { name: width <= 760 ? 'More' : 'All sections', exact: true }).click();
        await page.getByRole('heading', { name: 'All sections', exact: true }).waitFor(); await page.locator('.all-sections-page').waitFor();
        for (const name of ['Bots', 'Tasks', 'Files', 'Routines', 'Settings']) assert.ok(await page.getByRole('link', { name, exact: true }).count());
        await capture(page, 'all-sections', width); pass('All sections remains reachable', width);
        await page.goto('/#search'); await page.getByRole('link', { name: 'All sections', exact: true }).click();
        await page.waitForURL('**/#all'); pass('command palette opens All sections', width);
        await page.goto('/#settings/appearance/use');
        const screen = page.getByRole('region', { name: 'About your use', exact: true }); await screen.waitFor();
        assert.equal(await screen.getByLabel('Role', { exact: true }).inputValue(), 'Support team');
        const card = screen.locator('.ui-preview-card');
        await resetUse(page, screen);
        await card.getByRole('button', { name: 'Apply', exact: true }).waitFor(); await card.getByRole('button', { name: 'Apply', exact: true }).click();
        await card.getByText('Applied', { exact: true }).waitFor();
        assert.equal((await request(page, 'GET', '/requirements')).profile, null);
        await capture(page, 'reset', width);
        await screen.getByRole('button', { name: 'Undo reset', exact: true }).click();
        await screen.getByText('Reset undone', { exact: true }).waitFor();
        assert.equal((await request(page, 'GET', '/requirements')).profile.role, 'Support team');
        assert.deepEqual((await request(page, 'GET', '/config')).doc, support.doc);
        await capture(page, 'reset-undone', width); pass('Reset and Undo restore the profile and app', width);
        // Exercise the same requirements actions in the existing dark mode.
        // This changes only the browser preference, never the saved appearance.
        if (theme === 'light' && [390, 1280].includes(width)) {
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.goto('/#settings/appearance/use');
        await screen.getByLabel('Role', { exact: true }).waitFor();
        await page.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === 'dark');
        await screen.getByLabel('Role', { exact: true }).fill('Support team');
        await screen.getByRole('button', { name: 'Save changes', exact: true }).click();
        await screen.getByText('Saved', { exact: true }).waitFor();
        await screen.getByRole('button', { name: 'Re-adapt', exact: true }).click();
        await card.getByRole('button', { name: 'Apply', exact: true }).click();
        await card.getByText('Applied', { exact: true }).waitFor();
        const darkConfig = await request(page, 'GET', '/config');
        assert.deepEqual(darkConfig.doc, support.doc);
        await resetUse(page, screen);
        await card.getByRole('button', { name: 'Apply', exact: true }).click();
        await card.getByText('Applied', { exact: true }).waitFor();
        await screen.getByRole('button', { name: 'Undo reset', exact: true }).click();
        await screen.getByText('Reset undone', { exact: true }).waitFor();
        assert.equal((await request(page, 'GET', '/requirements')).profile.role, 'Support team');
        assert.deepEqual((await request(page, 'GET', '/config')).doc, darkConfig.doc);
        if (phase !== 'before') assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '.app-settings' }), []);
        await readableWords(screen);
        pass('existing dark mode: edit, preview, Reset and Undo with complete labels', width);
        await page.emulateMedia({ colorScheme: 'light' });
        }
        // Finish the story on Reset, with the default arrangement visible.
        await resetUse(page, screen); await card.getByRole('button', { name: 'Apply', exact: true }).click(); await card.getByText('Applied', { exact: true }).waitFor();
        await page.goto('/#bots'); await capture(page, 'reset-home', width);
        if (width === 390 && theme === 'light') {
          const expectedRoutes = ROUTES.filter(route => !route.signedOut).map(route => route.hash.replace('{bot}', operationsFixture.fixture.bot.id).replace('{room}', operationsFixture.fixture.room)).concat('#loops', `#bot/${operationsFixture.fixture.bot.id}/details/flow`);
          for (const lens of ['sales', 'operations', 'support', 'engineering', 'research', 'creator', 'general']) {
            const current = await request(page, 'GET', '/requirements');
            const updated = await request(page, 'PUT', '/requirements', { patch: [
              { op: 'add', path: '/role', value: 'Workspace' }, { op: 'add', path: '/lens', value: lens },
            ] }, current.revision);
            const proposed = await request(page, 'POST', '/requirements/adapt', {}, updated.revision);
            const config = await request(page, 'GET', '/config');
            await request(page, 'POST', `/previews/${proposed.previewId}/apply`, {}, config.revision);
            await page.goto('/'); await page.waitForURL(/#dash\//);
            await page.getByRole('button', { name: 'More', exact: true }).click();
            await page.getByRole('heading', { name: 'All sections', exact: true }).waitFor(); await page.locator('.all-sections-page').waitFor();
            const reachability = await page.evaluate(async expected => {
              const { parseScreen, resolveScreen, screenHash } = await import('/src/lib/navigation.ts');
              const { useStore } = await import('/src/store.ts');
              const canonical = hash => { const parsed = parseScreen(hash); return parsed ? screenHash(resolveScreen(parsed, useStore.getState().bots, true)) : null; };
              const links = [...document.querySelectorAll('[data-layout="page"] a[href]')].map(link => link.getAttribute('href'));
              return { invalid: links.filter(link => !canonical(link)), missing: expected.filter(hash => !links.some(link => canonical(link) === canonical(hash))), links };
            }, expectedRoutes);
            assert.deepEqual(reachability.invalid, []); assert.deepEqual(reachability.missing, []);
            for (const href of ['#bots', '#tasks', '#loops', '#reports', '#search', '#new-bot', '#settings/usage', '#settings', '#all/routines']) assert.ok(reachability.links.includes(href), `${lens}: ${href}`);
            if (phase !== 'before') assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '.chat-pane' }), []);
            await readableWords(page.locator('[data-layout="page"]'));
            pass(`${lens}: every product route reachable through More in two taps`, width, { routeCount: new Set(expectedRoutes).size, maxTaps: 2 });
          }
          // Leave the seeded account at Reset after the reachability property check.
          const current = await request(page, 'GET', '/requirements');
          const reset = await request(page, 'DELETE', '/requirements', {}, current.revision);
          const config = await request(page, 'GET', '/config');
          await request(page, 'POST', `/previews/${reset.previewId}/apply`, {}, config.revision);
        }

      } catch (error) {
        if (active && !active.isClosed()) await active.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
        throw error;
      } finally { for (const context of contexts) await context.close(); }
    }
    assert.deepEqual(browserErrors, [], 'The complete adaptation journey has no browser errors');
  } catch (error) {
    if (active && !active.isClosed()) await active.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
    fs.writeFileSync(path.join(evidence, 'failure.txt'), String(error.stack)); throw error;
  } finally {
    await browser.close(); await fixture.close(); await operationsFixture.close();
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ passed: report.length, checks: report, screenshots, chatEdits, browserErrors, phase, quality }, null, 2));
  }
  for (const file of ['failure.png', 'failure.txt']) fs.rmSync(path.join(evidence, file), { force: true });
  console.log(`${report.length} passed, 0 failed. Demo: ${evidence}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runAdaptUi();

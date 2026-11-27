import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { inspectAlignment, ROUTES } from '../../layout-alignment-ui.mjs';
import { readableWords } from '../../paper-label-geometry.mjs';

/** Send a chat message through the mock provider and wait for the real tool's preview card. */
async function proposeChat(fixture, tool, args, request, script = `${tool} ${JSON.stringify(args)}`) {
  const botId = fixture.fixture.bot.id;
  const after = fixture.db.prepare('SELECT coalesce(max(seq),0) seq FROM rows WHERE bot_id=?').get(botId).seq;
  const before = (await fixture.request('GET', '/ui/config')).body;
  const message = `${request}\nmock: ${script} | say Preview ready. Press Apply to keep it.`;
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
  const { agentFixture } = await import('../agent-fixture.mjs');
  const fixture = await agentFixture();
  const operationsFixture = await agentFixture();
  const evidence = path.resolve(directory); fs.mkdirSync(evidence, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const report = [], screenshots = [], chatEdits = [];
  let active;
  const pass = (name, width, details = {}) => { report.push({ name, width, ...details }); console.log(`PASS UC-I ${width}: ${name}`); };
  const accounts = {
    sales: { fixture, id: fixture.fixture.userId, cookie: 'layout-test-token' },
    operations: { fixture: operationsFixture, id: operationsFixture.fixture.userId, cookie: 'layout-test-token' },
  };
  for (const [kind, account] of Object.entries(accounts)) {
    account.fixture.db.prepare('UPDATE users SET name=? WHERE id=?').run(`QA-Temp-${kind}`, account.id);
    account.fixture.db.prepare(`INSERT INTO account_preferences(user_id,updated_at,ui_custom_enabled,ui_adapt) VALUES(?,?,1,1)
      ON CONFLICT(user_id) DO UPDATE SET ui_custom_enabled=1,ui_adapt=1`).run(account.id, Date.now());
  }
  const request = async (page, method, route, data, revision) => {
    const response = await page.request.fetch(`/api/ui${route}`, { method, ...(data === undefined ? {} : { data }), headers: { ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }) } });
    assert.equal(response.status(), 200, `${method} ${route}: ${await response.text()}`); return response.json();
  };
  const capture = async (page, name, width) => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => [...document.querySelectorAll('.dashboard-widget-cell')].every(cell => {
      const rect = cell.getBoundingClientRect();
      return !cell.checkVisibility() || rect.top >= innerHeight || rect.bottom <= 0 || cell.dataset.widgetState === 'ready';
    }));
    await page.waitForTimeout(150);
    const filename = `${width}-${name}.png`;
    await page.screenshot({ path: path.join(evidence, filename), fullPage: true }); screenshots.push(filename);
  };
  try {
    for (const width of [390, 1280]) {
      const contexts = [];
      try {
        const pages = {};
        for (const [kind, account] of Object.entries(accounts)) {
          // These are freshly seeded fixture accounts in a temporary database only.
          for (const table of ['ui_previews', 'ui_config_history', 'ui_config', 'ui_requirements']) account.fixture.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(account.id);
          const context = await browser.newContext({ baseURL: account.fixture.base, viewport: { width, height: width === 390 ? 844 : 1000 }, reducedMotion: 'reduce' }); contexts.push(context);
          await context.addCookies([{ name: 'swarm_session', value: account.cookie, url: account.fixture.base }]);
          await context.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
          await context.addInitScript(id => { if (location.origin !== 'null') { localStorage.setItem(`swarm.ui.migrated:${id}`, '1'); localStorage.setItem('swarm.sidebarCollapsed', '0'); } }, account.id);
          const page = await context.newPage(); pages[kind] = page; active = page; page.setDefaultTimeout(20000);
          const errors = []; page.on('pageerror', e => errors.push(e.message));
          await page.goto(`/#bot/${account.fixture.fixture.bot.id}`);
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
          assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '.app-settings' }), []);
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
          await page.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
          if (width === 390) { await page.getByRole('navigation', { name: 'App navigation', exact: true }).waitFor(); assert.ok(await page.getByRole('button', { name: 'More', exact: true }).isVisible()); }
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
        await salesPage.goto(`/#bot/${fixture.fixture.bot.id}`);
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
        await page.goto(`/#bot/${operationsFixture.fixture.bot.id}`);
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
        await page.getByRole('button', { name: width === 390 ? 'More' : 'All sections', exact: true }).click();
        await page.getByRole('heading', { name: 'All sections', exact: true }).waitFor();
        for (const name of ['Bots', 'Tasks', 'Files', 'Routines', 'Settings']) assert.ok(await page.getByRole('link', { name, exact: true }).count());
        await capture(page, 'all-sections', width); pass('All sections remains reachable', width);
        await page.goto('/#search'); await page.getByRole('link', { name: 'All sections', exact: true }).click();
        await page.waitForURL('**/#all'); pass('command palette opens All sections', width);
        await page.goto('/#settings/appearance/use');
        const screen = page.getByRole('region', { name: 'About your use', exact: true }); await screen.waitFor();
        assert.equal(await screen.getByLabel('Role', { exact: true }).inputValue(), 'Support team');
        const card = screen.locator('.ui-preview-card');
        await screen.getByRole('button', { name: 'Reset', exact: true }).click();
        await card.getByRole('button', { name: 'Apply', exact: true }).waitFor(); await card.getByRole('button', { name: 'Apply', exact: true }).click();
        await card.getByText('Applied', { exact: true }).waitFor();
        assert.equal((await request(page, 'GET', '/requirements')).profile, null);
        await capture(page, 'reset', width);
        await screen.getByRole('button', { name: 'Undo reset', exact: true }).click();
        await screen.getByText('Reset undone', { exact: true }).waitFor();
        assert.equal((await request(page, 'GET', '/requirements')).profile.role, 'Support team');
        assert.deepEqual((await request(page, 'GET', '/config')).doc, support.doc);
        await capture(page, 'reset-undone', width); pass('Reset and Undo restore the profile and app', width);
        // Finish the story on Reset, with the default arrangement visible.
        await screen.getByRole('button', { name: 'Reset', exact: true }).click(); await card.getByRole('button', { name: 'Apply', exact: true }).click(); await card.getByText('Applied', { exact: true }).waitFor();
        await page.goto('/#bots'); await capture(page, 'reset-home', width);
        if (width === 390) {
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
            await page.getByRole('heading', { name: 'All sections', exact: true }).waitFor();
            const reachability = await page.evaluate(async expected => {
              const { parseScreen, resolveScreen, screenHash } = await import('/src/lib/navigation.ts');
              const { useStore } = await import('/src/store.ts');
              const canonical = hash => { const parsed = parseScreen(hash); return parsed ? screenHash(resolveScreen(parsed, useStore.getState().bots, true)) : null; };
              const links = [...document.querySelectorAll('[data-layout="page"] a[href]')].map(link => link.getAttribute('href'));
              return { invalid: links.filter(link => !canonical(link)), missing: expected.filter(hash => !links.some(link => canonical(link) === canonical(hash))), links };
            }, expectedRoutes);
            assert.deepEqual(reachability.invalid, []); assert.deepEqual(reachability.missing, []);
            for (const href of ['#bots', '#tasks', '#loops', '#reports', '#search', '#new-bot', '#settings/usage', '#settings', '#all/routines']) assert.ok(reachability.links.includes(href), `${lens}: ${href}`);
            assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '.chat-pane' }), []);
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
  } catch (error) {
    if (active && !active.isClosed()) await active.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
    fs.writeFileSync(path.join(evidence, 'failure.txt'), String(error.stack)); throw error;
  } finally {
    await browser.close(); await fixture.close(); await operationsFixture.close();
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify({ passed: report.length, checks: report, screenshots, chatEdits }, null, 2));
  }
  console.log(`${report.length} passed, 0 failed. Demo: ${evidence}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runAdaptUi();

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { layoutServer } from '../layout-fixture.mjs';
import { inspectAlignment } from '../layout-alignment-ui.mjs';
import { readableWords } from '../paper-label-geometry.mjs';

export async function runRoomsTasksDemo() {
  const root = path.resolve(process.env.HO_F_ROOT || '.');
  assert.ok(fs.existsSync(path.join(root, 'web/src/handoffs/SendSheet.tsx')), 'HO-D SendSheet is required; set HO_F_ROOT to a checkout containing HO-A, HO-D and HO-F.');
  const evidence = path.resolve('.context/handoffs/demo-f'); fs.mkdirSync(evidence, { recursive: true });
  const server = await layoutServer({ root });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const results = [], screenshots = [];
  try {
    for (const width of [390, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await context.addCookies([{ name: 'swarm_session', value: 'layout-test-token', url: server.base }]);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => { localStorage.setItem('swarm.theme', 'light'); });
      const from = server.fixture.bot;
      const roster = (await (await context.request.get(server.base + '/api/bots')).json()).bots;
      const room = roster.find(bot => bot.kind === 'room');
      const target = roster.find(bot => bot.id !== from.id && bot.kind !== 'room');
      assert.ok(target);
      const activeRoster = roster.map(bot => ({ ...bot, onboarding: { status: 'active' } }));
      activeRoster.push({ ...target, id: 'outside_fixture', name: 'Other agent' });
      const now = Date.now();
      let tasks = [
        { id: 'task_done_fixture', botId: from.id, title: 'Draft ready for a careful review', state: 'done', note: 'Test summary', updatedAt: now },
        { id: 'task_loop_fixture', botId: from.id, title: 'Review loop approval', state: 'needs_input', note: 'Loop needs your approval.', updatedAt: now, handoff: { loopId: 'lp_fixture', kind: 'loop' } },
        { id: 'task_receiver_fixture', botId: target.id, title: 'From Maker: Check the test draft', state: 'needs_input', note: 'Handoff needs your input.', updatedAt: now, handoff: { handoffId: 'ho_waiting', kind: 'receiver' } },
        { id: 'task_working_fixture', botId: from.id, title: 'Collect test references', state: 'working', note: '', updatedAt: now },
      ];
      const sends = [];
      let failSend = true, featureEnabled = true;
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/bots') return route.fulfill({ json: { bots: activeRoster, live: [] } });
        if (url.pathname === '/api/handoff-settings') return route.fulfill({ json: { settings: { enabled: featureEnabled, agentHandoffs: 'team' } } });
        if (url.pathname === '/api/handoff-task-links') return route.fulfill({ json: { links: Object.fromEntries(tasks.filter(t => t.handoff).map(t => [t.id, t.handoff])) } });
        if (url.pathname === '/api/needs-you') return route.fulfill({ json: { items: [] } });
        if (url.pathname.endsWith('/tasks')) return route.fulfill({ json: { tasks: (url.pathname.includes('/bots/') ? tasks.filter(t => t.botId === url.pathname.split('/')[3]) : tasks).map(({ handoff, ...task }) => task) } });
        if (url.pathname === '/api/handoff-links') return route.fulfill({ json: { links: [] } });
        if (url.pathname === '/api/handoffs' && route.request().method() === 'POST') {
          const body = route.request().postDataJSON(); sends.push(body);
          if (failSend) return route.fulfill({ status: 422, json: { error: 'Test target is busy. Try again.', code: 'busy' } });
          await new Promise(resolve => setTimeout(resolve, 100));
          return route.fulfill({ json: { handoff: { id: 'ho_sent_fixture', status: 'queued' } } });
        }
        return route.continue();
      });
      await page.goto(server.base + '/#tasks');
      const work = page.locator('.tasks-view');
      await work.getByText(tasks[0].title, { exact: true }).waitFor();
      await work.getByRole('button', { name: 'Send to agent', exact: true }).waitFor();
      assert.equal(await work.getByRole('button', { name: 'Send to agent', exact: true }).count(), 1, 'Only done task cards send');
      assert.match(await work.locator('[data-testid="tasks-needs-input"]').innerText(), /2 tasks need your input/);
      await work.getByText('Loop', { exact: true }).waitFor();
      assert.equal(await work.getByText('Loop', { exact: true }).count(), 1);
      assert.equal(await work.getByRole('link', { name: 'View', exact: true }).first().getAttribute('href'), '#loop/lp_fixture');
      const widths = await work.locator('.task-filters > button').evaluateAll(buttons => buttons.map(b => b.getBoundingClientRect().width));
      assert.ok(widths.every(w => Math.abs(w - widths[0]) <= 1), 'Filter cells stay equal width');
      assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '.tasks-view' }), []);
      await readableWords(work);
      const screenshot = async name => { const file = path.join(evidence, `${name}-${width}.png`); await page.screenshot({ path: file, fullPage: true }); screenshots.push(file); };
      await screenshot('tasks');
      await work.locator('.task-filters').getByRole('button', { name: 'Done', exact: true }).click();
      await screenshot('done-tasks');
      const send = work.getByRole('button', { name: 'Send to agent', exact: true });
      await send.click();
      const sheet = page.getByRole('dialog', { name: 'Send to agent', exact: true });
      await sheet.waitFor();
      await sheet.getByRole('button', { name: new RegExp(target.name) }).waitFor();
      assert.equal(await sheet.getByRole('button', { name: new RegExp(room.name) }).count(), 0, 'Rooms are not targets');
      assert.equal(await sheet.getByRole('button', { name: new RegExp(from.name) }).count(), 0, 'Sender is not a target');
      await sheet.getByRole('button', { name: new RegExp(target.name) }).click();
      await sheet.getByRole('button', { name: 'Send', exact: true }).click();
      await sheet.getByRole('alert').waitFor();
      assert.match(await sheet.getByRole('alert').innerText(), /busy/);
      failSend = false;
      assert.deepEqual(await page.evaluate(inspectAlignment, { selector: '.ho-dialog' }), []);
      await screenshot('send-task');
      await sheet.getByRole('button', { name: 'Send', exact: true }).evaluate(button => { button.click(); button.click(); });
      await sheet.waitFor({ state: 'hidden' });
      await work.getByRole('status').filter({ hasText: `Sent to ${target.name}` }).waitFor();
      assert.equal(sends.length, 2, 'One failed attempt and one successful request despite double click');
      assert.equal(sends[0].idempotencyKey, sends[1].idempotencyKey, 'Retry keeps its idempotency key');
      assert.deepEqual(sends[1].source, { taskId: 'task_done_fixture' });
      assert.equal(sends[1].toBotId, target.id);
      await screenshot('receipt');
      await send.click(); await sheet.waitFor(); await page.keyboard.press('Escape'); await sheet.waitFor({ state: 'hidden' });
      assert.equal(await send.evaluate(button => button === document.activeElement), true, 'Escape restores task action focus');
      results.push({ width, case: 'task send, inline error, double click, receipt and focus', pass: true });

      // The task response state is the count authority, including loop and receiver gates.
      tasks = tasks.map(task => task.handoff?.loopId ? { ...task, state: 'working' } : task);
      await page.evaluate(botId => window.dispatchEvent(new CustomEvent('swarm:event', { detail: { type: 'tasks', botId } })), from.id);
      await work.getByText('1 task needs your input', { exact: true }).waitFor();
      tasks = tasks.map(task => ({ ...task, state: 'done' }));
      await page.evaluate(botId => window.dispatchEvent(new CustomEvent('swarm:event', { detail: { type: 'tasks', botId } })), from.id);
      await page.waitForFunction(() => !document.querySelector('[data-testid="tasks-needs-input"]'));
      results.push({ width, case: 'loop and receiver input counts follow task updates', pass: true });
      await page.goto(server.base + `/#bot/${from.id}/details/tasks`);
      await page.getByRole('radio', { name: 'All', exact: true }).click();
      await page.getByRole('button', { name: 'Send to agent', exact: true }).first().waitFor();
      assert.equal(await page.locator('a[href="#loop/lp_fixture"]').count(), 1);
      assert.deepEqual(await page.evaluate(inspectAlignment), []);
      await screenshot('bot-tasks');
      results.push({ width, case: 'Bot Tasks actions, one Back and shared layout', pass: true });
      if (width === 390) assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
      featureEnabled = false;
      await page.reload();
      await page.getByRole('radio', { name: 'All', exact: true }).click();
      await page.getByText('Draft ready for a careful review', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Send to agent', exact: true }).count(), 0);
      assert.equal(await page.getByText('Loop', { exact: true }).count(), 0);
      // Mount the shared sheet with a room scope exactly as HO-I's message action does.
      await page.evaluate(async ({ from, target, roomId }) => {
        const reactModule = await import('/node_modules/.vite/deps/react.js');
        const React = reactModule.default ?? reactModule;
        const dom = await import('/node_modules/.vite/deps/react-dom_client.js');
        const createRoot = (dom.default ?? dom).createRoot;
        const { SendSheet } = await import('/src/handoffs/SendSheet.tsx');
        const host = document.createElement('div'); document.body.append(host);
        const root = createRoot(host);
        const close = () => { root.unmount(); host.remove(); };
        root.render(React.createElement(SendSheet, { open: true, senderId: from, roomId, roomMemberIds: [from, target],
          source: { taskId: 'task_done_fixture' }, title: 'Room test output', onClose: close, onSent: () => {} }));
      }, { from: from.id, target: target.id, roomId: room.id });
      const roomSheet = page.getByRole('dialog', { name: 'Send to agent', exact: true });
      await roomSheet.getByRole('button', { name: new RegExp(target.name) }).waitFor();
      assert.equal(await roomSheet.locator('.ho-target').count(), 1, 'Room scope lists its member first');
      assert.equal(await roomSheet.getByRole('button', { name: /Other agent|Project room/ }).count(), 0, 'Rooms and nonmembers cannot be selected');
      await screenshot('room-send');
      await roomSheet.getByRole('button', { name: 'Close', exact: true }).click(); await roomSheet.waitFor({ state: 'hidden' });
      results.push({ width, case: 'room member targets and room refusal', pass: true });
      assert.deepEqual(errors, []);
      results.push({ width, case: 'disabled handoffs hide task actions', pass: true });
      await context.close();
    }
    fs.writeFileSync(path.join(evidence, 'ui-results.json'), JSON.stringify({ results, screenshots }, null, 2));
    for (const result of results) console.log(`PASS ${result.width}: ${result.case}`);
    console.log(`HO-F UI: ${results.length} passed, 0 failed`);
    return { results, screenshots };
  } finally { await browser.close(); await server.close(); }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await runRoomsTasksDemo();

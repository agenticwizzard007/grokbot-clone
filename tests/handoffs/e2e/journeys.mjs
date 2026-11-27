import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tsImport } from 'tsx/esm/api';
const { parseScreen, resolveScreen } = await tsImport('../../../web/src/lib/navigation.ts', import.meta.url);
import { fixture, browserSession, api, poll, screenshot } from './fixture.mjs';
import { sendHandoff, startLoop, recordLoop, recordExistingLoop, finishedChat } from './loop-journey.mjs';
import { auditRoute, auditRoutes } from '../layout-ui.mjs';
import { goals } from '../mock-iter.mjs';
import { runUiQuality } from './visual-quality.mjs';
import { injections, xss } from '../security/corpus.mjs';

const evidence = path.resolve(process.env.HANDOFFS_EVIDENCE || '.context/handoffs/e2e-h');
const startedAt = Date.now();
const server = await fixture(evidence), results = [], details = [];
const uiQuality = await runUiQuality(evidence);
const go = (page, hash) => page.goto(`${server.base}/${hash}`);
const only = process.env.HANDOFFS_JOURNEYS?.split(',').map(Number);
try {
  for (const width of [390, 1280]) {
    const view = await browserSession(server, width), { page } = view, f = server.data;
    let handoffId, outputId, loopId;
    const check = async (number, name, run) => {
      if (only && !only.includes(number)) return;
      try { await go(page, '#bots'); await run(); results.push({ width, number, name, status: 'pass' }); console.log(`PASS ${width} journey ${number}: ${name}`); }
      catch (error) {
        const file = await screenshot(page, evidence, `journey-${number}-failure`, width);
        const diagnostic = {};
        try {
          if (number === 7 && handoffId) {
            diagnostic.handoffStatus = (await api(page, `/handoffs/${handoffId}`)).status;
            diagnostic.listedHandoffIds = (await api(page, `/handoffs?botId=${f.maker}`)).handoffs.map(handoff => handoff.id);
          }
          if (number === 9 && loopId) {
            diagnostic.loop = await api(page, `/loops/${loopId}`);
            diagnostic.loopEvents = (await api(page, `/loops/${loopId}/events`)).events;
            diagnostic.roomProgressRows = (await api(page, `/bots/${f.room}/rows`)).rows.filter(row => row.body.type === 'event' && row.body.ref?.startsWith(`#loop/${loopId}`));
          }
        } catch (reason) { diagnostic.error = reason.message; }
        results.push({ width, number, name, status: 'fail', error: error.stack, url: page.url(), screenshot: file, diagnostic });
        console.error(`FAIL ${width} journey ${number}: ${error.message}`);
      } finally {
        // Stop only test loops created in this isolated fixture, so a failed journey
        // cannot consume the next journey's concurrency slots.
        const list = await api(page, '/loops');
        for (const loop of list.loops.filter(l => ['running', 'paused', 'awaiting_approval'].includes(l.status))) await api(page, `/loops/${loop.id}/stop`, 'POST', {});
      }
    };
    await check(1, 'Finished run, send, receiver receipt and returned result', async () => {
      const handoff = await sendHandoff(page, f, evidence, width); handoffId = handoff.id;
      const detail = await api(page, `/handoffs/${handoffId}`); outputId = detail.sourceOutputId;
      await go(page, `#bot/${f.checker}`);
      const receipt = page.locator('.ho-receipt').filter({ has: page.locator(`a[href="#handoff/${handoffId}"]`) });
      await receipt.getByText('Handed off from Maker', { exact: true }).waitFor();
      await go(page, `#bot/${f.maker}`);
      await receipt.getByText('Completed', { exact: true }).waitFor();
      assert.ok(detail.resultOutputId);
      await receipt.getByRole('link', { name: /^View handoff/ }).click();
      await page.locator('.ho-output-card').filter({ hasText: 'The draft is clear.' }).waitFor();
      details.push({ width, journey: 1, handoff });
    });
    await check(2, 'Send from a done task and assistant message overflow', async () => {
      await go(page, '#tasks'); await page.locator('.task-filters .is-done').click();
      await page.locator('.task-card-frame').filter({ has: page.getByText('Release draft', { exact: true }) }).getByRole('button', { name: 'Send to agent', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'Send to agent' });
      await sheet.getByRole('button', { name: /^Checker/ }).click();
      await sheet.getByLabel('Ask', { exact: true }).fill('Review this finished task.');
      const sent = page.waitForResponse(r => r.url().endsWith('/api/handoffs') && r.request().method() === 'POST');
      await sheet.getByRole('button', { name: 'Send', exact: true }).click(); assert.ok((await sent).ok());
      await go(page, `#bot/${f.maker}`);
      // This older reply has no job output. Newer replies can briefly expose
      // Actions while their output lookup loads, then replace it with a card.
      // Load the historical page instead of racing one of those controls.
      const historical = page.locator('.bubble-wrap').filter({ hasText: 'The release outline is ready for a closer review.' });
      await poll(async () => {
        if (await historical.count()) return true;
        const earlier = page.getByRole('button', { name: 'Earlier messages', exact: true });
        if (await earlier.count()) await earlier.click();
        return false;
      }, Boolean, 'The historical reply is loaded');
      const seq = await historical.getAttribute('data-row-seq');
      await page.locator(`[data-row-seq="${seq}"] + .ho`).getByRole('button', { name: 'Message actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Send to agent', exact: true }).click();
      await sheet.getByRole('button', { name: /^Checker/ }).click();
      await sheet.getByLabel('Ask', { exact: true }).fill('Review this message.');
      const sentMessage = page.waitForResponse(r => r.url().endsWith('/api/handoffs') && r.request().method() === 'POST');
      await sheet.getByRole('button', { name: 'Send', exact: true }).click();
      const response = await sentMessage; assert.ok(response.ok());
      const created = await response.json(), id = (created.handoff ?? created).id;
      await page.locator('.ho-receipt').filter({ has: page.locator(`a[href="#handoff/${id}"]`) }).waitFor();
    });
    await check(3, 'Keep improving converges at pass 3 and Use this opens the output', async () => {
      const card = await finishedChat(page, { ...f, maker: f.checker }, width);
      await card.getByRole('button', { name: 'Send to agent', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'Send to agent' });
      await sheet.getByRole('button', { name: /^Maker/ }).click();
      await sheet.getByLabel('Ask', { exact: true }).fill(goals.converge);
      await sheet.getByLabel('Keep improving', { exact: true }).check();
      await sheet.getByLabel('Up to passes', { exact: true }).fill('3');
      await sheet.getByRole('button', { name: 'Start loop', exact: true }).click();
      await page.waitForURL(/#loop\/lp_/); loopId = new URL(page.url()).hash.slice(6);
      details.push(await recordExistingLoop(page, loopId, 'converge', evidence, width));
      await page.getByRole('button', { name: 'Use this', exact: true }).click();
      await page.waitForURL(/#output\/out_/); await page.getByRole('heading', { name: 'Parts', exact: true }).waitFor();
    });
    await check(4, 'Cap at 3, Continue 2 more passes, then Stop', async () => {
      const run = await recordLoop(page, f, 'cap', evidence, width); loopId = run.id; details.push(run);
      await page.getByText('More options', { exact: true }).click();
      await page.getByRole('button', { name: 'Continue 2 more passes', exact: true }).click();
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await page.getByText('Stopped by you.', { exact: true }).waitFor();
      assert.equal((await api(page, `/loops/${run.id}`)).spec.limits.maxIterations, 5);
    });
    await check(5, 'Agent gate, Tasks count, Approve and Decline', async () => {
      for (const action of ['Approve', 'Decline']) {
        const name = `Release review ${action} ${width}`;
        await go(page, `#bot/${f.maker}`);
        await page.locator('.composer textarea').fill(`Start a release review that needs my approval.\n${name}`);
        await page.locator('.composer').getByRole('button', { name: 'Send', exact: true }).click();
        const loop = await poll(() => api(page, '/loops'), r => r.loops.some(l => l.spec.name === name), 'Agent start_loop must create a gated loop', 15000).then(r => r.loops.find(l => l.spec.name === name));
        assert.equal(loop.status, 'awaiting_approval'); assert.equal(loop.initiatedBy, 'agent');
        await go(page, '#tasks'); await page.locator('.tasks-needs-input').waitFor();
        const tasks = await api(page, '/tasks');
        const count = tasks.tasks.filter(task => task.state === 'needs_input').length;
        assert.match(await page.locator('.tasks-needs-input').innerText(), new RegExp(`^${count} tasks? need`));
        await page.locator('.tasks-needs-input').getByRole('button', { name: 'Review', exact: true }).click();
        await page.getByText(`Approve loop: ${name}`, { exact: true }).waitFor();
        await go(page, `#loop/${loop.id}`);
        await page.getByRole('button', { name: action, exact: true }).click();
        const current = await api(page, `/loops/${loop.id}`);
        assert.equal(action === 'Approve' ? current.status : current.stopReason, action === 'Approve' ? 'running' : 'declined');
        if (action === 'Approve') await page.getByRole('button', { name: 'Stop', exact: true }).click();
      }
    });
    await check(6, 'Pause, resume and Stop mid loop with live updates', async () => {
      loopId = await startLoop(page, f, 'slow');
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
      assert.equal((await api(page, `/loops/${loopId}`)).status, 'paused');
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await page.getByText('Stopped by you.', { exact: true }).waitFor();
      assert.equal((await api(page, `/loops/${loopId}`)).stopReason, 'user_stopped');
      await page.waitForFunction(() => window.handoffEvents.some(event => event.type === 'loop'));
    });
    await check(7, 'Handoff detail, Activity handoff list and Back', async () => {
      if (!handoffId) handoffId = (await sendHandoff(page, f, evidence, width)).id;
      await go(page, `#bot/${f.maker}`);
      const receipt = page.locator('.ho-receipt').filter({ has: page.getByRole('link', { name: /^View handoff/ }) }).first();
      await receipt.waitFor();
      const chatHash = new URL(page.url()).hash;
      await receipt.getByRole('link', { name: /^View handoff/ }).click();
      await page.getByRole('heading', { name: 'Handoff', exact: true }).waitFor(); await auditRoute(page, width);
      await page.goBack(); await page.waitForURL(url => url.hash === chatHash);
      await go(page, `#bot/${f.maker}/details/activity`);
      await page.getByRole('group', { name: 'Handoff direction', exact: true }).waitFor({ timeout: 5000 });
      for (const filter of ['Sent', 'Received', 'All']) await page.getByRole('button', { name: filter, exact: true }).click();
      await auditRoute(page, width);
    });
    await check(8, 'Standing suggest link, Flow link editor and Settings automation controls', async () => {
      const card = await finishedChat(page, f, width);
      await card.getByRole('button', { name: 'Send to agent', exact: true }).click();
      const send = page.getByRole('dialog', { name: 'Send to agent' });
      const suggested = send.getByRole('button', { name: /^Checker/ });
      await suggested.getByText('Suggested', { exact: true }).waitFor(); await suggested.click();
      assert.match(await send.getByLabel('Ask', { exact: true }).inputValue(), /^Review /);
      await page.keyboard.press('Escape');
      await go(page, `#bot/${f.maker}/details/flow`); await page.locator('.flow-chart').waitFor();
      await page.locator('[data-kind="handoff_to"]').first().click();
      const sheet = page.getByRole('dialog', { name: 'Handoff links' });
      await sheet.getByLabel('Mode', { exact: true }).selectOption('auto');
      await sheet.getByRole('button', { name: 'Save link', exact: true }).click();
      assert.equal((await api(page, `/handoff-links?botId=${f.maker}`)).links[0].mode, 'auto');
      await page.locator('[data-kind="handoff_to"]').first().click();
      await sheet.getByLabel('Mode', { exact: true }).selectOption('suggest');
      await sheet.getByRole('button', { name: 'Save link', exact: true }).click();
      await go(page, '#settings/agents'); await page.locator('.agents-settings').waitFor();
      assert.equal(await page.getByRole('switch', { name: 'Enable handoffs and loops', exact: true }).isChecked(), true);
      await page.getByLabel('Links from', { exact: true }).selectOption(f.maker);
      const mode = page.getByLabel('Handoff mode for Checker', { exact: true });
      await mode.selectOption('auto');
      await poll(() => api(page, `/handoff-links?botId=${f.maker}`), r => r.links[0].mode === 'auto', 'Settings saves automatic mode');
      const approve = page.getByLabel('Auto approve loops started by agents with Checker', { exact: true });
      await approve.click();
      await poll(() => api(page, `/handoff-links?botId=${f.maker}`), r => r.links[0].autoApproveLoops, 'Settings saves pair approval');
      await poll(() => approve.isChecked(), Boolean, 'Settings renders saved pair approval');
      await approve.click();
      await poll(() => api(page, `/handoff-links?botId=${f.maker}`), r => !r.links[0].autoApproveLoops, 'Settings restores pair approval');
      await poll(() => approve.isChecked(), checked => !checked, 'Settings renders restored pair approval');
      await mode.selectOption('suggest');
      await poll(() => api(page, `/handoff-links?botId=${f.maker}`), r => r.links[0].mode === 'suggest', 'Settings restores suggestion mode');
      await auditRoute(page, width);
    });
    await check(9, 'Room progress rows and member-only Send targets', async () => {
      loopId = await startLoop(page, f, 'slow', { room: true });
      await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await go(page, `#bot/${f.room}`);
      await page.getByText(/Loop started|Loop stopped|Pass 1 of 3/).first().waitFor();
      assert.equal(await page.getByText('-----BEGIN DATA', { exact: false }).count(), 0);
      await page.getByRole('button', { name: 'Message actions', exact: true }).first().click();
      await page.getByRole('menuitem', { name: 'Send to agent', exact: true }).click();
      const names = await page.locator('.ho-target .layout-row__title').allTextContents();
      assert.deepEqual(names, ['Checker']); await page.keyboard.press('Escape');
    });
    await check(10, 'Three Flow fixtures, every displayed kind, keyboard, focus and live routine change', async () => {
      const kinds = new Set(), roster = (await api(page, '/bots')).bots;
      await startLoop(page, f, 'slow');
      await page.getByRole('button', { name: 'Pause', exact: true }).click();
      await page.getByRole('button', { name: 'Resume', exact: true }).waitFor();
      for (const id of [f.maker, f.empty, f.suggested]) {
        await go(page, `#bot/${id}/details/flow`); await page.locator('.flow-chart').waitFor();
        assert.deepEqual(await page.locator('.flow-lane h2').allTextContents(), ['1Triggers', '2Inputs', '3Steps', '4Outputs', '5Handoffs']);
        assert.match(await page.locator('.flow-chart p.flow-sr').innerText(), /^Flow:/); await auditRoute(page, width);
        const controls = page.locator('.flow-lanes button');
        await controls.first().focus();
        for (let n = 1; n < await controls.count(); n++) {
          await page.keyboard.press('Tab');
          assert.equal(await controls.nth(n).evaluate(el => el === document.activeElement), true, 'Keyboard follows lane reading order');
        }
        const model = await api(page, `/bots/${id}/flow`);
        for (const node of model.lanes.flatMap(lane => lane.nodes)) {
          const base = `#bot/${id}`;
          const destination = {
            schedule: `${base}/settings/routines`, routine: `${base}/settings/routines`, event: `${base}/settings/routines`,
            message: base, inbound_handoff: `${base}/details/flow`, handoff_to: `${base}/details/flow`, handoff_from: `${base}/details/flow`,
            app: '#settings/apps', mcp: '#settings/mcp', knowledge: `${base}/settings/memories`,
            suggested_app: '#apps/connect', suggested_mcp: '#settings/mcp', step: `${base}/details/setup/responsibilities`,
            skill: `${base}/settings/skills`, report: `${base}/details/files/reports`, files: `${base}/details/files`,
            message_out: '#settings/messaging', task: `${base}/details/tasks`, loop: `#loop/${node.id.split(':').slice(2).join(':')}`,
          }[node.kind];
          assert.ok(destination, `Known Flow kind: ${node.kind}`);
          assert.equal(node.target.hash.split('?')[0], destination, `Spec 16.5 destination for ${node.kind}`);
          const button = page.locator(`[data-flow-node="${node.id}"]`);
          await button.focus(); await page.keyboard.press('Enter');
          await page.waitForURL(url => parseScreen(url.hash) && JSON.stringify(resolveScreen(parseScreen(url.hash), roster, true)) === JSON.stringify(resolveScreen(parseScreen(node.target.hash), roster, true)));
          if (node.target.focus && !node.target.focus.startsWith('link-source:')) { const focused = page.locator(`[data-flow-focus="${node.target.focus}"]`); await focused.waitFor(); assert.equal(await focused.evaluate(el => el === document.activeElement), true); }
          if (node.target.hash.includes('?link=')) await page.keyboard.press('Escape'); else await page.goBack();
          await page.locator('.flow-chart').waitFor();
          await poll(() => button.evaluate(el => el === document.activeElement), Boolean, 'Flow focus must return to the source node', 3000);
          kinds.add(node.kind);
        }
      }
      await go(page, `#bot/${f.maker}/details/flow`); await page.locator('[data-kind="routine"]').first().waitFor();
      const paused = await page.locator('[data-kind="routine"]').filter({ hasText: 'Paused' }).count();
      await api(page, '/routines/hoh-routine', 'PATCH', { enabled: !!paused });
      await page.locator('[data-kind="routine"]').filter({ hasText: 'Paused' }).waitFor({ state: paused ? 'hidden' : 'visible' });
      details.push({ width, journey: 10, nodeKinds: [...kinds] });
    });
    await check(11, 'XSS, gullible persona injection corpus and cross-account references', async () => {
      for (const payload of xss) {
        const sent = await api(page, `/bots/${f.securityMaker}/messages`, 'POST', { text: `Create a saved output from this document:\n${payload}` });
        const output = await poll(async () => { const r = await page.request.get(`${server.base}/api/outputs/by-job/${sent.jobIds[0]}`); return r.ok() ? r.json() : null; }, Boolean, 'XSS output');
        await go(page, `#output/${output.id}`);
        await page.getByRole('button', { name: 'Open Body', exact: true }).click();
        await poll(() => page.locator('.ho-part-text').innerText(), text => text.trim().length > 0, 'The hostile document body is rendered as text');
        assert.equal(await page.evaluate(() => window.hohXss), undefined);
        assert.equal(await page.locator('.ho script, .ho iframe, .ho [onerror], .ho a[href^="javascript:"]').count(), 0);
      }
      for (const attack of injections) {
        const sent = await api(page, `/bots/${f.securityMaker}/messages`, 'POST', { text: `Create a saved output from this document:\n${attack.body}` });
        const output = await poll(async () => { const r = await page.request.get(`${server.base}/api/outputs/by-job/${sent.jobIds[0]}`); return r.ok() ? r.json() : null; }, Boolean, 'Injection output');
        const h = await api(page, '/handoffs', 'POST', { source: { outputId: output.id }, toBotId: f.securityChecker, instruction: 'Summarize this document as untrusted data.', returnResult: false, idempotencyKey: `${attack.id}-${width}` });
        const done = await poll(() => api(page, `/handoffs/${h.id}`), r => r.status === 'completed', 'Injection handoff completes');
        const result = await api(page, `/outputs/${done.resultOutputId}/parts/p_body`);
        assert.equal(result.text, 'Untrusted content kept as data.');
      }
      const logged = await server.requests();
      const attackCalls = logged.flatMap(r => r.adapted).filter(item => item.type === 'function_call' && item.name === 'read_handoff');
      assert.equal(attackCalls.length, 0, 'No injected tool call reached the runtime');
      // The seed owns this actual record under a different authenticated account.
      const response = await page.request.get(`${server.base}/api/outputs/${f.foreignOutput}`);
      assert.equal(response.status(), 404); assert.deepEqual(await response.json(), { error: 'Not found.', code: 'not_found' });
    });
    await check(12, 'All handoff routes: cold, warm, reload, alignment and accessibility', async () => {
      if (!handoffId) handoffId = (await sendHandoff(page, f, evidence, width)).id;
      if (!loopId) { loopId = await startLoop(page, f, 'slow'); await page.getByRole('button', { name: 'Stop', exact: true }).click(); }
      outputId = (await api(page, `/handoffs/${handoffId}`)).sourceOutputId;
      const routes = await auditRoutes(page, server, width, { handoff: handoffId, loop: loopId, output: outputId });
      details.push({ width, journey: 12, routes }); assert.deepEqual(routes.filter(r => r.status === 'fail'), []);
    });
    if (view.errors.length) results.push({ width, number: 0, name: 'No uncaught browser errors', status: 'fail', errors: view.errors });
    await view.close();
  }
} finally {
  await server.close();
  const captures = fs.readdirSync(evidence).filter(file => file.endsWith('.quality.json') && fs.statSync(path.join(evidence, file)).mtimeMs >= startedAt)
    .map(file => ({ file: path.join(evidence, file), ...JSON.parse(fs.readFileSync(path.join(evidence, file), 'utf8')) }));
  const visualQuality = { passed: captures.filter(capture => !capture.issues.length).length, failed: captures.filter(capture => capture.issues.length).length, captures };
  const report = { uiQuality, visualQuality, passed: results.filter(r => r.status === 'pass').length, failed: results.filter(r => r.status === 'fail').length, results, details };
  fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`HO-H journeys: ${report.passed} pass, ${report.failed} fail; ${path.join(evidence, 'report.json')}`);
  console.log(`${visualQuality.failed ? 'FAIL' : 'PASS'} Real journey visual quality: ${visualQuality.passed} pass, ${visualQuality.failed} fail`);
  if (report.failed || uiQuality.status === 'fail' || visualQuality.failed) process.exitCode = 1;
}

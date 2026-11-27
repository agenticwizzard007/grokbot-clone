import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loopFixture, recordedRun } from './ui-e-fixture.mjs';
import { audit } from './ui-e-layout.mjs';

const fixture = await loopFixture({ output: '.context/handoffs/ui-e-behavior' });
const results = [];
async function check(name, action) { await action(); results.push(name); console.log(`PASS ${name}`); }
try {
  for (const width of [390, 1280]) {
    fixture.reset();
    const view = await fixture.page(width), { page } = view;
    await check(`${width} filters and empty state`, async () => {
      await view.open(); await page.getByRole('button', { name: 'Done', exact: true }).click();
      assert.equal(await page.locator('.ho-loop-title-link').count(), 1);
      fixture.state.listEmpty = true; fixture.broadcast('lp_converged');
      await page.getByText('Nothing here yet', { exact: true }).waitFor(); fixture.state.listEmpty = false;
    });
    await check(`${width} list retry`, async () => {
      fixture.state.failures['/api/loops'] = 100; await view.open();
      await page.getByRole('button', { name: 'Retry', exact: true }).waitFor(); fixture.state.failures['/api/loops'] = 0;
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.locator('.ho-loop-title-link').first().waitFor();
    });
    await check(`${width} loading state`, async () => {
      fixture.state.delay = 500; await view.open('#loop/lp_converged'); await page.getByText('Loading loop', { exact: true }).waitFor();
      await page.getByText('Done in 3 passes: all checks passed.', { exact: true }).waitFor(); fixture.state.delay = 0;
    });
    await check(`${width} exact terminal sentences`, async () => {
      for (const [name, sentence] of Object.entries({ converged: 'Done in 3 passes: all checks passed.', capped: 'Stopped after 4 passes (limit). 2 of 5 checks still fail.', stalled: 'Stopped: no progress between passes 3 and 4.', stopped: 'Stopped by you.', budget: 'Stopped: budget reached.', failed: 'Stopped: an agent could not finish its step.', noverdict: 'Stopped: the checker did not submit a verdict.' })) {
        await view.open(`#loop/lp_${name}`); await page.getByText(sentence, { exact: true }).waitFor();
      }
    });
    await check(`${width} event pagination`, async () => {
      fixture.state.eventPageSize = 3; fixture.state.calls = []; await view.open('#loop/lp_converged');
      await page.getByText('Done in 3 passes: all checks passed.', { exact: true }).waitFor();
      assert.ok(fixture.state.calls.filter(call => call.path.endsWith('/events')).length >= 5); fixture.state.eventPageSize = 200;
      assert.equal(await page.locator('.ho-loop-timeline > li').count(), 3);
    });
    await check(`${width} live SSE and replay deduplication`, async () => {
      await view.open('#loop/lp_running'); await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      const final = recordedRun('converged'); final.detail.loop.id = 'lp_running'; final.detail.loop.revision = 10; fixture.state.runs.lp_running = final;
      fixture.broadcast('lp_running'); fixture.broadcast('lp_running');
      await page.getByText('Done in 3 passes: all checks passed.', { exact: true }).waitFor();
      assert.equal(await page.locator('.ho-loop-timeline > li').count(), 3);
    });
    await check(`${width} reconnect recovers missed update`, async () => {
      fixture.state.runs.lp_running = recordedRun('running'); await view.open('#loop/lp_running');
      await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      fixture.disconnect(); const final = recordedRun('capped'); final.detail.loop.id = 'lp_running'; final.detail.loop.revision = 20; fixture.state.runs.lp_running = final;
      await page.getByText('Stopped after 4 passes (limit). 2 of 5 checks still fail.', { exact: true }).waitFor();
    });
    await check(`${width} pause resume stop and action error`, async () => {
      fixture.state.runs.lp_running = recordedRun('running'); await view.open('#loop/lp_running');
      fixture.state.failures['/api/loops/lp_running/pause'] = 1;
      await page.getByRole('button', { name: 'Pause', exact: true }).click(); await page.getByRole('alert').waitFor();
      await page.getByRole('button', { name: 'Pause', exact: true }).click(); await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await page.getByRole('button', { name: 'Pause', exact: true }).waitFor(); await page.getByRole('button', { name: 'Stop', exact: true }).click();
      await page.getByText('Stopped by you.', { exact: true }).waitFor();
    });
    await check(`${width} gate approve decline and cap extension`, async () => {
      await view.open('#loop/lp_gated'); await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      fixture.state.runs.lp_gated = recordedRun('gated'); await view.open('#loop/lp_gated');
      await page.getByRole('button', { name: 'Decline', exact: true }).click(); await page.getByText('Stopped: approval declined.', { exact: true }).waitFor();
      await view.open('#loop/lp_capped'); await page.getByRole('button', { name: 'Continue 2 more passes', exact: true }).click();
      await page.getByText('4 of 6 passes', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Continue 2 more passes', exact: true }).count(), 0);
    });
    await check(`${width} sheet focus validation and caps`, async () => {
      await view.open(); await page.getByRole('button', { name: 'New loop', exact: true }).click();
      await page.getByRole('button', { name: 'Start loop', exact: true }).click();
      await page.getByRole('alert').waitFor(); assert.equal(await page.getByLabel('Name', { exact: true }).evaluate(element => element === document.activeElement), true);
      await page.getByLabel('Name', { exact: true }).fill('Fixture review'); await page.getByLabel('Goal', { exact: true }).fill('Meet the five checks.');
      await page.getByLabel('Starting brief', { exact: true }).fill('Placeholder brief.');
      await page.getByLabel('Maker agent', { exact: true }).selectOption('bot_maker'); await page.getByLabel('Checker agent', { exact: true }).selectOption('bot_maker');
      await page.getByRole('button', { name: 'Start loop', exact: true }).click(); await page.getByText('Choose a different checker.', { exact: true }).waitFor();
      await page.getByLabel('Checker agent', { exact: true }).selectOption('bot_checker');
      await page.getByLabel('Up to passes', { exact: true }).fill('11'); await page.getByRole('button', { name: 'Start loop', exact: true }).click();
      await page.getByText('Choose a number from 1 to 10.', { exact: true }).waitFor(); await page.getByLabel('Up to passes', { exact: true }).fill('4');
      const options = await page.getByLabel('Checker agent', { exact: true }).locator('option').allTextContents(); assert.ok(!options.includes('Test room') && !options.includes('Setup agent') && !options.includes('Hidden agent'));
      await page.getByRole('button', { name: 'Cancel', exact: true }).focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
      assert.equal(await page.getByRole('dialog').evaluate(element => element.contains(document.activeElement)), true);
      await page.keyboard.press('Escape'); assert.equal(await page.getByRole('button', { name: 'New loop', exact: true }).evaluate(element => element === document.activeElement), true);
    });
    await check(`${width} pipeline checklist advanced and idempotent create`, async () => {
      await page.getByRole('button', { name: 'New loop', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Pipeline fixture'); await page.getByLabel('Goal', { exact: true }).fill('Review placeholder draft.'); await page.getByLabel('Starting brief', { exact: true }).fill('Placeholder brief.');
      await page.getByLabel('Process', { exact: true }).selectOption('pipeline');
      await page.getByLabel('Agent for step 1', { exact: true }).selectOption('bot_maker'); await page.getByLabel('Agent for step 2', { exact: true }).selectOption('bot_checker');
      await page.getByLabel('Stop when', { exact: true }).selectOption('checklist'); await page.getByLabel('Check 1', { exact: true }).fill('Mentions the version.');
      await page.getByText('Advanced', { exact: true }).click(); await page.getByLabel('Approval before', { exact: true }).selectOption('first');
      fixture.state.failures['/api/loops'] = 1; await page.getByRole('button', { name: 'Start loop', exact: true }).click(); await page.getByText('Fixture unavailable. Try again.', { exact: true }).waitFor();
      fixture.state.calls = []; fixture.state.delay = 150;
      await page.getByRole('button', { name: 'Start loop', exact: true }).evaluate(button => { button.click(); button.click(); });
      await page.getByRole('heading', { name: 'Pipeline fixture', exact: true }).waitFor(); fixture.state.delay = 0;
      assert.equal(fixture.state.calls.filter(call => call.path === '/api/loops' && call.method === 'POST').length, 1);
      assert.equal(fixture.state.runs.lp_created.detail.loop.spec.gate.before, 'first');
    });
    await check(`${width} Keep improving export and untracked budgets`, async () => {
      await view.open('#fields'); await page.getByLabel('Checker agent', { exact: true }).selectOption('bot_judge');
      await page.getByRole('button', { name: 'More passes', exact: true }).click();
      await page.getByText('Advanced', { exact: true }).click(); assert.equal(await page.getByLabel('Budget in USD', { exact: true }).isDisabled(), true);
      assert.equal(await page.getByLabel('Token budget', { exact: true }).isDisabled(), true);
      const value = JSON.parse(await page.getByTestId('fields-value').textContent()); assert.equal(value.steps[1].botId, 'bot_judge'); assert.equal(value.limits.maxIterations, 5);
    });
    await check(`${width} graph keyboard and nested lists`, async () => {
      await view.open('#loop/lp_converged'); const timeline = page.getByRole('tab', { name: 'Timeline', exact: true }); await timeline.focus(); await page.keyboard.press('ArrowRight');
      assert.equal(await page.getByRole('tab', { name: 'Graph', exact: true }).getAttribute('aria-selected'), 'true');
      await page.locator('.ho-loop-graph-node').first().waitFor(); assert.equal(await page.locator('.ho-loop-graph-list > li > ol').count(), 3);
      await audit(page);
    });
    await check(`${width} detail errors preserve a retry path`, async () => {
      fixture.state.failures['/api/loops/lp_converged'] = 100; await view.open('#loop/lp_converged');
      await page.getByRole('button', { name: 'Retry', exact: true }).waitFor(); fixture.state.failures['/api/loops/lp_converged'] = 0;
      await page.getByRole('button', { name: 'Retry', exact: true }).click(); await page.getByText('Done in 3 passes: all checks passed.', { exact: true }).waitFor();
      fixture.state.failures['/api/loops/lp_converged/events'] = 100; fixture.broadcast('lp_converged');
      await page.getByRole('alert').waitFor(); assert.equal(await page.locator('.ho-loop-timeline > li').count(), 3);
      fixture.state.failures['/api/loops/lp_converged/events'] = 0; await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await page.getByRole('alert').waitFor({ state: 'detached' });
    });
    await check(`${width} capped gate and absolute extension limit`, async () => {
      const run = recordedRun('capped'); run.detail.loop.status = 'awaiting_approval'; run.detail.loop.stopReason = null;
      run.detail.gate = { kind: 'cap', iteration: 5 }; fixture.state.runs.lp_capped = run;
      await view.open('#loop/lp_capped'); await page.getByRole('button', { name: 'Extend', exact: true }).click();
      await page.getByText('4 of 6 passes', { exact: true }).waitFor();
      run.detail.loop.status = 'awaiting_approval'; run.detail.loop.spec.limits.maxIterations = 10; run.detail.canExtend = true; run.detail.gate = { kind: 'cap', iteration: 11 };
      await view.open('#loop/lp_capped'); await page.getByText('Pass limit reached', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Extend', exact: true }).count(), 0);
    });
    await check(`${width} checklist and pipeline caps`, async () => {
      await view.open(); await page.getByRole('button', { name: 'New loop', exact: true }).click();
      await page.getByLabel('Process', { exact: true }).selectOption('pipeline');
      for (let n = 0; n < 4; n++) await page.getByRole('button', { name: 'Add step', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Add step', exact: true }).isDisabled(), true);
      await page.getByLabel('Stop when', { exact: true }).selectOption('checklist');
      for (let n = 0; n < 7; n++) await page.getByRole('button', { name: 'Add check', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Add check', exact: true }).isDisabled(), true);
      await page.getByLabel('Up to passes', { exact: true }).fill('10'); assert.equal(await page.getByRole('button', { name: 'More passes', exact: true }).isDisabled(), true);
      await page.keyboard.press('Escape');
    });
    await check(`${width} judge, input, task and room fields`, async () => {
      await page.getByRole('button', { name: 'New loop', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('Judge fixture'); await page.getByLabel('Goal', { exact: true }).fill('Meet the rubric.');
      await page.getByLabel('Start with', { exact: true }).selectOption('output'); await page.getByLabel('Starting output', { exact: true }).fill('swarm://output/out_fixture');
      await page.getByLabel('Maker agent', { exact: true }).selectOption('bot_maker'); await page.getByLabel('Checker agent', { exact: true }).selectOption('bot_checker');
      await page.getByText('Advanced', { exact: true }).click(); await page.getByLabel('Use a judge rubric', { exact: true }).check();
      await page.getByLabel('Judge', { exact: true }).selectOption('bot_judge'); await page.getByLabel('Rubric', { exact: true }).fill('Require a version and a call to action.');
      await page.getByLabel('Minutes', { exact: true }).fill('25'); await page.getByLabel('Budget in USD', { exact: true }).fill('2');
      await page.getByLabel('Token budget', { exact: true }).fill('5000'); await page.getByLabel('Post progress in room', { exact: true }).selectOption('bot_room');
      await page.getByLabel('Task', { exact: true }).selectOption('task_fixture');
      await page.getByRole('button', { name: 'Start loop', exact: true }).click(); await page.getByRole('heading', { name: 'Judge fixture', exact: true }).waitFor();
      const spec = fixture.state.runs.lp_created.detail.loop.spec;
      assert.equal(spec.exit.mode, 'judge'); assert.equal(spec.exit.judgeBotId, 'bot_judge'); assert.equal(spec.roomId, 'bot_room'); assert.equal(spec.taskId, 'task_fixture'); assert.equal(spec.limits.maxCostUsd, 2);
    });
    await check(`${width} long untrusted labels remain readable`, async () => {
      const run = recordedRun('converged'); run.detail.loop.spec.name = 'A deliberately long placeholder loop name that wraps safely on a small screen';
      for (const step of run.detail.steps) step.botName = 'Placeholder agent with a long name and <img src=x onerror=alert(1)>';
      fixture.state.runs.lp_converged = run; await view.open('#loop/lp_converged'); await page.getByRole('button', { name: 'Copy details', exact: true }).waitFor();
      await audit(page); assert.equal(await page.locator('#root img').count(), 0);
      await page.getByRole('tab', { name: 'Graph', exact: true }).click(); await audit(page);
      const nodes = await page.locator('.ho-loop-graph-node').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
      for (let n = 1; n < nodes.length; n++) assert.ok(nodes[n].top > nodes[n - 1].bottom);
    });
    await view.close();
  }
  await check('source strings contain no forbidden dashes', async () => {
    for (const file of fs.readdirSync('web/src/handoffs/loops')) assert.ok(!/[\u2013\u2014]/u.test(fs.readFileSync(path.join('web/src/handoffs/loops', file), 'utf8')), file);
  });
  fs.writeFileSync(path.join(fixture.out, 'report.json'), JSON.stringify({ pass: results.length, fail: 0, results }, null, 2));
  console.log(`PASS HO-E behavior: ${results.length} checks, 0 failures`);
} finally { await fixture.close(); }

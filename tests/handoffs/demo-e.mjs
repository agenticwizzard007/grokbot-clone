import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loopFixture, recordedRun, scenarios } from './ui-e-fixture.mjs';
import { audit } from './ui-e-layout.mjs';

const fixture = await loopFixture({ output: '.context/handoffs/demo-e' });
const screenshots = [], replay = [], results = [];
try {
  for (const width of [390, 1280]) {
    const view = await fixture.page(width), { page } = view;
    for (const name of Object.keys(scenarios)) {
      const recording = recordedRun(name), id = 'lp_replay';
      const initial = structuredClone(recording.detail);
      initial.loop = { ...initial.loop, id, iteration: 0, status: 'running', stopReason: null, revision: 1 };
      initial.steps = []; initial.verdicts = []; initial.bestOutput = null; delete initial.gate;
      fixture.state.runs[id] = { detail: initial, events: [] };
      await view.open(`#loop/${id}`); await page.getByRole('button', { name: 'Copy details', exact: true }).waitFor();
      for (const [index, event] of recording.events.entries()) {
        const events = recording.events.slice(0, index + 1);
        const started = events.filter(event => event.type === 'loop.step_dispatched').map(event => `${event.data.iteration}:${event.data.stepId}`);
        const completed = events.filter(event => ['loop.step_completed', 'loop.step_failed'].includes(event.type)).map(event => `${event.data.iteration}:${event.data.stepId}`);
        const checked = events.filter(event => event.type === 'loop.verdict').map(event => event.data.iteration);
        const detail = structuredClone(recording.detail);
        detail.loop = { ...detail.loop, id, status: 'running', stopReason: null, iteration: Number(event.data.iteration ?? 0), revision: index + 2 };
        detail.steps = detail.steps.filter(step => started.includes(`${step.iteration}:${step.stepId}`)).map(step => completed.includes(`${step.iteration}:${step.stepId}`) ? step : { ...step, status: 'running', outputId: null, finishedAt: null });
        detail.verdicts = detail.verdicts.filter(verdict => checked.includes(verdict.iteration));
        detail.bestOutput = null; delete detail.gate;
        if (index === recording.events.length - 1) Object.assign(detail, { ...structuredClone(recording.detail), loop: { ...recording.detail.loop, id, revision: index + 2 } });
        fixture.state.runs[id] = { detail, events }; fixture.broadcast(id);
        await page.locator(`[data-loop-revision="${index + 2}"]`).waitFor();
      }
      await audit(page);
      const screenshot = path.join(fixture.out, `${name}-${width}.png`); await page.screenshot({ path: screenshot, fullPage: true }); screenshots.push(screenshot);
      assert.equal(await page.getByRole('button', { name: 'Back', exact: true }).count(), 1);
      results.push(`${name} ${width}`); console.log(`PASS replay ${name} ${width}: ${recording.events.length} events`);
      replay.push({ name, width, events: recording.events, status: recording.detail.loop.status, stopReason: recording.detail.loop.stopReason });
      if (name === 'converged') {
        await page.getByRole('tab', { name: 'Graph', exact: true }).click(); await audit(page);
        const graph = path.join(fixture.out, `graph-${width}.png`); await page.screenshot({ path: graph, fullPage: true }); screenshots.push(graph);
      }
    }
    await view.open(); await page.getByRole('button', { name: 'New loop', exact: true }).click(); await audit(page, { modal: true });
    const sheet = path.join(fixture.out, `sheet-${width}.png`); await page.screenshot({ path: sheet }); screenshots.push(sheet);
    await view.close();
  }
  fs.writeFileSync(path.join(fixture.out, 'events.json'), JSON.stringify(replay, null, 2));
  fs.writeFileSync(path.join(fixture.out, 'report.json'), JSON.stringify({ pass: results.length, fail: 0, results, screenshots }, null, 2));
  console.log(`PASS HO-E demo: ${results.length} recorded replays, ${screenshots.length} screenshots, 0 failures`);
  console.log(`Output: ${fixture.out}`);
} finally { await fixture.close(); }

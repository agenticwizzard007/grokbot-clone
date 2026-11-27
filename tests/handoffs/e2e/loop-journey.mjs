import assert from 'node:assert/strict';
import { checks } from '../mock-iter.mjs';
import { api, poll, screenshot } from './fixture.mjs';

export const sentences = { converge: 'Done in 3 passes: all checks passed.', cap: 'Stopped after 3 passes (limit). 2 of 3 checks still fail.' };
export async function startLoop(page, data, mode, { room = false } = {}) {
  await page.goto(new URL('/#loops', page.url()).href);
  await page.getByRole('button', { name: 'New loop', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New loop', exact: true });
  await sheet.getByLabel('Name', { exact: true }).fill(`Placeholder ${mode} review`);
  await sheet.getByLabel('Goal', { exact: true }).fill(`HO-H ${mode}: Write three release note bullets with a version, fewer than 60 words and a final call to action.`);
  await sheet.getByLabel('Starting brief', { exact: true }).fill('Placeholder release brief. Test data only.');
  await sheet.getByLabel('Maker agent', { exact: true }).selectOption(data.maker);
  await sheet.getByLabel('Checker agent', { exact: true }).selectOption(data.checker);
  await sheet.getByLabel('Stop when', { exact: true }).selectOption('checklist');
  for (let n = 0; n < 3; n++) {
    if (n) await sheet.getByRole('button', { name: 'Add check', exact: true }).click();
    await sheet.getByLabel(`Check ${n + 1}`, { exact: true }).fill(checks[n]);
  }
  await sheet.getByLabel('Up to passes', { exact: true }).fill('3');
  if (room) { await sheet.getByText('Advanced', { exact: true }).click(); await sheet.getByLabel('Post progress in room').selectOption(data.room); }
  await sheet.getByRole('button', { name: 'Start loop', exact: true }).click();
  await page.waitForURL(/#loop\/lp_/);
  return new URL(page.url()).hash.slice('#loop/'.length);
}

export async function recordLoop(page, data, mode, evidence, width, options) {
  const id = await startLoop(page, data, mode, options);
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  const shots = [await screenshot(page, evidence, `${mode}-running`, width)];
  await page.getByText(sentences[mode], { exact: true }).waitFor({ timeout: 90000 });
  const detail = await api(page, `/loops/${id}`);
  assert.equal(detail.iteration, 3); assert.equal(detail.steps.length, 6);
  assert.equal(detail.resultText, sentences[mode]);
  assert.equal(detail.status, mode === 'converge' ? 'succeeded' : 'capped');
  assert.equal(new Set(detail.steps.map(step => step.jobId)).size, 6);
  assert.ok(detail.steps.every(step => step.outputId && step.status === 'completed'));
  const timeline = await api(page, `/loops/${id}/events`);
  const events = timeline.events;
  // Same controller sequence as demo-b. Real jobs may also emit lifecycle events.
  const core = events.map(event => event.type).filter(type => type.startsWith('loop.'));
  const iteration = ['loop.step_dispatched', 'loop.step_completed', 'loop.step_dispatched', 'loop.verdict', 'loop.step_completed', 'loop.iteration_completed'];
  assert.deepEqual(core.filter(type => type !== 'loop.warning'), ['loop.created', 'loop.started', ...iteration, ...iteration, ...iteration, 'loop.finished']);
  shots.push(await screenshot(page, evidence, `${mode}-finished`, width));
  await page.getByRole('tab', { name: 'Graph', exact: true }).click();
  await page.locator('.ho-loop-graph-node').first().waitFor();
  assert.equal(await page.locator('.ho-loop-graph-node').count(), 6);
  shots.push(await screenshot(page, evidence, `${mode}-graph`, width));
  await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
  return { id, mode, width, status: detail.status, passes: detail.iteration, result: detail.resultText, steps: detail.steps, verdicts: detail.verdicts, events, screenshots: shots };
}

export async function finishedChat(page, data, width) {
  await page.goto(new URL(`/#bot/${data.maker}`, page.url()).href);
  await api(page, `/bots/${data.maker}/messages`, 'POST', { text: `mock: say Placeholder release draft ${width} ready for review.` });
  await page.locator('.ho-output-card').first().waitFor();
  await poll(() => api(page, `/outputs?botId=${data.maker}`), r => (r.outputs ?? r.items ?? r).length > 0, 'Finished run output');
}

export async function sendHandoff(page, data, evidence, width) {
  await finishedChat(page, data, width);
  await page.locator('.ho-output-card').getByRole('button', { name: 'Send to agent', exact: true }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Send to agent' });
  await sheet.getByRole('button', { name: /^Checker/ }).click();
  await sheet.getByLabel('Ask', { exact: true }).fill(`mock: say Placeholder review ${width} complete.`);
  const shots = [await screenshot(page, evidence, 'handoff-sheet', width)];
  const response = page.waitForResponse(r => r.url().endsWith('/api/handoffs') && r.request().method() === 'POST');
  await sheet.getByRole('button', { name: 'Send', exact: true }).click();
  const created = await (await response).json(), handoff = created.handoff ?? created;
  const receipt = page.locator('.ho-receipt').filter({ hasText: `Placeholder review ${width} complete.` }).first();
  await receipt.getByText('Sent to Checker', { exact: true }).waitFor();
  shots.push(await screenshot(page, evidence, 'handoff-receipt', width));
  await receipt.getByRole('link', { name: /^View handoff/ }).click();
  await page.locator('.ho-output-card').waitFor({ timeout: 60000 });
  const detail = await poll(() => api(page, `/handoffs/${handoff.id}`), value => (value.handoff ?? value).status === 'completed', 'Handoff completion');
  shots.push(await screenshot(page, evidence, 'handoff-detail', width));
  return { id: handoff.id, detail, screenshots: shots };
}

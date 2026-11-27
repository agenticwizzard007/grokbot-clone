import assert from 'node:assert/strict';
import { checks, goals } from '../mock-iter.mjs';
import { api, poll, screenshot } from './fixture.mjs';

export const sentences = { converge: 'Done in 3 passes: all checks passed.', cap: 'Stopped after 3 passes (limit). 2 of 3 checks still fail.' };
export async function startLoop(page, data, mode, { room = false } = {}) {
  await page.goto(new URL('/#loops', page.url()).href);
  await page.getByRole('button', { name: 'New loop', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'New loop', exact: true });
  await sheet.getByLabel('Name', { exact: true }).fill(mode === 'cap' ? 'Release review' : 'Release notes');
  await sheet.getByLabel('Goal', { exact: true }).fill(goals[mode]);
  await sheet.getByLabel('Starting brief', { exact: true }).fill('Version 1.0 improves search and saved reports.');
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
  return recordExistingLoop(page, id, mode, evidence, width);
}
export async function recordExistingLoop(page, id, mode, evidence, width) {
  await page.getByRole('button', { name: 'Pause', exact: true }).waitFor();
  const shots = [await screenshot(page, evidence, `${mode}-running`, width)];
  try {
  const detail = await poll(() => api(page, `/loops/${id}`), value => ['succeeded', 'capped', 'failed', 'cancelled', 'stalled'].includes(value.status), 'Loop terminal state', 90000);
  await page.locator('.ho-loop-result').waitFor();
  shots.push(await screenshot(page, evidence, `${mode}-finished`, width));
  await page.getByRole('tab', { name: 'Graph', exact: true }).click();
  await page.locator('.ho-loop-graph-node').first().waitFor();
  shots.push(await screenshot(page, evidence, `${mode}-graph`, width));
  const graphNodes = await page.locator('.ho-loop-graph-node').count();
  await page.getByRole('tab', { name: 'Timeline', exact: true }).click();
  assert.equal(detail.resultText, sentences[mode], `Real loop ${id}: ${detail.stopReason}`);
  await page.getByText(sentences[mode], { exact: true }).waitFor();
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
  assert.equal(graphNodes, 6);
  return { id, mode, width, status: detail.status, passes: detail.iteration, result: detail.resultText, steps: detail.steps, verdicts: detail.verdicts, events, screenshots: shots };
  } catch (error) { error.screenshots = shots; throw error; }
}

export async function finishedChat(page, data, width) {
  await page.goto(new URL(`/#bot/${data.maker}`, page.url()).href);
  await page.locator('.composer textarea').fill('Draft release notes for version 1.0.');
  const accepted = page.waitForResponse(response => response.url().endsWith(`/api/bots/${data.maker}/messages`) && response.request().method() === 'POST');
  await page.locator('.composer').getByRole('button', { name: 'Send', exact: true }).click();
  const response = await accepted; assert.ok(response.ok());
  const { jobIds } = await response.json(); assert.equal(jobIds.length, 1);
  const output = await poll(async () => {
    const result = await page.request.get(new URL(`/api/outputs/by-job/${jobIds[0]}`, page.url()).href);
    return result.ok() ? result.json() : null;
  }, value => value?.status === 'final', 'This reply has a finished run output');
  const card = page.locator('.ho-output-card').filter({ has: page.locator(`a[href="#output/${output.id}"]`) });
  await card.waitFor(); await card.scrollIntoViewIfNeeded();
  return card;
}

export async function sendHandoff(page, data, evidence, width) {
  const card = await finishedChat(page, data, width);
  await card.getByRole('button', { name: 'Send to agent', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Send to agent' });
  await sheet.getByRole('button', { name: /^Checker/ }).click();
  await sheet.getByLabel('Ask', { exact: true }).fill('Review the release draft for clarity.');
  const shots = [await screenshot(page, evidence, 'handoff-sheet', width)];
  const response = page.waitForResponse(r => r.url().endsWith('/api/handoffs') && r.request().method() === 'POST');
  await sheet.getByRole('button', { name: 'Send', exact: true }).click();
  const created = await (await response).json(), handoff = created.handoff ?? created;
  const receipt = page.locator('.ho-receipt').filter({ has: page.locator(`a[href="#handoff/${handoff.id}"]`) });
  await receipt.getByText('Sent to Checker', { exact: true }).waitFor();
  await receipt.scrollIntoViewIfNeeded();
  shots.push(await screenshot(page, evidence, 'handoff-receipt', width));
  await receipt.getByRole('link', { name: /^View handoff/ }).click();
  await page.locator('.ho-output-card').waitFor({ timeout: 60000 });
  const detail = await poll(() => api(page, `/handoffs/${handoff.id}`), value => (value.handoff ?? value).status === 'completed', 'Handoff completion');
  shots.push(await screenshot(page, evidence, 'handoff-detail', width));
  return { id: handoff.id, detail, screenshots: shots };
}

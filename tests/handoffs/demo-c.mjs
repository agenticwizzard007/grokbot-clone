import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const { MemoryHandoffService } = await tsImport('../../server/src/handoffs/memory-service.ts', import.meta.url);
const { createHandoffTools } = await tsImport('../../server/src/agent/handoff-tools.ts', import.meta.url);
const { createFlowTools } = await tsImport('../../server/src/agent/flow-tools.ts', import.meta.url);

export const fixtureTime = 1_795_784_400_000;
export const loopInput = {
  name: 'Placeholder release review', kind: 'maker_checker', goal: 'A release note with a version and next action.',
  steps: [
    { id: 'make', botId: 'bot_maker', role: 'maker', instruction: 'Draft a placeholder release note.' },
    { id: 'check', botId: 'bot_checker', role: 'checker', instruction: 'Check the note against every required item.' },
  ],
  exit: { mode: 'checklist', items: [{ id: 'version', text: 'Mentions the version', required: true }] },
  limits: { maxIterations: 4, maxMinutes: 30, stepTimeoutMinutes: 10 },
};

export function context(botId = 'bot_maker', toolCallId = 'call_fixture', extra = {}) {
  return { userId: 'user_fixture', botId, jobId: `job_${botId}`, toolCallId, depth: 0, enqueueBotMessage() {}, ...extra };
}

/** Shared placeholder fixture for the headless demo and stateful tool tests. */
export function createFixture(extra = {}) {
  const bots = [
    { id: 'bot_maker', userId: 'user_fixture', name: 'Draft agent' },
    { id: 'bot_checker', userId: 'user_fixture', name: 'Review agent' },
    { id: 'bot_judge', userId: 'user_fixture', name: 'Judge agent' },
    { id: 'bot_bystander', userId: 'user_fixture', name: 'Other agent' },
    { id: 'bot_foreign', userId: 'user_other', name: 'Other user agent' },
    { id: 'bot_room', userId: 'user_fixture', kind: 'room' },
    { id: 'bot_hidden', userId: 'user_fixture', hidden: true },
    { id: 'bot_setup', userId: 'user_fixture', isConfiguring: true },
    { id: 'bot_inactive', userId: 'user_fixture', active: false },
    { id: 'bot_helper', userId: 'user_fixture', hidden: true, helperOfBotId: 'bot_maker' },
  ];
  const service = new MemoryHandoffService({
    bots, now: () => fixtureTime,
    jobText: { job_bot_maker: 'Placeholder release note. Version 1 is ready. Read the example brief.', job_bot_foreign: 'Other user placeholder output.' },
    savedFiles: [{ userId: 'user_fixture', botId: 'bot_maker', jobId: 'job_bot_maker', path: 'release.txt',
      part: { id: 'p_release', kind: 'file', artifactId: 'artifact_release', filename: 'release.txt', mime: 'text/plain', size: 48, sha256: 'a'.repeat(64) } }],
    ...extra,
  });
  // HO-G owns the persistent FlowStore. This fake checks the same context boundary.
  const summaries = new Map();
  const flowStore = {
    async writeFlowSummary(ctx, input) {
      if (!bots.some(bot => bot.id === ctx.botId && bot.userId === ctx.userId)) throw Object.assign(new Error('Not found'), { code: 'not_found' });
      const inputsHash = createHash('sha256').update(`placeholder instructions:${ctx.botId}`).digest('hex');
      summaries.set(`${ctx.userId}:${ctx.botId}`, { ...structuredClone(input), inputsHash });
      return { inputsHash };
    },
  };
  const tools = [...createHandoffTools(service), ...createFlowTools(flowStore, service)];
  const call = async (name, args, ctx = context()) => {
    const tool = tools.find(tool => tool.name === name);
    assert.ok(tool, `Tool exists: ${name}`);
    const result = await tool.impl(args, ctx);
    assert.equal(typeof result.output, 'string', `${name} returns text`);
    return result;
  };
  return { service, flowStore, summaries, tools, call };
}

export function runningReview(loop, iteration = 1) {
  return {
    loops: [{ ...loop, status: 'running', iteration }],
    assignments: [
      { jobId: 'job_bot_maker', loopId: loop.id, iteration, stepId: 'make', botId: 'bot_maker' },
      { jobId: 'job_bot_checker', loopId: loop.id, iteration, stepId: 'check', botId: 'bot_checker' },
    ],
  };
}

export async function runDemo() {
  const fixture = createFixture();
  const transcript = [];
  async function record(name, args, ctx, expectedError = false, current = fixture) {
    const result = await current.call(name, args, ctx);
    assert.equal(result.isError === true, expectedError, `${name}: ${result.output}`);
    const entry = { tool: name, botId: ctx.botId, expectedError, result };
    transcript.push(entry);
    console.log(JSON.stringify(entry, null, 2));
    return expectedError ? result.output : JSON.parse(result.output);
  }
  const output = await record('submit_output', {
    title: 'Placeholder release', summary: 'Version 1 release note is ready.', files: ['release.txt'],
    dataParts: [{ name: 'release', json: { version: 1, ready: true } }],
    links: [{ url: 'https://example.com/brief', title: 'Example brief', relation: 'source' }],
  }, context('bot_maker', 'call_output'));
  const handoff = await record('handoff_to_agent', {
    toBotId: 'bot_checker', instruction: 'Review this placeholder release note.', outputRef: output.outputRef, includeFiles: ['artifact_release'],
  }, context('bot_maker', 'call_send'));
  const received = await record('read_handoff', { handoffId: handoff.handoffId }, context('bot_checker', 'call_read'));
  const part = received.output.parts.find(part => part.kind === 'text');
  assert.ok(part);
  await record('read_handoff', { ref: `${output.outputRef}#${part.id}`, offset: 0, limit: 40 }, context('bot_checker', 'call_page'));
  const listed = await record('list_handoffs', { direction: 'received' }, context('bot_checker', 'call_list'));
  assert.equal(listed.length, 1);
  const started = await record('start_loop', loopInput, context('bot_maker', 'call_loop'));
  assert.equal(started.status, 'awaiting_approval');
  const loop = await fixture.service.startLoop(context('bot_maker', 'call_loop'), loopInput);
  // Seed a review already admitted by a user. No agent tool approves the gate.
  const review = createFixture(runningReview(loop));
  const verdict = await record('submit_verdict', { pass: true, checklist: [{ id: 'version', pass: false, note: 'Version missing.' }], feedback: 'Add a version.' },
    context('bot_checker', 'call_verdict'), false, review);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.claimedPass, true);
  const flow = await record('write_flow_summary', { steps: [{ label: 'Draft release notes' }, { label: 'Request a review' }], loopNote: 'Wait for the next brief.' },
    context('bot_maker', 'call_flow'));
  assert.equal(flow.saved, true);
  await record('read_handoff', { ref: output.outputRef }, context('bot_bystander', 'call_denied_read'), true);
  await record('handoff_to_agent', { toBotId: 'bot_checker', instruction: 'Start another chain.' }, context('bot_maker', 'call_nested'), true, review);
  await record('submit_verdict', { pass: true, checklist: [], feedback: '' }, context('bot_bystander', 'call_no_review'), true);
  const outputDir = path.resolve('.context/handoffs/demo-c');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'results.json'), JSON.stringify(transcript, null, 2) + '\n');
  fs.writeFileSync(path.join(outputDir, 'transcript.txt'), transcript.map(entry => JSON.stringify(entry, null, 2)).join('\n\n') + '\n');
  console.log(`HO-C demo: ${transcript.length}/${transcript.length} scenarios passed; 7/7 tools exercised. Output: ${outputDir}`);
  return transcript;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await runDemo();

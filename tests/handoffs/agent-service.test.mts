import assert from 'node:assert/strict';
import test from 'node:test';
import { context, createFixture, fixtureTime, loopInput, runningReview } from './demo-c.mjs';

const parse = (result: { output: string; isError?: boolean }) => {
  assert.notEqual(result.isError, true, result.output);
  return JSON.parse(result.output);
};
const declaration = { title: 'Placeholder release', summary: 'Version 1 is ready.' };
const send = { toBotId: 'bot_checker', instruction: 'Review the placeholder note.' };
const verdict = { pass: true, checklist: [{ id: 'version', pass: false, note: 'Version missing.' }], feedback: 'Add a version.' };

test('MemoryHandoffService declares, replays and revises only the current run output', async () => {
  const { call, service } = createFixture();
  const ctx = context('bot_maker', 'call_declare');
  const input = { ...declaration, files: ['release.txt'], dataParts: [{ name: 'release', json: { version: 1 } }],
    links: [{ url: 'https://example.com/brief', title: 'Example brief', relation: 'source' }] };
  const first = parse(await call('submit_output', input, ctx));
  assert.equal(first.status, 'draft');
  assert.equal(first.revision, 1);
  assert.deepEqual(parse(await call('submit_output', input, ctx)), first);
  const conflict = await call('submit_output', { ...input, summary: 'Changed.' }, ctx);
  assert.equal(conflict.isError, true);
  assert.match(conflict.output, /different content/);
  const revised = parse(await call('submit_output', { ...input, summary: 'Version 2 is ready.' }, context('bot_maker', 'call_revise')));
  assert.equal(revised.outputRef, first.outputRef);
  assert.equal(revised.revision, 2);
  const page = await service.readHandoff(ctx, { ref: first.outputRef });
  assert.equal(page.output.userId, ctx.userId);
  assert.equal(page.output.botId, ctx.botId);
  assert.equal(page.output.jobId, ctx.jobId);
  assert.ok(['text', 'file', 'data', 'link'].every(kind => page.output.parts.some(part => part.kind === kind)));
  assert.equal((await call('submit_output', { ...declaration, files: ['not-saved.txt'] }, context('bot_maker', 'call_missing_file'))).isError, true);
  assert.equal((await call('submit_output', { ...declaration, files: ['release.txt'] }, context('bot_checker', 'call_other_file'))).isError, true);
});

test('finalized outputs cannot be revised through submit_output', async () => {
  const fixture = createFixture();
  const output = await fixture.service.submitOutput(context(), declaration);
  const finalFixture = createFixture({ outputs: [{ ...output, status: 'final', finalizedAt: fixtureTime }] });
  const result = await finalFixture.call('submit_output', { ...declaration, summary: 'Changed.' });
  assert.equal(result.isError, true);
  assert.match(result.output, /already final/);
});

test('handoff is idempotent, returns immediately and grants only the addressed receiver access', async () => {
  const { call } = createFixture();
  const output = parse(await call('submit_output', declaration, context('bot_maker', 'call_output')));
  const ctx = context('bot_maker', 'call_handoff');
  const args = { ...send, outputRef: output.outputRef };
  const first = parse(await call('handoff_to_agent', args, ctx));
  assert.equal(first.status, 'queued');
  assert.deepEqual(parse(await call('handoff_to_agent', args, ctx)), first);
  assert.equal((await call('handoff_to_agent', { ...args, instruction: 'Different request.' }, ctx)).isError, true);
  const listed = parse(await call('list_handoffs', { direction: 'sent' }, context()));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].fromBotId, 'bot_maker');
  assert.equal(listed[0].initiatedBy, 'agent');
  const receiver = context('bot_checker');
  const received = parse(await call('read_handoff', { handoffId: first.handoffId }, receiver));
  assert.equal(received.output.id, listed[0].sourceOutputId);
  assert.deepEqual(parse(await call('list_handoffs', { direction: 'received', status: 'queued' }, receiver)), listed);
  assert.deepEqual(parse(await call('list_handoffs', {}, context('bot_bystander'))), []);
});

test('read_handoff pages text and data, returns link metadata and never fetches a URL', async () => {
  const body = 'Placeholder text. '.repeat(700);
  const { call } = createFixture({ jobText: { job_bot_maker: body } });
  const output = parse(await call('submit_output', { ...declaration, dataParts: [{ name: 'release', json: { version: 1 } }],
    links: [{ url: 'https://example.com/brief', title: 'Example brief', relation: 'source' }] }));
  const manifest = parse(await call('read_handoff', { ref: output.outputRef }));
  const part = manifest.output.parts.find(part => part.kind === 'text');
  const first = parse(await call('read_handoff', { ref: `${output.outputRef}#${part.id}`, limit: 8000 }));
  const last = parse(await call('read_handoff', { ref: `${output.outputRef}#${part.id}`, offset: first.next, limit: 8000 }));
  assert.equal(first.text.length, 8000);
  assert.equal(first.text + last.text, body);
  assert.equal(last.next, null);
  const dataPart = manifest.output.parts.find(part => part.kind === 'data');
  assert.deepEqual(JSON.parse(parse(await call('read_handoff', { ref: output.outputRef, partId: dataPart.id })).text), { version: 1 });
  const link = manifest.output.parts.find(part => part.kind === 'link');
  assert.match(parse(await call('read_handoff', { ref: output.outputRef, partId: link.id })).text, /https:\/\/example.com\/brief/);
});

test('unaddressed, cross-user and missing outputs have indistinguishable refusals', async () => {
  const { call } = createFixture();
  const own = parse(await call('submit_output', declaration));
  const other = parse(await call('submit_output', declaration, context('bot_foreign', 'call_foreign', { userId: 'user_other' })));
  const denied = await call('read_handoff', { ref: own.outputRef }, context('bot_bystander'));
  for (const [ref, ctx] of [[other.outputRef, context()], ['swarm://output/out_missing', context()],
    [own.outputRef, context('bot_foreign', 'call_read', { userId: 'user_other' })]]) {
    assert.deepEqual(await call('read_handoff', { ref }, ctx), denied);
  }
  assert.equal(denied.isError, true);
  assert.match(denied.output, /reference addressed to you/);
  const handoff = parse(await call('handoff_to_agent', { ...send, outputRef: own.outputRef }, context('bot_maker', 'call_send')));
  assert.deepEqual(await call('read_handoff', { handoffId: handoff.handoffId }, context('bot_bystander')), denied);
  assert.deepEqual(await call('read_handoff', { ref: `swarm://handoff/${handoff.handoffId}` }, context('bot_foreign', 'call_read', { userId: 'user_other' })), denied);
  assert.equal((await call('handoff_to_agent', { ...send, outputRef: other.outputRef }, context('bot_maker', 'call_forward'))).isError, true);
});

test('target policy rejects foreign, room, setup, hidden, inactive, missing and self targets', async () => {
  const { call } = createFixture();
  for (const toBotId of ['bot_foreign', 'bot_room', 'bot_hidden', 'bot_setup', 'bot_inactive', 'bot_missing', 'bot_maker']) {
    const result = await call('handoff_to_agent', { ...send, toBotId }, context('bot_maker', `call_${toBotId}`));
    assert.equal(result.isError, true, toBotId);
    assert.match(result.output, /allowed active teammate/);
  }
  assert.deepEqual(parse(await call('list_handoffs', {})), []);
  assert.equal(parse(await call('handoff_to_agent', { ...send, toBotId: 'bot_helper' }, context('bot_maker', 'call_helper'))).status, 'queued');
  for (const agentHandoffs of ['off', 'links_only']) {
    const fixture = createFixture({ settings: { user_fixture: { enabled: true, agentHandoffs } } });
    assert.match((await fixture.call('handoff_to_agent', send)).output, /current policy/);
  }
});

test('agent rate limit refuses the next handoff and does not create a hidden extra row', async () => {
  const { call } = createFixture();
  for (let i = 0; i < 20; i++) assert.equal(parse(await call('handoff_to_agent', send, context('bot_maker', `call_${i}`))).status, 'queued');
  const result = await call('handoff_to_agent', send, context('bot_maker', 'call_21'));
  assert.equal(result.isError, true);
  assert.match(result.output, /rate limit/);
  assert.equal(parse(await call('list_handoffs', { limit: 20 })).length, 20);
});

test('cycle and chain-depth refusals retain actionable text from the service boundary', async () => {
  const { service } = createFixture();
  const template = await service.submitOutput(context(), declaration);
  for (const cycle of [true, false]) {
    const outputs = Array.from({ length: cycle ? 2 : 6 }, (_, index) => ({ ...structuredClone(template), id: `out_chain_${index}`,
      botId: index === 0 && cycle ? 'bot_checker' : index === (cycle ? 1 : 5) ? 'bot_maker' : `bot_history_${index}`,
      provenance: { ...structuredClone(template.provenance), consumed: index ? [`out_chain_${index - 1}`] : [] } }));
    const fixture = createFixture({ outputs });
    const result = await fixture.call('handoff_to_agent', { ...send, outputRef: `swarm://output/${outputs.at(-1)!.id}` });
    assert.equal(result.isError, true);
    assert.match(result.output, cycle ? /earlier agent/ : /chain has reached its limit/);
    assert.match(result.output, /loop/);
  }
});

test('fire-and-forget handoff ends the turn only after a successful send', async () => {
  const { call } = createFixture();
  const sent = await call('handoff_to_agent', { ...send, returnResult: false });
  assert.equal(sent.isError, undefined);
  assert.equal(sent.endTurn, true);
  const rejected = await call('handoff_to_agent', { ...send, toBotId: 'bot_foreign', returnResult: false }, context('bot_maker', 'call_rejected'));
  assert.equal(rejected.isError, true);
  assert.equal(rejected.endTurn, undefined);
});

test('start_loop enforces the first gate, stable replay and user-facing approval instruction', async () => {
  const { call, service } = createFixture();
  const ctx = context('bot_maker', 'call_start');
  const first = parse(await call('start_loop', loopInput, ctx));
  assert.equal(first.status, 'awaiting_approval');
  assert.match(first.message, /Tell the user/);
  assert.deepEqual(parse(await call('start_loop', loopInput, ctx)), first);
  const loop = await service.startLoop(ctx, loopInput);
  assert.equal(loop.initiatedBy, 'agent');
  assert.equal(loop.spec.gate.before, 'first');
  assert.equal((await call('start_loop', { ...loopInput, gate: { before: 'none' } }, context('bot_maker', 'call_bypass'))).isError, true);
  assert.equal((await call('start_loop', { ...loopInput, goal: 'Changed.' }, ctx)).isError, true);
});

test('a pre-approved exact pair reports running without falsely requesting a new gate', async () => {
  const { call } = createFixture({ links: [{ id: 'link_fixture', userId: 'user_fixture', fromBotId: 'bot_maker', toBotId: 'bot_checker',
    mode: 'suggest', trigger: 'any_run', template: '', autoApproveLoops: true, createdAt: fixtureTime, updatedAt: fixtureTime }] });
  const started = parse(await call('start_loop', loopInput));
  assert.equal(started.status, 'running');
  assert.doesNotMatch(started.message, /waiting for user approval/);
});

test('only a checker can submit a verdict, required checks win and the result is immutable', async () => {
  const parent = createFixture();
  const loop = await parent.service.startLoop(context(), loopInput);
  const { call } = createFixture(runningReview(loop));
  for (const botId of ['bot_maker', 'bot_bystander']) {
    assert.deepEqual(await call('submit_verdict', verdict, context(botId)), { isError: true, output: 'No review is waiting for you.' });
  }
  const checker = context('bot_checker', 'call_verdict');
  const checked = parse(await call('submit_verdict', verdict, checker));
  assert.equal(checked.pass, false);
  assert.equal(checked.claimedPass, true);
  assert.equal(checked.corrected, true);
  const changed = await call('submit_verdict', { ...verdict, checklist: [{ id: 'version', pass: true, note: 'Changed.' }] }, context('bot_checker', 'call_changed'));
  assert.equal(changed.isError, true);
  assert.match(changed.output, /already been submitted/);
  assert.deepEqual(parse(await call('submit_verdict', verdict, checker)), checked);
});

test('assigned loop steps cannot start handoffs or loops', async () => {
  const parent = createFixture();
  const loop = await parent.service.startLoop(context(), loopInput);
  const { call } = createFixture(runningReview(loop));
  for (const botId of ['bot_maker', 'bot_checker']) for (const [name, input] of [['handoff_to_agent', send], ['start_loop', loopInput]]) {
    assert.deepEqual(await call(name, input, context(botId)), {
      isError: true, output: 'This run is part of a loop. Return your result; the loop passes it on.',
    });
  }
  assert.deepEqual(parse(await call('list_handoffs', {})), []);
});

test('judge mode accepts only the assigned judge and refuses the regular checker', async () => {
  const parent = createFixture();
  const loop = await parent.service.startLoop(context(), { ...loopInput, exit: { mode: 'judge', judgeBotId: 'bot_judge', rubric: 'Review clarity.' } });
  const review = runningReview(loop);
  review.assignments.push({ jobId: 'job_bot_judge', loopId: loop.id, iteration: 1, stepId: 'check', botId: 'bot_judge' });
  const { call } = createFixture(review);
  const input = { pass: true, checklist: [], feedback: 'The placeholder note is clear.' };
  assert.deepEqual(await call('submit_verdict', input, context('bot_checker')), { isError: true, output: 'No review is waiting for you.' });
  assert.equal(parse(await call('submit_verdict', input, context('bot_judge'))).pass, true);
});

test('flow summary is scoped to the current bot and returns the store hash', async () => {
  const { call, summaries } = createFixture();
  const input = { steps: [{ label: 'Draft release notes', detail: 'Read the placeholder brief.' }], loopNote: 'Wait for a new brief.' };
  const first = parse(await call('write_flow_summary', input));
  assert.equal(first.saved, true);
  assert.match(first.inputsHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(summaries.get('user_fixture:bot_maker'), { ...input, inputsHash: first.inputsHash });
  assert.equal((await call('write_flow_summary', { ...input, botId: 'bot_checker' })).isError, true);
  assert.equal(summaries.has('user_fixture:bot_checker'), false);
  assert.equal((await call('write_flow_summary', input, context('bot_foreign'))).isError, true);
});

test('disabled MemoryHandoffService policy denies all seven operations', async () => {
  const { call } = createFixture({ settings: { user_fixture: { enabled: false, agentHandoffs: 'team' } } });
  for (const [name, input] of [['submit_output', declaration], ['handoff_to_agent', send], ['read_handoff', { ref: 'swarm://output/out_fixture' }],
    ['list_handoffs', {}], ['submit_verdict', verdict], ['start_loop', loopInput], ['write_flow_summary', { steps: [{ label: 'Draft' }] }]]) {
    assert.deepEqual(await call(name, input), { output: 'Handoffs are disabled. Continue with the current task.', isError: true });
  }
});

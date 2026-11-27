import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fixture, output, handoffs, loops, makeLoop, runLoop, app, finish, flush, cleanup } from './server-fixture.test.mts';
after(cleanup);
type Fixture = ReturnType<typeof fixture>;

async function read(f: Fixture, path: string) {
  const response = await app.request(`/api${path}`, { headers: f.headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  return response.json() as Promise<any>;
}
function fields(value: any, expected: Record<string, string>) {
  for (const [key, types] of Object.entries(expected)) {
    assert.ok(Object.hasOwn(value, key), `Required widget field: ${key}`);
    const actual = value[key] === null ? 'null' : Array.isArray(value[key]) ? 'array' : typeof value[key];
    assert.ok(types.split('|').includes(actual), `${key}: expected ${types}, got ${actual}`);
  }
}
const handoffFields = {
  id: 'string', fromBotId: 'string', toBotId: 'string', sourceOutputId: 'string', resultOutputId: 'string|null',
  status: 'string', reason: 'string', instruction: 'string', priority: 'string', initiatedBy: 'string',
  loopId: 'string|null', iteration: 'number|null', revision: 'number', createdAt: 'number', updatedAt: 'number',
};
const loopFields = {
  id: 'string', ownerBotId: 'string', spec: 'object', status: 'string', stopReason: 'string|null',
  iteration: 'number', bestOutputId: 'string|null', revision: 'number', startedAt: 'number|null',
  finishedAt: 'number|null', createdAt: 'number', updatedAt: 'number',
};
// Widget counts are derived from returned arrays. Neither list endpoint promises
// a total, and loop detail has no separate summary envelope.
function summary(detail: any) {
  fields(detail, { ...loopFields, steps: 'array', verdicts: 'array', iterations: 'array', resultText: 'string', bestOutput: 'object|null', usage: 'object', gate: 'object' });
  fields(detail.usage, { tracked: 'boolean', tokens: 'number|null', costUsd: 'number|null' });
  const latest = detail.verdicts.at(-1);
  return {
    id: detail.id, status: detail.status, stopReason: detail.stopReason, passes: detail.iteration,
    maxPasses: detail.spec.limits.maxIterations, steps: detail.steps.length,
    completedSteps: detail.steps.filter((step: any) => step.status === 'completed').length,
    reviews: detail.verdicts.length, checks: latest ? latest.checklist.length : null,
    failedChecks: latest ? latest.checklist.filter((check: any) => !check.pass).length : null,
    lastResultSentence: detail.resultText,
  };
}

test('widget reads use authenticated, private list envelopes with explicit empty cursors', async () => {
  const f = fixture();
  assert.deepEqual(await read(f, '/handoffs'), { handoffs: [], next: null });
  assert.deepEqual(await read(f, '/loops'), { loops: [], next: null });
  for (const path of ['/handoffs', '/loops']) {
    assert.equal((await app.request(`/api${path}`)).status, 401);
    for (const limit of ['0', '51']) assert.equal((await app.request(`/api${path}?limit=${limit}`, { headers: f.headers })).status, 400);
  }
});

test('handoff widgets retain references, status, filters and cursor pagination', async () => {
  const f = fixture(), source = output(f, 'Version 1.0 is ready for review.');
  const first = handoffs.createHandoff(f.userId, { source: { outputId: source.id }, toBotId: f.checker.id, instruction: 'Review the release notes.', returnResult: false, idempotencyKey: 'widget-reviewed' }).handoff;
  await flush(f); finish(f, handoffs.getHandoff(f.userId, first.id).jobId!, 'The release notes are ready.'); await flush(f);
  const second = handoffs.createHandoff(f.userId, { source: { outputId: source.id }, toBotId: f.checker.id, instruction: 'Check the source links.', returnResult: false, idempotencyKey: 'widget-cancelled' }).handoff;
  handoffs.controlHandoff(f.userId, second.id, 'cancel');
  const page1 = await read(f, '/handoffs?limit=1');
  fields(page1, { handoffs: 'array', next: 'string' }); assert.equal(page1.handoffs.length, 1);
  const page2 = await read(f, `/handoffs?limit=1&after=${encodeURIComponent(page1.next)}`);
  assert.equal(page2.next, null); assert.equal(page2.handoffs.length, 1);
  const rows = [...page1.handoffs, ...page2.handoffs];
  assert.deepEqual(new Set(rows.map(row => row.id)), new Set([first.id, second.id]));
  for (const row of rows) {
    fields(row, handoffFields);
    assert.equal(row.fromBotId, f.maker.id); assert.equal(row.toBotId, f.checker.id);
    assert.equal(row.sourceOutputId, source.id); assert.equal(row.loopId, null); assert.equal(row.iteration, null);
    assert.ok(!Object.hasOwn(row, 'sourceOutput'), 'List entries carry references, not expanded output bodies');
  }
  const completed = await read(f, `/handoffs?botId=${f.maker.id}&direction=sent&status=completed`);
  assert.equal(completed.handoffs.length, 1); assert.equal(completed.handoffs[0].id, first.id);
  assert.equal(typeof completed.handoffs[0].resultOutputId, 'string');
  assert.deepEqual((await read(f, `/handoffs?botId=${f.checker.id}&direction=received`)).handoffs.map((row: any) => row.id), rows.map(row => row.id));
  assert.deepEqual((await read(f, `/handoffs?botId=${f.checker.id}&direction=sent`)).handoffs, []);
});

test('loop lists retain flat records, status filtering and opaque cursor pagination', async () => {
  const f = fixture(), draft = makeLoop(f, {}, false), stopped = makeLoop(f, {}, false);
  loops.controlLoop(f.userId, stopped.id, 'stop');
  const first = await read(f, '/loops?limit=1'); fields(first, { loops: 'array', next: 'string' });
  const second = await read(f, `/loops?limit=1&after=${encodeURIComponent(first.next)}`);
  assert.equal(first.loops.length, 1); assert.equal(second.loops.length, 1); assert.equal(second.next, null);
  const rows = [...first.loops, ...second.loops];
  assert.deepEqual(new Set(rows.map(row => row.id)), new Set([draft.id, stopped.id]));
  for (const row of rows) {
    fields(row, loopFields); assert.equal(row.ownerBotId, f.maker.id);
    assert.equal(typeof row.spec.name, 'string'); assert.equal(row.spec.limits.maxIterations, 3);
    assert.ok(!Object.hasOwn(row, 'resultText'), 'Fetch detail for the result sentence');
  }
  assert.deepEqual((await read(f, '/loops?status=draft')).loops.map((row: any) => row.id), [draft.id]);
  assert.deepEqual((await read(f, '/loops?status=cancelled')).loops.map((row: any) => row.id), [stopped.id]);
});

test('draft and approval summaries distinguish zero steps, missing checks and untracked usage', async () => {
  const f = fixture(), draft = makeLoop(f, {}, false);
  const detail = await read(f, `/loops/${draft.id}`);
  assert.deepEqual(summary(detail), { id: draft.id, status: 'draft', stopReason: null, passes: 0, maxPasses: 3, steps: 0, completedSteps: 0, reviews: 0, checks: null, failedChecks: null, lastResultSentence: 'Working.' });
  assert.equal(detail.bestOutput, null); assert.deepEqual(detail.usage, { tokens: null, costUsd: null, tracked: false });
  const gate = makeLoop(f, { gate: { before: 'first', onCap: 'stop' } });
  const waiting = await read(f, `/loops/${gate.id}`);
  assert.equal(waiting.status, 'awaiting_approval'); assert.equal(waiting.resultText, 'Waiting for your approval.');
  assert.equal(waiting.gate.kind, 'first'); assert.equal(typeof waiting.gate.requestedAt, 'number');
  assert.equal(summary(waiting).steps, 0);
});

for (const mode of ['converge', 'cap'] as const) test(`${mode}: widget summary pins terminal status, counts and exact result sentence`, async () => {
  const f = fixture(), loop = makeLoop(f); await runLoop(f, loop.id, mode);
  const detail = await read(f, `/loops/${loop.id}`);
  assert.deepEqual(summary(detail), {
    id: loop.id, status: mode === 'converge' ? 'succeeded' : 'capped', stopReason: mode === 'converge' ? 'passed' : 'max_iterations',
    passes: 3, maxPasses: 3, steps: 6, completedSteps: 6, reviews: 3, checks: 3, failedChecks: mode === 'converge' ? 0 : 2,
    lastResultSentence: mode === 'converge' ? 'Done in 3 passes: all checks passed.' : 'Stopped after 3 passes (limit). 2 of 3 checks still fail.',
  });
  assert.equal(detail.bestOutput.id, detail.bestOutputId);
  assert.equal(detail.iterations.length, 3);
  for (const [index, pass] of detail.iterations.entries()) {
    assert.equal(pass.iteration, index + 1); assert.equal(pass.steps.length, 2);
    assert.equal(pass.verdict.iteration, index + 1);
  }
  for (const step of detail.steps) fields(step, { id: 'string', iteration: 'number', botId: 'string', status: 'string', outputId: 'string', jobId: 'string' });
  for (const verdict of detail.verdicts) {
    fields(verdict, { iteration: 'number', pass: 'boolean', checklist: 'array', feedback: 'string' });
    for (const check of verdict.checklist) fields(check, { id: 'string', pass: 'boolean', note: 'string' });
  }
});

test('paused and cancelled summaries preserve state and result text without parsing UI labels', async () => {
  const f = fixture(), loop = makeLoop(f);
  loops.controlLoop(f.userId, loop.id, 'pause');
  const paused = await read(f, `/loops/${loop.id}`);
  assert.equal(paused.status, 'paused'); assert.equal(paused.resultText, 'Paused.');
  loops.controlLoop(f.userId, loop.id, 'stop');
  const stopped = await read(f, `/loops/${loop.id}`);
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.stopReason, 'user_stopped');
  assert.equal(stopped.resultText, 'Stopped by you.'); assert.equal(typeof stopped.finishedAt, 'number');
});

test('widget lists and detail reads cannot expose another account', async () => {
  const a = fixture(), b = fixture(), loop = makeLoop(a, {}, false), source = output(a, 'Private test release notes.');
  const handoff = handoffs.createHandoff(a.userId, { source: { outputId: source.id }, toBotId: a.checker.id, instruction: 'Review.', returnResult: false, idempotencyKey: 'private-widget' }).handoff;
  assert.deepEqual(await read(b, '/loops'), { loops: [], next: null });
  assert.deepEqual(await read(b, '/handoffs'), { handoffs: [], next: null });
  for (const route of [`/loops/${loop.id}`, '/loops/lp_missing', `/handoffs/${handoff.id}`, '/handoffs/ho_missing', `/handoffs?botId=${a.maker.id}`]) {
    const response = await app.request(`/api${route}`, { headers: b.headers });
    assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'Not found.', code: 'not_found' });
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { HANDOFF_TOOLS, HANDOFF_TOOL_SCHEMAS } from '../../server/src/agent/handoff-tools.js';
import { FLOW_TOOLS, FLOW_SUMMARY_SCHEMA } from '../../server/src/agent/flow-tools.js';

const schemas = { ...HANDOFF_TOOL_SCHEMAS, write_flow_summary: FLOW_SUMMARY_SCHEMA };
const tools = [...HANDOFF_TOOLS, ...FLOW_TOOLS];
const ctx = { userId: 'user_fixture', botId: 'bot_maker', jobId: 'job_fixture', toolCallId: 'call_fixture', depth: 0, enqueueBotMessage() {} };
const loop = {
  steps: [
    { id: 'make', botId: 'bot_maker', role: 'maker', instruction: 'Draft a placeholder release note.' },
    { id: 'check', botId: 'bot_checker', role: 'checker', instruction: 'Review the placeholder note.' },
  ],
  goal: 'A complete placeholder release note.', exit: { mode: 'verdict' }, limits: {},
};
const valid = {
  submit_output: { summary: 'Placeholder release note.' },
  handoff_to_agent: { toBotId: 'bot_checker', instruction: 'Review the placeholder note.' },
  read_handoff: { ref: 'swarm://output/out_fixture' },
  list_handoffs: {},
  submit_verdict: { pass: false, checklist: [], feedback: 'Add a version.' },
  start_loop: loop,
  write_flow_summary: { steps: [{ label: 'Draft release notes', detail: 'Use the supplied placeholder brief.' }] },
};

for (const [name, schema] of Object.entries(schemas)) {
  test(`${name}: strict arguments cannot supply runtime identities or approvals`, async () => {
    assert.equal(schema.safeParse(valid[name]).success, true);
    const tool = tools.find(tool => tool.name === name)!;
    assert.equal(tool.parameters.type, 'object');
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal('$schema' in tool.parameters, false);
    for (const field of ['userId', 'botId', 'jobId', 'toolCallId', 'initiatedBy', 'gate', 'approve', 'includeSensitive']) {
      const args = { ...valid[name], [field]: 'forged' };
      assert.equal(schema.safeParse(args).success, false, field);
      const result = await tool.impl(args, ctx);
      assert.equal(result.isError, true, field);
      assert.equal(typeof result.output, 'string');
      assert.match(result.output as string, /Invalid arguments/);
    }
  });
}

test('tool registry exposes only the seven scoped operations', () => {
  assert.deepEqual(tools.map(tool => tool.name).sort(), Object.keys(valid).sort());
  for (const tool of tools) assert.doesNotMatch(tool.name, /approve|extend|update_verdict|delete|grant/);
});

test('output schema enforces HTTPS, part counts and nested strictness', () => {
  const parse = (extra: unknown) => HANDOFF_TOOL_SCHEMAS.submit_output.safeParse({ ...valid.submit_output, ...extra }).success;
  const link = { url: 'https://example.com/brief', title: 'Fixture brief', relation: 'source' };
  assert.ok(parse({ links: [link] }));
  for (const url of ['http://example.com', 'javascript:alert(1)', 'file:///tmp/test', 'data:text/html,fixture', 'https://name:secret@example.com', 'not-a-url', 'https://']) assert.equal(parse({ links: [{ ...link, url }] }), false);
  assert.equal(parse({ links: [{ ...link, userId: 'forged' }] }), false);
  assert.equal(parse({ links: Array(31).fill(link) }), false);
  assert.equal(parse({ files: Array(21).fill('fixture.txt') }), false);
  assert.equal(parse({ dataParts: Array(6).fill({ name: 'fixture', json: {} }) }), false);
  assert.equal(parse({ dataParts: [{ name: 'fixture', json: {}, botId: 'forged' }] }), false);
  assert.equal(parse({ title: 'x'.repeat(121) }), false);
  assert.equal(parse({ summary: 'x'.repeat(1201) }), false);
  assert.equal(parse({ files: ['fixture\u0000.txt'] }), false);
});

test('data parts count UTF-8 bytes and accept only JSON values', () => {
  const schema = HANDOFF_TOOL_SCHEMAS.submit_output;
  const data = (json: unknown) => ({ summary: 'Fixture data.', dataParts: [{ name: 'fixture', json }] });
  assert.ok(schema.safeParse(data({ ready: true, count: 2, optional: null, items: ['placeholder'] })).success);
  assert.ok(schema.safeParse(data('x'.repeat(256 * 1024 - 2))).success);
  assert.equal(schema.safeParse(data('x'.repeat(256 * 1024 - 1))).success, false);
  assert.equal(schema.safeParse(data('界'.repeat(90_000))).success, false);
  for (const value of [undefined, NaN, Infinity, 1n, () => null, new Date()]) assert.equal(schema.safeParse(data(value)).success, false);
});

test('read schema requires exactly one scoped reference and bounded pages', () => {
  const schema = HANDOFF_TOOL_SCHEMAS.read_handoff;
  for (const ref of ['swarm://handoff/ho_fixture', 'swarm://output/out_fixture#p_body?o=5&l=8000']) assert.ok(schema.safeParse({ ref }).success);
  assert.ok(schema.safeParse({ handoffId: 'ho_fixture', partId: 'p_body', offset: 0, limit: 8000, materialize: true }).success);
  for (const args of [{}, { ref: 'https://example.com' }, { ref: '../out_fixture' }, { ...valid.read_handoff, handoffId: 'ho_fixture' },
    { ...valid.read_handoff, limit: 8001 }, { ...valid.read_handoff, limit: 0 }, { ...valid.read_handoff, offset: -1 },
    { ...valid.read_handoff, offset: 0.5 }, { ...valid.read_handoff, partId: '../secret' },
    { ref: 'swarm://output/out_fixture?o=0&l=8001' }, { ref: 'swarm://output/out_fixture?o=0&l=0' },
    { ref: 'swarm://output/out_fixture?o=9007199254740992&l=20' }]) assert.equal(schema.safeParse(args).success, false);
});

test('handoff and list schemas cap requests without silently coercing arguments', () => {
  assert.equal(HANDOFF_TOOL_SCHEMAS.handoff_to_agent.safeParse({ ...valid.handoff_to_agent, instruction: 'x'.repeat(2001) }).success, false);
  assert.equal(HANDOFF_TOOL_SCHEMAS.handoff_to_agent.safeParse({ ...valid.handoff_to_agent, priority: 'urgent' }).success, false);
  assert.equal(HANDOFF_TOOL_SCHEMAS.handoff_to_agent.safeParse({ ...valid.handoff_to_agent, returnResult: 'false' }).success, false);
  assert.deepEqual(HANDOFF_TOOL_SCHEMAS.list_handoffs.parse({}), { direction: 'all', limit: 20 });
  for (const limit of [0, 21, 1.5, '20']) assert.equal(HANDOFF_TOOL_SCHEMAS.list_handoffs.safeParse({ limit }).success, false);
  assert.equal(HANDOFF_TOOL_SCHEMAS.list_handoffs.safeParse({ status: 'anything' }).success, false);
});

test('loop schema supplies safe limits and cannot accept a gate bypass', () => {
  const schema = HANDOFF_TOOL_SCHEMAS.start_loop;
  assert.deepEqual(schema.parse(loop).limits, { maxIterations: 4, maxMinutes: 30, stepTimeoutMinutes: 10 });
  for (const [key, value] of [['maxIterations', 11], ['maxIterations', 0], ['maxIterations', 1.5], ['maxMinutes', 4],
    ['maxMinutes', 241], ['stepTimeoutMinutes', 31], ['maxCostUsd', 0], ['maxTokens', -1]]) {
    assert.equal(schema.safeParse({ ...loop, limits: { [key]: value } }).success, false, key);
  }
  for (const extra of [{ gate: { before: 'none' } }, { autoApproveLoops: true }, { initiatedBy: 'user' }]) {
    assert.equal(schema.safeParse({ ...loop, ...extra }).success, false);
  }
  assert.equal(schema.safeParse({ ...loop, limits: { allowUnlimited: true } }).success, false);
  assert.equal(schema.safeParse({ ...loop, steps: [{ ...loop.steps[0], userId: 'forged' }, loop.steps[1]] }).success, false);
  assert.equal(schema.safeParse({ ...loop, exit: { mode: 'verdict', pass: true } }).success, false);
});

test('loop schema refuses duplicate steps, invalid checker positions and self checking', () => {
  const schema = HANDOFF_TOOL_SCHEMAS.start_loop;
  for (const steps of [[loop.steps[0]], Array(7).fill(loop.steps[0]), [loop.steps[0], { ...loop.steps[1], id: 'make' }],
    [loop.steps[0], { ...loop.steps[1], botId: 'bot_maker' }], [loop.steps[1], loop.steps[0]]]) {
    assert.equal(schema.safeParse({ ...loop, kind: 'maker_checker', steps }).success, false);
  }
  assert.equal(schema.safeParse({ ...loop, kind: 'pipeline', steps: loop.steps.map(step => ({ ...step, role: 'step' })) }).success, false);
});

test('verdict schema rejects duplicate checks, claimed authority and oversized feedback', () => {
  const schema = HANDOFF_TOOL_SCHEMAS.submit_verdict;
  const item = { id: 'version', pass: false, note: 'Version missing.' };
  for (const extra of [{ claimedPass: true }, { score: 1.1 }, { score: -0.1 }, { checklist: [item, item] },
    { checklist: [{ ...item, approved: true }] }, { feedback: 'x'.repeat(2001) }, { checklist: [{ ...item, note: 'x'.repeat(401) }] }]) {
    assert.equal(schema.safeParse({ ...valid.submit_verdict, ...extra }).success, false);
  }
});

test('flow summary labels stay bounded, plain and free from forbidden dashes', () => {
  for (const steps of [[], Array(7).fill({ label: 'Draft' }), [{ label: 'x'.repeat(41) }], [{ label: 'Draft', detail: 'x'.repeat(61) }],
    [{ label: 'Read\u2013write' }], [{ label: 'Read\u2014write' }], [{ label: '<script>' }], [{ label: 'Draft', target: '#settings' }]]) {
    assert.equal(FLOW_SUMMARY_SCHEMA.safeParse({ steps }).success, false);
  }
});

test('malformed calls and cyclic input always return error text without throwing', async () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const tool of tools) for (const args of [null, undefined, [], 'invalid', 9, { unknown: true }]) {
    const result = await tool.impl(args, ctx);
    assert.equal(result.isError, true);
    assert.equal(typeof result.output, 'string');
  }
  const result = await tools.find(tool => tool.name === 'submit_output')!.impl({ summary: 'Fixture.', dataParts: [{ name: 'cycle', json: cyclic }] }, ctx);
  assert.equal(result.isError, true);
  assert.equal(typeof result.output, 'string');
});

test('unbound exported tools refuse safely until integration supplies the services', async () => {
  for (const tool of tools) {
    const result = await tool.impl(valid[tool.name], ctx);
    assert.equal(result.isError, true);
    assert.match(result.output as string, /not available yet/);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleToolCatalog, resolveToolCall, searchToolCatalog, toolSchemaHash, validateToolArguments, TOOL_VALIDATION_LIMITS } from '../server/src/agent/tool-catalog.js';
const tool = (name: string, description: string) => ({ type: 'function' as const, name, description, parameters: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'], additionalProperties: false } });

test('the Hermes ranking port prioritizes the intent and exact name instead of common verbs', () => {
  const catalog = [tool('gmail_send', 'Send Gmail email'), ...Array.from({ length: 50 }, (_, i) => tool(`incident_${i}`, 'Send an incident notification email'))];
  assert.deepEqual(searchToolCatalog(catalog, 'send gmail email').map(t => t.name), ['gmail_send']);
  assert.deepEqual(searchToolCatalog(catalog, 'gmail_send').map(t => t.name), ['gmail_send']);
  assert.deepEqual(searchToolCatalog(catalog, 'unavailable payroll').map(t => t.name), []);
  assert.deepEqual(searchToolCatalog(catalog, 'please send gmail email').map(t => t.name), ['gmail_send']);
  assert.deepEqual(searchToolCatalog(catalog, 'send gmail email frobnicate').map(t => t.name), ['gmail_send']);
});

test('large catalogs keep prompt schemas and the manifest bounded', () => {
  const catalog = [tool('ask_user', 'Ask a question'), tool('tool_search', 'Find tools'), tool('tool_describe', 'Describe tools'), tool('tool_call', 'Call tools'),
    ...Array.from({ length: 4096 }, (_, i) => tool(`mcp_catalog_1_action_${i}`, `Action ${i}`))];
  const assembled = assembleToolCatalog(catalog);
  assert.equal(assembled.tools.length, 4);
  assert.ok(assembled.manifest.length < 7000);
  assert.equal(searchToolCatalog(catalog, 'mcp_catalog_1_action_4095')[0].name, 'mcp_catalog_1_action_4095');
});

test('untrusted regex validation times out in a disposable worker while the host stays responsive', async () => {
  const evil = { type: 'function' as const, name: 'mcp_regex', parameters: { type: 'object', properties: { text: { type: 'string', pattern: '^(a+)+$' } }, required: ['text'] } };
  let ticks = 0; const tick = setInterval(() => ticks++, 20); const started = Date.now();
  try {
    await assert.rejects(() => validateToolArguments(evil, { text: `${'a'.repeat(30)}!` }), /time limit|resource limits/);
    assert.ok(ticks > 10, 'Host timer runs while the schema regex is busy in the worker');
    assert.ok(Date.now() - started < TOOL_VALIDATION_LIMITS.timeoutMs + 2500, 'Worker is forcibly terminated');
  } finally { clearInterval(tick); }
  await validateToolArguments(tool('after_timeout', 'A valid tool'), { count: 1 });
});

test('bounds reject deep, cyclic, oversized and non-JSON inputs before execution', async () => {
  const simple = tool('bounded', 'Bounded tool');
  const deep: any = {}; let node = deep;
  for (let i = 0; i < TOOL_VALIDATION_LIMITS.depth + 3; i++) { node.next = {}; node = node.next; }
  await assert.rejects(() => validateToolArguments(simple, deep), /depth|complexity/);
  const cyclic: any = {}; cyclic.self = cyclic;
  await assert.rejects(() => validateToolArguments(simple, cyclic), /depth|complexity/);
  await assert.rejects(() => validateToolArguments(simple, { text: 'x'.repeat(TOOL_VALIDATION_LIMITS.argumentBytes + 1) }), /size limit/);
  await assert.rejects(() => validateToolArguments({ ...simple, parameters: { description: 'x'.repeat(TOOL_VALIDATION_LIMITS.schemaBytes + 1) } }, {}), /size limit/);
  await assert.rejects(() => validateToolArguments(simple, { array: new Array(1_000_000) }), /dense JSON arrays|complexity/);
  await assert.rejects(() => validateToolArguments(simple, { count: Number.NaN }), /JSON values/);
  assert.throws(() => toolSchemaHash({ ...simple, parameters: deep }), /depth|complexity/);
});

test('schema compilation and validation errors are bounded and cannot poison following workers', async () => {
  const invalid = { type: 'function' as const, name: 'bad_ref', parameters: { $ref: 'https://not-fetched.invalid/unsafe' } };
  await assert.rejects(() => validateToolArguments(invalid, {}), /cannot be validated/);
  await assert.rejects(() => validateToolArguments(tool('after_bad_ref', 'Valid'), { count: 'bad' }), /Invalid tool arguments/);
  await validateToolArguments(tool('after_bad_ref', 'Valid'), { count: 2 });
});

test('concurrent disposable validators release capacity after success and rejection', async () => {
  const simple = tool('concurrent', 'Valid');
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => validateToolArguments(simple, { count: i % 2 ? 1 : 'bad' })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 4);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => /Invalid tool arguments/.test(String(r.reason))));
  await validateToolArguments(simple, { count: 1 });
});

test('resolution validates the current schema and refuses revoked tools and nested wrappers', async () => {
  const current = tool('mcp_account_2_read', 'Read records');
  const input = { tool_name: current.name, arguments: { count: 2 }, schema_hash: toolSchemaHash(current) };
  assert.deepEqual(await resolveToolCall([current], input), { name: current.name, args: { count: 2 } });
  await assert.rejects(() => resolveToolCall([], input), /no longer available/);
  await assert.rejects(() => resolveToolCall([{ ...current, parameters: { type: 'object' } }], input), /schema changed/);
  await assert.rejects(() => resolveToolCall([current], { ...input, arguments: { count: 'two' } }), /Invalid tool arguments/);
  await assert.rejects(() => resolveToolCall([current], { ...input, tool_name: 'tool_call' }), /one described tool/);
  await assert.rejects(() => resolveToolCall([current], { ...input, arguments: { count: 1, hidden: true } }), /Invalid tool arguments/);
});

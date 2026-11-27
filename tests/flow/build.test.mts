import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { buildFlowModel, flowInputsHash, stepHash, type FlowInputs } from '../../server/src/flow/build.js';
import { fixtures } from './fixtures.mjs';

for (const [name, input] of Object.entries(fixtures)) test(`golden model: ${name}`, () => {
  const actual = JSON.stringify(buildFlowModel(input), null, 2) + '\n';
  assert.equal(actual, fs.readFileSync(new URL(`golden/${name}.json`, import.meta.url), 'utf8'));
  assert.ok(Buffer.byteLength(actual) < 12 * 1024);
  assert.deepEqual(buildFlowModel(input).lanes.map(l => l.id), ['triggers','inputs','steps','outputs','handoffs']);
  assert.ok(buildFlowModel(input).lanes.every(l => l.nodes.length <= 5));
});
test('100 shuffled row orders produce byte identical models', () => {
  const expected = JSON.stringify(buildFlowModel(fixtures.rich));
  for (let i = 0; i < 100; i++) {
    const input = structuredClone(fixtures.rich);
    for (const key of ['routines','skills','apps','mcp','suggestions','links','loops'] as const) input[key].sort(() => Math.random() - 0.5);
    input.outputs.channels.reverse();
    assert.equal(JSON.stringify(buildFlowModel(input)), expected);
  }
});
test('every input class changes the hash; output count buckets absorb noise', () => {
  const base = fixtures.rich, hash = flowInputsHash(base);
  const mutations: ((i: FlowInputs) => void)[] = [i => i.bot.instructions += '\n4. Send results', i => i.bot.name += ' updated', i => i.bot.avatar += 'green', i => i.skills[0].body += ' Updated', i => i.skills[0].name += ' Updated', i => i.routines[0].schedule = 'Daily', i => i.routines[0].enabled = false, i => i.apps[0].attention = true, i => i.mcp[0].enabled = false, i => i.suggestions.pop(), i => i.links[0].mode = 'auto', i => i.loops.pop(), i => i.knowledge = 0, i => i.outputs.channels.push('SMS'), i => i.outputs.files = 6, i => i.outputs.purpose = 'A report'];
  for (const mutate of mutations) { const input = structuredClone(base); mutate(input); assert.notEqual(flowInputsHash(input), hash); }
  const noise = structuredClone(base); noise.outputs.files = 5; noise.outputs.tasks = 4; noise.knowledge = 5;
  assert.equal(flowInputsHash(noise), hash); assert.deepEqual(buildFlowModel(noise), buildFlowModel(base));
});
test('agent summary expires only when instructions or skills change', () => {
  const summary = { steps: [{ label: 'Check the sources', detail: 'Use the reference library' }] }, hash = stepHash(fixtures.rich);
  const model = (input: FlowInputs) => buildFlowModel(input, { version: 2, generatedAt: 1, summary, summaryHash: hash });
  assert.equal(model(fixtures.rich).source, 'agent+auto');
  const unrelated = structuredClone(fixtures.rich); unrelated.apps = []; assert.equal(model(unrelated).source, 'agent+auto');
  const stale = structuredClone(fixtures.rich); stale.skills[0].body += ' Updated';
  assert.equal(model(stale).source, 'auto'); assert.equal(model(stale).lanes[2].nodes[0].badge, 'Auto');
});
test('all emitted node kinds have the specified destinations and stable ids', () => {
  const nodes = buildFlowModel(fixtures.rich).lanes.flatMap(l => l.nodes);
  const targets: Record<string, RegExp> = { routine: /settings\/routines$/, event: /settings\/routines$/, message: /^#bot\/flow-rich$/, inbound_handoff: /details\/flow\?link=/, app: /^#settings\/apps$/, mcp: /^#settings\/mcp$/, knowledge: /settings\/memories$/, suggested_app: /^#apps\/connect$/, suggested_mcp: /^#settings\/mcp$/, step: /details\/setup\/responsibilities$/, skill: /settings\/skills$/, report: /details\/files\/reports$/, files: /details\/files$/, message_out: /^#settings\/messaging$/, task: /details\/tasks$/, handoff_to: /details\/flow\?link=/, handoff_from: /details\/flow\?link=/, loop: /^#loop\// };
  assert.equal(new Set(nodes.map(n => n.id)).size, nodes.length);
  for (const node of nodes) { assert.match(node.target.hash, targets[node.kind]); assert.ok(node.label.length <= 40); assert.ok((node.detail?.length ?? 0) <= 60); }
  for (const kind of Object.keys(targets)) assert.ok(nodes.some(n => n.kind === kind), kind);
});
test('no network or model calls in pure generation', () => {
  const previous = globalThis.fetch; globalThis.fetch = () => { throw new Error('Offline guard'); };
  try { for (const input of Object.values(fixtures)) buildFlowModel(input); } finally { globalThis.fetch = previous; }
});
test('new flow sources contain no forbidden punctuation or provider imports', () => {
  for (const dir of ['../../server/src/flow','../../web/src/flow']) for (const file of fs.readdirSync(new URL(dir, import.meta.url)).filter(f => /\.(ts|tsx|css)$/.test(f))) {
    const text = fs.readFileSync(new URL(`${dir}/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /[\u2013\u2014]/, file);
    if (file === 'build.ts' || file === 'cache.ts') assert.doesNotMatch(text, /from ['"].*(composio|llm|openai|agent\/loop)/);
  }
});

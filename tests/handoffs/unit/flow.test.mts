import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { extractSteps, flowLabel } from '../../../server/src/flow/extract-steps.js';
import { layoutFlow } from '../../../server/src/flow/layout.js';
import { inputsHash, stepsHash, type FlowHashInputs } from '../../../server/src/flow/hash.js';
import { layoutRunGraph } from '../../../server/src/handoffs/graph-layout.js';
import { flow, random, shuffle } from './fixtures.mts';
const goldens: [string, string, string[]][] = [
  ['heading', '# Other\n- Ignore this\n## Process\n1. collect evidence.\n2. review results!\n## Notes\n- Ignore this too', ['Collect evidence', 'Review results']],
  ['plain heading', 'Steps:\n* check status\n* send a report\nNotes:\n* Skip', ['Check status', 'Send a report']],
  ['bullets', 'Useful guidance\n- monitor changes\n- update tasks', ['Monitor changes', 'Update tasks']],
  ['imperative', 'This describes the bot. Collect reports. Review results. The rest is context.', ['Collect reports', 'Review results']],
  ['empty', '', []], ['non English', '流程\n- 收集信息\n- 检查结果', ['收集信息', '检查结果']],
  ['fence', '```\n- Example only\n```\nCheck status.', ['Check status']],
];
for (const [name, instructions, labels] of goldens) test(`extractSteps golden: ${name}`, () => assert.deepEqual(extractSteps(instructions).map(s => s.label), labels));
test('skills add stable, deduplicated nodes and labels stay within forty chars', () => {
  const skills = [{ id: 'b', name: 'Weekly report' }, { id: 'a', name: 'Archive' }];
  const instructions = 'Steps:\n- Draft the weekly report';
  assert.deepEqual(extractSteps(instructions, skills).map(s => s.label), ['Draft the weekly report', 'Skill: Archive']);
  assert.deepEqual(extractSteps(instructions, skills), extractSteps(instructions, skills.reverse()));
  assert.equal(extractSteps(Array.from({ length: 12 }, (_, i) => `- check item ${i}`).join('\n'), skills).length, 6);
  assert.equal(flowLabel('check the long placeholder report with many sections for a test'), 'Check the long placeholder report with');
  assert.ok(flowLabel('x'.repeat(100)).length <= 40);
});
const plans = JSON.parse(readFileSync(new URL('./flow.golden.json', import.meta.url), 'utf8'));
for (const width of [390, 1280]) test(`flow layout golden at ${width}`, () => assert.deepEqual(layoutFlow(flow(), width), plans[width]));
function geometry(plan: { column: { x: number; width: number }; height: number; nodes: { id: string; x: number; y: number; w: number; h: number }[] }) {
  for (const a of plan.nodes) {
    assert.ok(a.x >= plan.column.x - 0.001); assert.ok(a.x + a.w <= plan.column.x + plan.column.width + 0.001, a.id);
    assert.ok(a.y >= 0 && a.y + a.h <= plan.height + 0.001);
    for (const b of plan.nodes) if (a !== b) assert.ok(a.x + a.w <= b.x + 0.001 || b.x + b.w <= a.x + 0.001 || a.y + a.h <= b.y + 0.001 || b.y + b.h <= a.y + 0.001, `${a.id} overlaps ${b.id}`);
  }
}
test('layout property: 100 shuffled models at variable column widths are byte stable, bounded and disjoint', () => {
  const rng = random(100);
  for (let n = 0; n < 100; n++) {
    const model = flow();
    for (const lane of model.lanes) {
      lane.nodes = Array.from({ length: Math.floor(rng() * 14) }, (_, i) => ({ id: `${lane.id}:${i}`, kind: 'step' as const, label: `Placeholder ${i}`, target: { hash: '#test' }, state: 'ok' as const })); lane.more = n % 3;
    }
    const width = n < 2 ? [390, 1280][n] : 1 + Math.floor(rng() * 1800), plan = layoutFlow(model, width);
    geometry(plan); assert.ok(plan.lanes.every(l => l.nodes.filter(n => n.kind === 'node').length <= 5));
    const shuffled = { ...model, lanes: shuffle(model.lanes, rng).map(lane => ({ ...lane, nodes: shuffle(lane.nodes, rng) })) };
    assert.equal(JSON.stringify(layoutFlow(shuffled, width)), JSON.stringify(plan)); assert.equal(JSON.stringify(layoutFlow(model, width)), JSON.stringify(plan));
  }
});
test('run graph orders steps by first appearance, updates output refs, labels feedback and collapses narrow columns', () => {
  const events = Array.from({ length: 6 }, (_, i) => ({ seq: i + 1, createdAt: i, type: 'loop.step_dispatched', data: { iteration: Math.floor(i / 2) + 1, stepId: i % 2 ? 'checker' : 'maker', botId: i % 2 ? 'bot_checker' : 'bot_maker', role: i % 2 ? 'checker' : 'maker' } }));
  const complete = { seq: 7, createdAt: 7, type: 'loop.step_completed', data: { iteration: 1, stepId: 'maker', outputId: 'out_test', title: 'Test draft' } };
  const all = [...events, complete];
  for (const width of [390, 1280]) {
    const plan = layoutRunGraph(all, width); geometry(plan); assert.equal(plan.nodes.length, 6); assert.equal(plan.nodes[0].outputId, 'out_test');
    assert.equal(plan.edges[1].label, 'feedback'); assert.equal(plan.edges[1].loopBack, true); assert.equal(plan.mode, width === 390 ? 'stacked' : 'columns');
    const rng = random(); for (let i = 0; i < 100; i++) assert.equal(JSON.stringify(layoutRunGraph(shuffle(all, rng), width)), JSON.stringify(plan));
  }
});
test('run graph property: many bots never escape the column', () => {
  const rng = random(88);
  for (let n = 0; n < 100; n++) {
    const events = Array.from({ length: n % 20 }, (_, i) => ({ seq: i, createdAt: i, type: 'loop.step_dispatched', data: { iteration: i + 1, stepId: `step_${i}`, botId: `bot_${i}` } }));
    geometry(layoutRunGraph(events, 1 + rng() * 1800));
  }
});
test('flow hash is stable across row order and irrelevant row noise, sensitive to each input class and bucket transitions', () => {
  const input: FlowHashInputs = { instructions: 'Check status', skills: [{ id: 's1', name: 'Check', bodyHash: 'a' }, { id: 's2', name: 'Report', bodyHash: 'b' }], routines: [{ id: 'r', schedule: 'daily', enabled: true }],
    appIds: ['app_b', 'app_a'], mcpIds: ['mcp'], suggestionIds: ['suggested'], links: [{ id: 'l', fromBotId: 'a', toBotId: 'b', mode: 'suggest', trigger: 'any_run', template: 'Review' }], bot: { name: 'Maker', avatar: 'blue' }, outputCounts: { text: 2 }, activeLoopIds: ['lp_test'] };
  const hash = inputsHash(input); assert.equal(inputsHash({ ...input, skills: [...input.skills].reverse(), appIds: [...input.appIds].reverse() }), hash);
  assert.equal(inputsHash({ ...input, outputCounts: { text: 5 } }), hash);
  assert.notEqual(inputsHash({ ...input, outputCounts: { text: 6 } }), hash);
  const variants = [ { instructions: 'Changed' }, { skills: input.skills.slice(0, 1) }, { routines: [{ ...input.routines[0], enabled: false }] }, { appIds: [] }, { mcpIds: [] }, { suggestionIds: [] }, { links: [] }, { bot: { ...input.bot, name: 'Changed' } }, { activeLoopIds: [] } ];
  for (const variant of variants) assert.notEqual(inputsHash({ ...input, ...variant }), hash);
  assert.equal(inputsHash({ ...input, routines: [{ ...input.routines[0], lastRunAt: 999 } as typeof input.routines[number]] }), hash);
  assert.equal(stepsHash(input.instructions, input.skills), stepsHash(input.instructions, [...input.skills].reverse()));
});

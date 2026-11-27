import assert from 'node:assert/strict';
import test from 'node:test';
import { HANDOFF_TOOLS, configureHandoffTools } from '../../server/src/agent/handoff-tools.js';
import { FLOW_TOOLS, configureFlowTools } from '../../server/src/agent/flow-tools.js';
import { context, createFixture } from './demo-c.mjs';

test('HO-I can bind the exported arrays to scoped services without replacing tool definitions', async () => {
  const fixture = createFixture();
  configureHandoffTools(fixture.service);
  configureFlowTools(fixture.flowStore, fixture.service);
  const result = await HANDOFF_TOOLS.find(tool => tool.name === 'submit_output')!.impl({ summary: 'Placeholder output.' }, context());
  assert.equal(result.isError, undefined);
  assert.equal(JSON.parse(result.output as string).status, 'draft');
  const saved = await FLOW_TOOLS[0].impl({ steps: [{ label: 'Review a brief' }] }, context());
  assert.equal(saved.isError, undefined);
  assert.equal(JSON.parse(saved.output as string).saved, true);
  assert.equal(fixture.summaries.has('user_fixture:bot_maker'), true);
});

test('bound exports still check the per-user setting and isolated factories keep their own services', async () => {
  const enabled = createFixture();
  const disabled = createFixture({ settings: { user_fixture: { enabled: false, agentHandoffs: 'team' } } });
  configureHandoffTools(disabled.service);
  configureFlowTools(disabled.flowStore, disabled.service);
  const exported = await HANDOFF_TOOLS.find(tool => tool.name === 'submit_output')!.impl({ summary: 'Placeholder.' }, context());
  assert.equal(exported.isError, true);
  assert.match(exported.output as string, /disabled/);
  const exportedFlow = await FLOW_TOOLS[0].impl({ steps: [{ label: 'Review' }] }, context());
  assert.equal(exportedFlow.isError, true);
  assert.equal((await enabled.call('submit_output', { summary: 'Placeholder.' })).isError, undefined);
});

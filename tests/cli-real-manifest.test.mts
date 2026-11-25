import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mockCliProvider, modelTools, modelOutputs } from './fixtures/real-cli-provider.mjs';
import { runGeneration } from '../companion/cli-bridge.mjs';
const schema = { type: 'object', properties: { text: { type: 'string' }, tool_calls: { type: 'array', items: { type: 'object' }, maxItems: 0 } }, required: ['text', 'tool_calls'], additionalProperties: false };
const names = ['SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE', 'tool_search', 'tool_describe', 'tool_call', 'CaseTool', 'casetool', 'boundary_' + 'x'.repeat(55)];
const nativeTools = names.map(name => ({ name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: false } }));

for (const provider of ['codex', 'claude'] as const) test(`real ${provider}: tools/list preserves case, 64 character names and exact enabled tools`, { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'real-manifest-'));
  let step = 0;
  const fixture = await mockCliProvider(directory, (p: string, body: any) => {
    assert.deepEqual(modelTools(p, body).map((tool: any) => tool.name).sort(), [...names].sort());
    if (step >= names.length) return { text: 'All tools called.' };
    const name = names[step++]; return { name: p === 'claude' ? `mcp__swarm__${name}` : name, args: {} };
  });
  t.after(async () => { await fixture.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const calls: string[] = [];
  const result = await runGeneration({ provider, model: 'default', timeoutMs: 10000, prompt: 'Call each registered fixture tool.', schema, nativeTools }, {
    [`${provider}Path`]: fixture.install(provider), env: { PATH: process.env.PATH, HOME: directory }, onToolCall: async (call: any) => { calls.push(call.name); return { output: 'Fixture accepted.' }; },
  });
  assert.equal(JSON.parse(result.text).text, 'All tools called.');
  assert.deepEqual(calls, names);
  assert.deepEqual(fixture.errors, []);
  const args = fixture.args(provider)[0];
  if (provider === 'codex') {
    assert.ok(args.includes('read-only')); assert.ok(args.includes('approval_policy="never"'));
    const config = args.find((arg: string) => arg.startsWith('mcp_servers='));
    assert.ok(config.includes('enabled_tools=' + JSON.stringify(names)));
    assert.match(config, /required=true,default_tools_approval_mode="approve"/);
  } else {
    assert.ok(args.includes('--restricted')); assert.ok(args.includes('dontAsk'));
    assert.equal(args[args.indexOf('--allowedTools') + 1], names.map(name => `mcp__swarm__${name}`).join(','));
  }
});

test('real Codex required MCP rejects an invalid generation token before any model request', { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'real-required-'));
  const fixture = await mockCliProvider(directory, () => ({ text: 'Must not be requested.' }));
  t.after(async () => { await fixture.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let calls = 0;
  await assert.rejects(runGeneration({ provider: 'codex', model: 'default', timeoutMs: 15000, prompt: 'Use Swarm.', schema, nativeTools }, {
    codexPath: fixture.install('codex', { codexConfig: ['mcp_servers.swarm.http_headers.Authorization="Bearer invalid-generation-token"'] }),
    env: { PATH: process.env.PATH, HOME: directory }, onToolCall: async () => { calls++; return { output: 'Must not run.' }; },
  }), { code: 'mcp_auth', message: /Codex could not authenticate with the Swarm tool bridge.*Settings > Subscriptions/ });
  assert.equal(calls, 0); assert.equal(fixture.requests.length, 0);
});

test('real Codex honors the MCP tool timeout independently of the generation deadline', { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'real-timeout-'));
  let step = 0;
  const fixture = await mockCliProvider(directory, () => step++ === 0 ? { name: 'SWARM_APPS_SEARCH', args: {} } : { text: 'The fixture timed out.' });
  t.after(async () => { await fixture.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let calls = 0;
  await runGeneration({ provider: 'codex', model: 'default', timeoutMs: 10000, prompt: 'Use Swarm.', schema, nativeTools }, {
    codexPath: fixture.install('codex', { codexConfig: ['mcp_servers.swarm.tool_timeout_sec=1'] }), env: { PATH: process.env.PATH, HOME: directory },
    onToolCall: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 1500)); return { output: 'Late fixture result.' }; },
  });
  assert.equal(calls, 1);
  assert.match(JSON.stringify(fixture.requests.flatMap(r => modelOutputs('codex', r.body))), /timed out|deadline has elapsed/i);
});

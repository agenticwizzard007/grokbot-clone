import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runGeneration, startBridge } from '../companion/cli-bridge.mjs';

const nativeTools = [{ name: 'SWARM_READ', description: 'Read application data', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }];
const schema = { type: 'object', properties: { text: { type: 'string' }, tool_calls: { type: 'array', maxItems: 0, items: { type: 'object' } } }, required: ['text', 'tool_calls'], additionalProperties: false };
const request = (provider = 'codex', extra = {}) => ({ provider, prompt: 'Use Swarm tools and return JSON.', schema, nativeTools, timeoutMs: 5000, ...extra });
const waitFor = async (work: () => Promise<any> | any) => { const end = Date.now() + 5000; while (Date.now() < end) { if (await work()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Condition timed out'); };
async function fixture(t: any, provider = 'codex', script = `const a = await client.callTool({ name: 'SWARM_READ', arguments: { value: 'one' } }); const b = await client.callTool({ name: 'SWARM_READ', arguments: { value: 'two' } }); answer = JSON.stringify([a, b]);`, bootstrap = true) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-native-runner-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'cli.mjs'), auditFile = join(root, 'audit.jsonl');
  await writeFile(executable, `#!${process.execPath}
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { Client } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))};
import { StreamableHTTPClientTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'))};
const args = process.argv.slice(2), cwd = process.cwd();
const audit = data => fs.appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify(data) + '\\n');
if (args[0] === 'login' || args[0] === 'auth') {
 console.log(${JSON.stringify(provider === 'codex' ? 'Logged in using ChatGPT' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }))}); process.exit(0);
}
let input='';for await (const chunk of process.stdin) input+=chunk;
let config;
if (${JSON.stringify(provider)} === 'claude') config=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.swarm;
else { const raw=args.find(a=>a.startsWith('mcp_servers=')); config={url:JSON.parse(/url=("(?:[^"\\\\]|\\\\.)*")/.exec(raw)[1]),headers:{Authorization:JSON.parse(/Authorization=("(?:[^"\\\\]|\\\\.)*")/.exec(raw)[1])}}; }
audit({kind:'start',cwd,args,input,config,env:process.env});
let answer='done', finalUsage={input_tokens:3,output_tokens:2};
const client = new Client({name:'native-runner-fixture',version:'1'});
const rpc = async (id,name,input) => {const response=await fetch(config.url,{method:'POST',headers:{...config.headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:input}})});return response.json();};
${bootstrap ? `await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}})); const listing=await client.listTools(); audit({kind:'tools',tools:listing.tools});` : ''}
${script}
await client.close();
const output={text:answer,tool_calls:[]};
if (${JSON.stringify(provider)} === 'codex') {fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(output));console.log(JSON.stringify({type:'turn.completed',usage:finalUsage}));}
else console.log(JSON.stringify({type:'result',subtype:'success',structured_output:output,usage:finalUsage}));
`, { mode: 0o700 });
  const events = async () => { try { return (await readFile(auditFile, 'utf8')).trim().split('\n').map(x => JSON.parse(x)); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; } };
  const options = { [`${provider}Path`]: executable, env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), OPENAI_API_KEY: 'private-sentinel', ANTHROPIC_BASE_URL: 'https://untrusted.test', NODE_OPTIONS: '--untrusted' } };
  return { options, events };
}

for (const provider of ['codex', 'claude']) test(`${provider}: official MCP client consumes two native tool results in one isolated CLI generation`, async t => {
  const f = await fixture(t, provider), calls: any[] = [];
  const image = 'data:image/png;base64,aGVsbG8=';
  const result = await runGeneration(request(provider), { ...f.options, onToolCall: async call => {
    calls.push(call);
    return call.arguments.value === 'one' ? { output: [{ type: 'input_text', text: 'read result' }, { type: 'input_image', image_url: image }] } : { output: { count: 2 }, isError: true };
  } });
  assert.deepEqual(calls.map(c => [c.name, c.arguments]), [['SWARM_READ', { value: 'one' }], ['SWARM_READ', { value: 'two' }]]);
  assert.notEqual(calls[0].id, calls[1].id);
  assert.equal(result.usage_status, 'complete');
  const outputs = JSON.parse(JSON.parse(result.text).text);
  assert.deepEqual(outputs[0].content, [{ type: 'text', text: 'read result' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }]);
  assert.deepEqual(outputs[1], { content: [{ type: 'text', text: '{"count":2}' }], isError: true });
  const events = await f.events(), started = events.find(e => e.kind === 'start');
  assert.equal(events.filter(e => e.kind === 'start').length, 1);
  assert.deepEqual(events.find(e => e.kind === 'tools').tools, nativeTools.map(({ parameters, ...rest }) => ({ ...rest, inputSchema: parameters, ...(provider === 'claude' ? { _meta: { 'anthropic/maxResultSizeChars': 500000 } } : {}) })));
  assert.doesNotMatch(JSON.stringify(started.env), /private-sentinel|untrusted/);
  if (provider === 'codex') {
    for (const expected of ['--ignore-user-config', '--ignore-rules', 'features.shell_tool=false', 'features.hooks=false', 'features.apps=false', 'features.plugins=false', 'features.multi_agent=false', 'read-only']) assert.ok(started.args.includes(expected), expected);
    assert.match(started.args.find((arg: string) => arg.startsWith('mcp_servers=')), /required=true,default_tools_approval_mode="auto"/);
  } else {
    assert.ok(started.args.includes('--restricted')); assert.ok(!started.args.includes('--safe-mode')); assert.ok(!started.args.includes('--bare'));
    assert.equal(started.args[started.args.indexOf('--tools') + 1], '');
    assert.equal(started.args[started.args.indexOf('--allowedTools') + 1], 'mcp__swarm__SWARM_READ');
    assert.ok(started.args.includes('--strict-mcp-config'));
  }
  await assert.rejects(stat(started.cwd), { code: 'ENOENT' });
  await assert.rejects(fetch(started.config.url));
});

for (const provider of ['codex', 'claude']) test(`${provider}: final usage remains unavailable or partial until valid totals are reported`, async t => {
  for (const [raw, expected] of [
    [undefined, { usage_status: 'unavailable' }],
    [{ input_tokens: -1, output_tokens: 'bad' }, { usage_status: 'unavailable' }],
    [{ input_tokens: 7 }, { usage_status: 'partial', usage: { input_tokens: 7 } }],
    [{ output_tokens: 2 }, { usage_status: 'partial', usage: { output_tokens: 2 } }],
    [{ input_tokens: 0, output_tokens: 0 }, { usage_status: 'complete', usage: { input_tokens: 0, output_tokens: 0 } }],
  ] as const) {
    const f = await fixture(t, provider, `finalUsage=${raw === undefined ? 'undefined' : JSON.stringify(raw)};`);
    const result = await runGeneration(request(provider), { ...f.options, onToolCall: async () => ({ output: 'unused' }) });
    const { text, ...accounting } = result;
    assert.deepEqual(accounting, expected);
  }
});

test('MCP retries deduplicate IDs and reject changed payloads, unknown tools and invalid arguments', async t => {
  const f = await fixture(t, 'codex', `
    const [a,b] = await Promise.all([rpc('same','SWARM_READ',{value:'one'}),rpc('same','SWARM_READ',{value:'one'})]);
    const changed=await rpc('same','SWARM_READ',{value:'two'});
    const unknown=await rpc('unknown','shell',{command:'touch /tmp/untrusted'});
    const malformed=await rpc('bad','SWARM_READ',[]);
    answer=JSON.stringify({a,b,changed,unknown,malformed});
  `);
  let calls = 0;
  const result = await runGeneration(request(), { ...f.options, onToolCall: async () => { calls++; await new Promise(r => setTimeout(r, 20)); return { output: 'read' }; } });
  assert.equal(calls, 1);
  const output = JSON.parse(JSON.parse(result.text).text);
  assert.deepEqual(output.a, output.b);
  assert.match(output.changed.error.message, /reused/);
  assert.match(output.unknown.error.message, /Unknown/);
  assert.match(output.malformed.error.message, /invalid arguments/);
});

for (const provider of ['codex', 'claude']) test(`${provider}: stop kills the CLI and descendants without sending an invented result or running queued actions`, async t => {
  const f = await fixture(t, provider, `
    const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
    audit({kind:'descendant',pid:descendant.pid});
    const a=rpc('stop','SWARM_READ',{value:'approval'});const b=rpc('queued','SWARM_READ',{value:'must-not-execute'});
    await Promise.all([a,b]); audit({kind:'continued'}); answer='invented success';
  `);
  let calls = 0;
  const result = await runGeneration(request(provider), { ...f.options, onToolCall: async () => { calls++; return { output: 'pending approval', stop: true }; } });
  assert.deepEqual(result, { text: '{"text":"","tool_calls":[]}', stopped: true, usage_status: 'unavailable' });
  assert.equal(calls, 1);
  const events = await f.events();
  assert.equal(events.some(e => e.kind === 'continued'), false);
  const pid = events.find(e => e.kind === 'descendant').pid;
  await waitFor(async () => { try { return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2] === 'Z'; } catch { return true; } });
  await assert.rejects(stat(events[0].cwd), { code: 'ENOENT' });
});

for (const provider of ['codex', 'claude']) test(`${provider}: stop retains observed usage as partial without fabricating missing counters`, async t => {
  const event = provider === 'claude'
    ? { type: 'assistant', message: { id: 'message-one', usage: { input_tokens: 7, cache_read_input_tokens: 3, output_tokens: -1 } } }
    : { type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: -1 } };
  const f = await fixture(t, provider, `
    const event=${JSON.stringify(event)};
    console.log(JSON.stringify(event)); console.log(JSON.stringify(event));
    await new Promise(r=>setTimeout(r,30));
    await client.callTool({name:'SWARM_READ',arguments:{value:'approval'}});
    throw new Error('stopped CLI must never continue');
  `);
  const result = await runGeneration(request(provider), { ...f.options, onToolCall: async () => ({ output: 'approval', stop: true }) });
  assert.equal(result.stopped, true);
  assert.equal(result.usage_status, 'partial');
  assert.deepEqual(result.usage, { input_tokens: provider === 'claude' ? 10 : 7, input_tokens_details: { cached_tokens: 3 } });
  assert.equal(Object.hasOwn(result.usage, 'output_tokens'), false);
});

test('callbacks are bounded by cancellation and the generation deadline', async t => {
  for (const cancel of [true, false]) {
    const f = await fixture(t), controller = new AbortController();
    let started = false;
    const pending = runGeneration(request('codex', { timeoutMs: cancel ? 5000 : 3000 }), { ...f.options, signal: controller.signal, onToolCall: () => { started = true; return new Promise(() => {}); } });
    // Register the rejection assertion before waiting for startup. A loaded
    // machine must not turn a legitimate deadline rejection into an unhandled
    // rejection while the test is still awaiting the callback.
    const completion = assert.rejects(pending, cancel ? /cancelled/ : /timed out/);
    await waitFor(() => started);
    if (cancel) controller.abort();
    await completion;
    const events = await f.events();
    await assert.rejects(stat(events[0].cwd), { code: 'ENOENT' });
    await assert.rejects(fetch(events[0].config.url));
  }
});

test('native mode fails closed without a handler, on callback failure and if tools never load', async t => {
  await assert.rejects(runGeneration(request()), /tool handler/);
  const f = await fixture(t);
  await assert.rejects(runGeneration(request(), { ...f.options, onToolCall: async () => { throw new Error('private-sentinel'); } }), (error: Error) => {
    assert.match(error.message, /Native tool execution failed/); assert.doesNotMatch(error.message, /private-sentinel/); return true;
  });
  const unloaded = await fixture(t, 'claude', '', false);
  await assert.rejects(runGeneration(request('claude'), { ...unloaded.options, onToolCall: async () => ({ output: 'unused' }) }), /did not load the native Swarm MCP tools/);
});

test('MCP endpoint refuses missing auth, foreign origins, wrong hosts and remote result images', async t => {
  const f = await fixture(t, 'codex', `
    const body=JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/list'});
    const bad=[];
    for(const headers of [{'Content-Type':'application/json'},{...config.headers,'Content-Type':'application/json',Origin:'https://foreign.test'}]) bad.push((await fetch(config.url,{method:'POST',headers,body})).status);
    bad.push(await new Promise((resolve,reject)=>{const r=httpRequest(config.url,{method:'POST',headers:{...config.headers,'Content-Type':'application/json',Host:'foreign.test'}},res=>{res.resume();resolve(res.statusCode)});r.on('error',reject);r.end(body)}));
    answer=JSON.stringify(bad);
  `);
  const result = await runGeneration(request(), { ...f.options, onToolCall: async () => ({ output: 'unused' }) });
  assert.deepEqual(JSON.parse(JSON.parse(result.text).text), [403, 403, 404]);
  const badImage = await fixture(t);
  await assert.rejects(runGeneration(request(), { ...badImage.options, onToolCall: async () => ({ output: [{ type: 'input_image', image_url: 'https://private.test/image.png' }] }) }), /inline images/);
});

test('Claude keeps 60k results inline and explicitly bounds larger output without local Read', async t => {
  for (const length of [60000, 600000]) {
    const f = await fixture(t, 'claude', `answer=JSON.stringify(await client.callTool({name:'SWARM_READ',arguments:{value:'large'}}));`);
    const result = await runGeneration(request('claude'), { ...f.options, onToolCall: async () => ({ output: 'x'.repeat(length) }) });
    const content = JSON.parse(JSON.parse(result.text).text).content;
    assert.equal(content[0].text.length, Math.min(length, 400000));
    if (length > 400000) assert.match(content[1].text, /truncated.*paginate/);
    else assert.equal(content.length, 1);
  }
});

test('native manifests reject duplicate names, invalid schemas and unbounded input', async () => {
  for (const manifest of [null, {}, [nativeTools[0], nativeTools[0]], [{ ...nativeTools[0], name: 'shell(*)' }], [{ ...nativeTools[0], parameters: [] }], [{ ...nativeTools[0], description: 'x'.repeat(8 * 1024 * 1024) }]]) {
    await assert.rejects(runGeneration(request('codex', { nativeTools: manifest }), { onToolCall: async () => ({ output: '' }) }));
  }
});

function socketMock(onSend: (socket: any, message: any) => void) {
  const instances: any[] = [];
  class MockSocket extends EventTarget {
    readyState = 0; bufferedAmount = 0; sent: any[] = [];
    constructor(public url: string) { super(); instances.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(data: string) { const m = JSON.parse(data); this.sent.push(m); onSend(this, m); }
    receive(m: any) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(m) })); }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  }
  return { MockSocket, instances };
}

test('personal WS advertises native MCP and scopes tool results to connection, generation and call', async t => {
  const f = await fixture(t), controller = new AbortController();
  const observed: any[] = [], results: any[] = [];
  const { MockSocket, instances } = socketMock((socket, m) => {
    if (m.type === 'hello') {
      assert.equal(m.nativeMcp, true); socket.receive({ type: 'welcome' });
      for (const id of ['a', 'b']) socket.receive({ id, method: 'generate', params: request() });
    } else if (m.type === 'tool_call') {
      observed.push(m);
      socket.receive({ id: m.id === 'a' ? 'b' : 'a', type: 'tool_result', callId: m.call.id, result: { output: 'crossed' } });
      socket.receive({ id: m.id, type: 'tool_result', callId: 'wrong', result: { output: 'wrong' } });
      const reply = { id: m.id, type: 'tool_result', callId: m.call.id, result: { output: m.id + ':' + m.call.arguments.value } };
      socket.receive(reply); socket.receive(reply);
    } else if (m.result) {
      results.push(m);
      if (results.length === 2) controller.abort();
    }
  });
  await startBridge({ server: 'https://swarm.test', token: 'private-token', ...f.options, signal: controller.signal, WebSocketImpl: MockSocket });
  assert.equal(observed.length, 4);
  assert.equal(new Set(observed.map(m => m.call.id)).size, 4);
  for (const reply of results) {
    const output = JSON.parse(JSON.parse(reply.result.text).text);
    assert.deepEqual(output.map((r: any) => r.content[0].text), [reply.id + ':one', reply.id + ':two']);
  }
  assert.equal(instances.length, 1);
});

test('personal WS cancellation and deadline release pending callback replies', async t => {
  for (const cancel of [true, false]) {
    const f = await fixture(t), controller = new AbortController();
    let reply: any, toolCalled = false;
    const { MockSocket } = socketMock((socket, m) => {
      if (m.type === 'hello') socket.receive({ id: 'job', method: 'generate', params: request('codex', { timeoutMs: cancel ? 5000 : 3000 }) });
      else if (m.type === 'tool_call') { toolCalled = true; if (cancel) socket.receive({ id: 'job', method: 'cancel' }); }
      else if (m.error) { reply = m; controller.abort(); }
    });
    await startBridge({ server: 'https://swarm.test', token: 'private-token', ...f.options, signal: controller.signal, WebSocketImpl: MockSocket });
    assert.equal(toolCalled, true, 'deadline must exercise a pending native callback after CLI startup');
    assert.match(reply.error, cancel ? /cancelled/ : /timed out/);
  }
});

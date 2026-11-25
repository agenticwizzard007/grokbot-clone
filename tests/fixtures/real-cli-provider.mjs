// Offline model endpoint for the installed official CLIs. Only the subscription
// status and account catalog are stubbed; every generation, argument, MCP client and tool call
// runs in the real binary. Nothing here is imported by production code.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { gunzipSync, brotliDecompressSync, inflateSync } from 'node:zlib';
const require = createRequire(import.meta.url);

export function officialExecutable(provider) {
  const pkg = provider === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  const manifest = require.resolve(`${pkg}/package.json`);
  return path.resolve(path.dirname(manifest), require(manifest).bin[provider]);
}

export async function mockCliProvider(directory, choose) {
  const requests = [], errors = [];
  let serial = 0;
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      let bytes = Buffer.concat(chunks);
      const decompress = { gzip: gunzipSync, br: brotliDecompressSync, deflate: inflateSync }[req.headers['content-encoding']];
      if (decompress) bytes = decompress(bytes);
      const body = bytes.length ? JSON.parse(bytes) : {};
      if (req.url.includes('count_tokens')) { res.end(JSON.stringify({ input_tokens: 10 })); return; }
      if (!req.url.includes('responses') && !req.url.includes('messages')) throw Error(`Unexpected local request: ${req.url}`);
      const provider = req.url.includes('responses') ? 'codex' : 'claude';
      requests.push({ provider, body });
      const action = await choose(provider, body);
      const n = ++serial;
      const text = JSON.stringify({ text: action.text ?? 'Fixture complete.', tool_calls: [] });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      if (provider === 'codex') {
        const item = action.name ? { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`,
          name: action.name, ...(action.namespace === null ? {} : { namespace: action.namespace ?? 'mcp__swarm' }), arguments: JSON.stringify(action.args ?? {}) }
          : { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        emit('response.created', { response: { id: `resp_${n}`, object: 'response', status: 'in_progress', output: [] } });
        emit('response.output_item.added', { output_index: 0, item: { ...item, ...(action.name ? { arguments: '' } : { content: [] }) } });
        if (action.name) emit('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
        else {
          emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
          emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
        }
        emit('response.output_item.done', { output_index: 0, item });
        emit('response.completed', { response: { id: `resp_${n}`, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
      } else {
        emit('message_start', { message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
        emit('content_block_start', { index: 0, content_block: action.name
          ? { type: 'tool_use', id: `call_${n}`, name: action.name, input: {} } : { type: 'text', text: '' } });
        emit('content_block_delta', { index: 0, delta: action.name
          ? { type: 'input_json_delta', partial_json: JSON.stringify(action.args ?? {}) } : { type: 'text_delta', text } });
        emit('content_block_stop', { index: 0 });
        emit('message_delta', { delta: { stop_reason: action.name ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
        emit('message_stop', {});
      }
      res.end();
    } catch (error) { errors.push(error); res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  function install(provider, { codexConfig = [] } = {}) {
    const filename = path.join(directory, `${provider}-real.mjs`);
    const auditFile = path.join(directory, `${provider}-events.jsonl`);
    const argsFile = path.join(directory, `${provider}-args.jsonl`);
    fs.writeFileSync(filename, `#!${process.execPath}
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2), provider = ${JSON.stringify(provider)};
if (args[0] === 'login' || args[0] === 'auth') {
  console.log(provider === 'codex' ? 'Logged in using ChatGPT' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
  process.exit(0);
}
// Catalog control requests require a real subscription account. Stub only that
// account metadata, just like auth status, without starting model inference.
if (provider === 'claude' && !args.includes('--json-schema')) {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    const response = request.request.subtype === 'initialize'
      ? { account: { subscriptionType: 'max', apiProvider: 'firstParty' }, models: [{ value: 'default', displayName: 'Fixture', supportsEffort: false }] } : {};
    console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response } }));
  }
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args.map((arg, i) => arg.startsWith('mcp_servers=') || args[i - 1] === '--mcp-config' ? arg.replace(/Bearer [a-f0-9]+/g, 'Bearer [fixture]') : arg)) + '\\n');
const env = { ...process.env };
if (provider === 'codex') args.splice(args.length - 1, 0, '-c', ${JSON.stringify(`model_providers.fixture={name="Local fixture",base_url="${url}/v1",wire_api="responses",requires_openai_auth=false}`)}, '-c', 'model_provider="fixture"', '-c', 'model="gpt-5.4"', ...${JSON.stringify(codexConfig.flatMap(c => ['-c', c]))});
else Object.assign(env, { ANTHROPIC_BASE_URL: ${JSON.stringify(url)}, ANTHROPIC_AUTH_TOKEN: 'offline-fixture', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
const child = spawn(${JSON.stringify(officialExecutable(provider))}, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.stdout.on('data', data => { fs.appendFileSync(${JSON.stringify(auditFile)}, data); process.stdout.write(data); });
child.stderr.on('data', data => { fs.appendFileSync(${JSON.stringify(auditFile + '.stderr')}, data); process.stderr.write(data); });
child.on('exit', code => process.exit(code ?? 1));
`, { mode: 0o700 });
    return filename;
  }
  const read = filename => fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { unparsed: line }; } }) : [];
  return { requests, errors, install, events: provider => read(path.join(directory, `${provider}-events.jsonl`)), args: provider => read(path.join(directory, `${provider}-args.jsonl`)),
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); } };
}

export function modelTools(provider, body) {
  return provider === 'codex' ? body.tools.find(t => t.type === 'namespace' && t.name === 'mcp__swarm')?.tools ?? []
    : body.tools.filter(t => t.name.startsWith('mcp__swarm__')).map(t => ({ ...t, name: t.name.slice('mcp__swarm__'.length) }));
}

export function modelOutputs(provider, body) {
  return provider === 'codex' ? body.input.filter(i => i.type === 'function_call_output').map(i => i.output)
    : body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === 'tool_result').map(c => c.content) : []);
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkProviders, runGeneration, startBridge } from '../companion/cli-bridge.mjs';

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
const request = (provider = 'codex', extra = {}) => ({ provider, prompt: 'Return the requested JSON. $(never execute this)', schema, timeoutMs: 4000, ...extra });
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(work: () => unknown | Promise<unknown>, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await work()) return; await delay(10); }
  throw new Error('Timed out waiting for test condition');
}

async function fixture(t: any, provider = 'codex', config: any = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-cli-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, `${provider} fixture.mjs`), auditFile = join(root, 'audit.jsonl');
  const defaultAuth = provider === 'codex' ? 'Logged in using ChatGPT\n' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: 'private@example.test', token: 'auth-secret-sentinel' });
  const source = `#!${process.execPath}
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2), cwd = process.cwd();
const audit = (data) => fs.appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify(data) + '\\n');
const probe = args[0] === 'login' || args[0] === 'auth';
if (probe) {
  audit({ kind: 'auth', args, cwd, files: fs.readdirSync(cwd), env: process.env });
  ${config.authSource ?? `process.${provider === 'codex' ? 'stderr' : 'stdout'}.write(${JSON.stringify(config.auth ?? defaultAuth)}); process.exit(${config.authCode ?? 0});`}
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  audit({ kind: 'generate', args, cwd, files: fs.readdirSync(cwd), env: process.env, input,
    schema: args.includes('--output-schema') ? fs.readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8') : null,
    images: args.flatMap((arg, i) => arg === '--image' ? [fs.readFileSync(args[i + 1]).toString('base64')] : []) });
  ${config.generate ?? (provider === 'codex'
    ? `fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], '{"answer":"done"}'); console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,cached_input_tokens:12,output_tokens:4}}));`
    : `const result = {type:'result',subtype:'success',is_error:false,result:'not the preferred field',structured_output:{answer:'done'},usage:{input_tokens:5,cache_creation_input_tokens:3,cache_read_input_tokens:10,output_tokens:7}}; if(args.includes('stream-json')) console.log(JSON.stringify({type:'system',subtype:'init'})); console.log(JSON.stringify(result));`)}
}
`;
  await writeFile(executable, source, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH!, HOME: join(root, 'user-home'), CODEX_HOME: join(root, 'codex-home'), CLAUDE_CONFIG_DIR: join(root, 'claude-home'),
    OPENAI_API_KEY: 'do-not-pass', CODEX_API_KEY: 'do-not-pass', ANTHROPIC_API_KEY: 'do-not-pass', ANTHROPIC_AUTH_TOKEN: 'do-not-pass', CLAUDE_CODE_OAUTH_TOKEN: 'do-not-pass',
    OPENAI_BASE_URL: 'https://untrusted.test', ANTHROPIC_BASE_URL: 'https://untrusted.test', CODEX_MODEL_PROVIDER: 'third-party', CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_PROFILE: 'console', AWS_PROFILE: 'console', GOOGLE_APPLICATION_CREDENTIALS: '/private/key.json', HTTPS_PROXY: 'https://untrusted.test',
    NODE_OPTIONS: '--definitely-not-a-node-option', BASH_ENV: '/untrusted/startup', CLAUDE_CODE_SIMPLE: '1',
  };
  const options = { [`${provider}Path`]: executable, env };
  const audit = async () => (await readFile(auditFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  return { root, executable, auditFile, options, audit };
}

test('status recognizes only official auth and never exposes auth diagnostics', async (t) => {
  for (const [provider, auth, expected] of [
    ['codex', 'Logged in using ChatGPT\n', true],
    ['codex', 'Logged in using an API key - auth-secret-sentinel\n', false],
    ['codex', 'Not logged in. Please use ChatGPT.\n', false],
    ['codex', 'Logged in using ChatGPT via an unknown proxy\n', false],
    ['codex', 'Logged in using ChatGPT\nAPI key: auth-secret-sentinel', false],
    ['claude', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }), false],
    ...['pro', 'max', 'ultra', 'team', 'enterprise'].map((subscriptionType) => ['claude', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType }), true]),
    ...[null, 'free', 'console', 'unknown', ''].map((subscriptionType) => ['claude', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType }), false]),
    ...['api_key', 'api_key_helper', 'oauth_token', 'third_party', 'none', 'unknown'].map((authMethod) => ['claude', JSON.stringify({ loggedIn: true, authMethod, token: 'auth-secret-sentinel' }), false]),
    ['claude', JSON.stringify({ loggedIn: false, authMethod: 'claude.ai' }), false],
    ['claude', JSON.stringify({ loggedIn: 'true', authMethod: 'claude.ai' }), false],
    ['claude', 'invalid auth-secret-sentinel JSON', false],
  ] as const) {
    const f = await fixture(t, provider, { auth });
    const result = await checkProviders({ codexPath: '/missing/swarm-codex', claudePath: '/missing/swarm-claude', ...f.options });
    assert.equal(result[provider].installed, true);
    assert.equal(result[provider].subscription, expected, `${provider}: ${auth}`);
    if (provider === 'claude' && !expected) assert.match(result[provider].error, /Update the official Claude CLI and sign in with a subscription account/);
    assert.doesNotMatch(JSON.stringify(result), /auth-secret-sentinel|private@example/);
    assert.deepEqual((await f.audit())[0].files, [], 'auth runs in an empty temporary cwd');
  }
});

test('missing executables and nonzero auth fail closed before generation', async (t) => {
  const missing = await checkProviders({ codexPath: '/does-not-exist/codex', claudePath: '/does-not-exist/claude' });
  for (const status of Object.values(missing)) assert.deepEqual(status, { installed: false, authenticated: false, subscription: false, error: 'CLI executable is not installed.' });
  const f = await fixture(t, 'codex', { auth: 'Logged in using ChatGPT\n', authCode: 1 });
  await assert.rejects(runGeneration(request(), f.options), /official ChatGPT subscription login/);
  assert.equal((await f.audit()).length, 1);
  for (const subscriptionType of [undefined, null, 'unknown']) {
    const api = await fixture(t, 'claude', { auth: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType }) });
    await assert.rejects(runGeneration(request('claude'), api.options), /official claude.ai subscription login/);
    assert.equal((await api.audit()).length, 1);
  }
});

for (const provider of ['codex', 'claude']) test(`${provider}: provider policy refusals stay refused and expose only a safe explanation`, async t => {
  const f = await fixture(t, provider, { generate: `console.error('Invalid prompt: your prompt was flagged as potentially violating our usage policy. auth-secret-sentinel private@example.test'); process.exit(1);` });
  await assert.rejects(runGeneration(request(provider), f.options), (error: any) => {
    assert.equal(error.code, 'policy');
    assert.match(error.message, /declined this request under its usage policy/);
    assert.match(error.message, /No API fallback was used/);
    assert.doesNotMatch(error.message, /auth-secret-sentinel|private@example/);
    return true;
  });
  assert.equal((await f.audit()).filter(event => event.kind === 'generate').length, 1, 'a policy refusal is never automatically retried');
});

test('Codex preserves credential locations, strips overrides, isolates tools and normalizes usage', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await runGeneration(request(), f.options), { text: '{"answer":"done"}', usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 12 } } });
  const events = await f.audit(), call = events[1];
  assert.deepEqual(events.map((event) => event.kind), ['auth', 'generate']);
  assert.equal(call.input, request().prompt);
  assert.equal(call.args.includes(request().prompt), false);
  assert.equal(call.args.at(-1), '-');
  for (const arg of ['--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', 'read-only', 'forced_login_method="chatgpt"', 'model_provider="openai"', 'features.shell_tool=false', 'features.hooks=false', 'features.apps=false', 'features.plugins=false', 'features.multi_agent=false', 'features.computer_use=false', 'features.browser_use=false', 'web_search="disabled"', 'mcp_servers={}']) assert.ok(call.args.includes(arg), arg);
  assert.deepEqual(JSON.parse(call.schema), schema);
  for (const event of events) {
    assert.equal(event.env.HOME, f.options.env.HOME);
    assert.equal(event.env.CODEX_HOME, f.options.env.CODEX_HOME);
    assert.equal(event.env.CLAUDE_CONFIG_DIR, f.options.env.CLAUDE_CONFIG_DIR);
    assert.doesNotMatch(JSON.stringify(event.env), /do-not-pass|untrusted|third-party|console|private\/key/);
    assert.equal(event.env.NODE_OPTIONS, undefined);
    assert.equal(event.env.BASH_ENV, undefined);
  }
  await assert.rejects(stat(call.cwd), { code: 'ENOENT' });
  await runGeneration(request(), f.options);
  assert.deepEqual((await f.audit()).map((event) => event.kind), ['auth', 'generate', 'auth', 'generate'], 'auth is checked before every generation');
});

test('images are local Codex attachments and Claude stream messages; structured output wins', async (t) => {
  const images = [{ mediaType: 'image/png', data: Buffer.from('test image bytes').toString('base64') }];
  for (const provider of ['codex', 'claude']) {
    const f = await fixture(t, provider);
    const result = await runGeneration(request(provider, { images }), f.options);
    assert.deepEqual(JSON.parse(result.text), { answer: 'done' });
    const call = (await f.audit())[1];
    if (provider === 'codex') assert.deepEqual(call.images, [images[0].data]);
    else {
      assert.deepEqual(JSON.parse(call.input).message.content, [{ type: 'text', text: request().prompt }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: images[0].data } }]);
      assert.ok(call.args.includes('--verbose'));
      assert.equal(call.args[call.args.indexOf('--output-format') + 1], 'stream-json');
      assert.deepEqual(result.usage, { input_tokens: 18, output_tokens: 7, input_tokens_details: { cached_tokens: 10 } });
      for (const flag of ['--tools', '--setting-sources']) assert.equal(call.args[call.args.indexOf(flag) + 1], '');
      for (const flag of ['--strict-mcp-config', '--no-session-persistence', '--safe-mode', '--disable-slash-commands', 'dontAsk', '{"mcpServers":{}}']) assert.ok(call.args.includes(flag));
    }
    await assert.rejects(stat(call.cwd), { code: 'ENOENT' });
  }
  const f = await fixture(t, 'claude');
  await runGeneration(request('claude'), f.options);
  const call = (await f.audit())[1];
  assert.equal(call.input, request().prompt);
  assert.equal(call.args[call.args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(call.args.includes('--verbose'));
  assert.match(call.args[call.args.indexOf('--system-prompt') + 1], /not native CLI tools/);
});

const actionNames = ['SWARM_APPS_SEARCH', 'SWARM_APPS_EXECUTE'];
const actionSchema = { type: 'object', additionalProperties: false, required: ['text', 'tool_calls'], properties: {
  text: { type: 'string' }, tool_calls: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false,
    required: ['name', 'arguments'], properties: { name: { type: 'string', enum: actionNames }, arguments: { type: 'string' } } } },
} };
const actionEvent = (content: any[]) => ({ type: 'assistant', message: { role: 'assistant', model: 'claude-test', content,
  usage: { input_tokens: 5, cache_creation_input_tokens: 3, cache_read_input_tokens: 10, output_tokens: 7 } } });
const searchAction = { type: 'tool_use', id: 'native-1', name: 'SWARM_APPS_SEARCH', input: { toolkit: 'github', query: 'verify accès 🐝' } };
const finalEvent = { type: 'result', subtype: 'success', structured_output: { text: 'Final reply', tool_calls: [] } };

test('Claude hands native app actions back before the CLI can loop on missing tools', async t => {
  const event = actionEvent([{ type: 'text', text: 'I already verified GitHub. This claim must not be forwarded.' }, searchAction]);
  const f = await fixture(t, 'claude', { generate: `
    console.log(${JSON.stringify(JSON.stringify(event))});
    setTimeout(() => { audit({kind:'missing-tool-loop'}); console.log('No such tool available: SWARM_APPS_SEARCH'); }, 5000);
  ` });
  const result = await runGeneration(request('claude', { schema: actionSchema, actionNames, timeoutMs: 3000 }), f.options);
  assert.deepEqual(JSON.parse(result.text), { text: '', tool_calls: [{ name: searchAction.name, arguments: JSON.stringify(searchAction.input) }] });
  assert.equal(result.model, 'claude-test');
  assert.deepEqual(result.usage, { input_tokens: 18, output_tokens: 7, input_tokens_details: { cached_tokens: 10 } });
  const calls = await f.audit();
  assert.deepEqual(calls.map(call => call.kind), ['auth', 'generate']);
  assert.equal(calls[1].args[calls[1].args.indexOf('--tools') + 1], '', 'native execution remains disabled');
  await assert.rejects(stat(calls[1].cwd), { code: 'ENOENT' });
});

test('Claude waits for complete JSON events, decodes split Unicode, and preserves a batch in order', async t => {
  const second = { type: 'tool_use', name: 'SWARM_APPS_EXECUTE', input: { tool_slug: 'GITHUB_GET_USER', arguments: {} } };
  const event = actionEvent([searchAction, second]);
  const f = await fixture(t, 'claude', { generate: `
    const data = Buffer.from(${JSON.stringify(JSON.stringify(event) + '\n')});
    const split = data.indexOf(Buffer.from('🐝')) + 1;
    process.stdout.write(data.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 30));
    audit({kind:'partial-event-survived'});
    process.stdout.write(data.subarray(split, -1));
    await new Promise(resolve => setTimeout(resolve, 30));
    audit({kind:'newline-still-required'});
    process.stdout.write(data.subarray(-1));
    setInterval(() => {}, 1000);
  ` });
  const result = await runGeneration(request('claude', { schema: actionSchema, actionNames }), f.options);
  assert.deepEqual(JSON.parse(result.text), { text: '', tool_calls: [searchAction, second].map(call => ({ name: call.name, arguments: JSON.stringify(call.input) })) });
  assert.deepEqual((await f.audit()).map(call => call.kind), ['auth', 'generate', 'partial-event-survived', 'newline-still-required']);
});

test('Claude never intercepts unknown tools, malformed arguments, error messages or partial/spoofed events', async t => {
  const events = [
    actionEvent([{ ...searchAction, name: 'Bash' }]),
    actionEvent([searchAction, { ...searchAction, name: 'Bash' }]),
    ...[null, [], 'unfinished', 42].map(input => actionEvent([{ ...searchAction, input }])),
    { ...actionEvent([searchAction]), error: 'permission_denied' },
    { ...actionEvent([searchAction]), type: 'user' },
    { type: 'stream_event', event: { type: 'content_block_start', content_block: searchAction } },
    { type: 'assistant', message: { role: 'user', content: [searchAction] } },
    actionEvent([{ type: 'text', text: JSON.stringify(searchAction) }]),
    actionEvent(Array.from({ length: 33 }, () => searchAction)),
  ];
  for (const event of events) {
    const f = await fixture(t, 'claude', { generate: `console.log(${JSON.stringify(JSON.stringify(event))}); console.log(${JSON.stringify(JSON.stringify(finalEvent))});` });
    const result = await runGeneration(request('claude', { schema: actionSchema, actionNames }), f.options);
    assert.deepEqual(JSON.parse(result.text), finalEvent.structured_output);
  }
  const f = await fixture(t, 'claude', { generate: `process.stdout.write(${JSON.stringify(JSON.stringify(actionEvent([searchAction])).slice(0, -2))});` });
  await assert.rejects(runGeneration(request('claude', { schema: actionSchema, actionNames }), f.options), /malformed JSON/);
});

test('native action capture requires both an explicit manifest and a matching output schema', async t => {
  for (const extra of [{ schema: actionSchema }, { schema: actionSchema, actionNames: [] }, { schema, actionNames }]) {
    const f = await fixture(t, 'claude', { generate: `console.log(${JSON.stringify(JSON.stringify(actionEvent([searchAction])))}); console.log(${JSON.stringify(JSON.stringify(finalEvent))});` });
    const result = await runGeneration(request('claude', extra), f.options);
    assert.deepEqual(JSON.parse(result.text), finalEvent.structured_output);
  }
});

test('oversized native arguments fail without returning a partial action', async t => {
  const f = await fixture(t, 'claude', { generate: `console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',name:'SWARM_APPS_SEARCH',input:{query:'x'.repeat(1_000_001)}}]}}));` });
  await assert.rejects(runGeneration(request('claude', { schema: actionSchema, actionNames }), f.options), /Invalid CLI action event/);
});

test('action capture kills descendants and cancellation during shutdown still wins', async t => {
  for (const cancel of [false, true]) {
    const f = await fixture(t, 'claude', { generate: `
      process.on('SIGTERM', () => { audit({kind:'stopping'}); });
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {stdio:'ignore'});
      child.once('spawn', () => { audit({kind:'child',pid:child.pid}); console.log(${JSON.stringify(JSON.stringify(actionEvent([searchAction])))}); });
      setInterval(()=>{},1000);
    ` });
    const controller = new AbortController();
    const pending = runGeneration(request('claude', { schema: actionSchema, actionNames }), { ...f.options, signal: controller.signal });
    const rejection = cancel ? assert.rejects(pending, /cancelled/) : undefined;
    if (cancel) {
      await until(async () => { try { return (await f.audit()).some(call => call.kind === 'stopping'); } catch { return false; } });
      controller.abort();
      await rejection;
    } else assert.equal(JSON.parse((await pending).text).tool_calls.length, 1);
    const calls = await f.audit();
    const child = calls.find(call => call.kind === 'child');
    assert.ok(child);
    // Linux may retain a dead, reparented process as a zombie briefly.
    await until(async () => {
      try { process.kill(child.pid, 0); } catch { return true; }
      if (process.platform === 'linux') return (await readFile(`/proc/${child.pid}/stat`, 'utf8').catch(() => '')).includes(') Z');
      return false;
    });
    await assert.rejects(stat(calls[1].cwd), { code: 'ENOENT' });
  }
});

test('malformed output, failed turns, auth failures, limits and nonzero exits are sanitized', async (t) => {
  for (const [provider, generate, pattern] of [
    ['codex', `console.error('secret auth-secret-sentinel rate limit 429'); process.exit(7);`, /subscription rate limit/],
    ['claude', `console.log(JSON.stringify({type:'result',is_error:true,result:'token expired auth-secret-sentinel'}));`, /authentication failed/],
    ['claude', `console.log(JSON.stringify({type:'result',subtype:'error_max_turns',result:'auth-secret-sentinel'}));`, /generation failed/],
    ['codex', `console.log(JSON.stringify({type:'turn.failed',error:{message:'auth-secret-sentinel'}}));`, /generation failed/],
    ['codex', `console.log('not-json auth-secret-sentinel');`, /malformed JSON events/],
    ['codex', `console.log(JSON.stringify({type:'thread.started'}));`, /no completed generation/],
    ['codex', `console.log(JSON.stringify({type:'turn.completed'}));`, /structured output file/],
    ['claude', `console.log('');`, /malformed JSON/],
    ['claude', `console.log(JSON.stringify({type:'result',structured_output:undefined,result:''}));`, /empty structured output/],
    ['claude', `console.log(JSON.stringify({type:'result',result:'not json auth-secret-sentinel'}));`, /malformed structured output/],
    ['claude', `console.log(JSON.stringify({type:'system',subtype:'init'}));`, /malformed JSON/],
    ['claude', `for(let i=0;i<2;i++) console.log(JSON.stringify({type:'result',structured_output:{answer:'duplicate'}}));`, /malformed JSON/],
    ['claude', `console.error('unknown option auth-secret-sentinel'); process.exit(1);`, /Update the official CLI/],
    ['claude', `console.error('arbitrary auth-secret-sentinel diagnostic'); process.exit(1);`, /exited unsuccessfully/],
  ] as const) {
    const f = await fixture(t, provider, { generate });
    await assert.rejects(runGeneration(request(provider), f.options), (error: Error) => { assert.match(error.message, pattern); assert.doesNotMatch(error.message, /auth-secret-sentinel/); return true; });
    for (const call of await f.audit()) await assert.rejects(stat(call.cwd), { code: 'ENOENT' });
  }
});

test('output caps cover stderr, stdout and the Codex final file', async (t) => {
  for (const [provider, generate] of [
    ['claude', `process.stdout.write('x'.repeat(8*1024*1024+1));`],
    ['codex', `process.stderr.write('x'.repeat(8*1024*1024+1));`],
    ['codex', `fs.writeFileSync(args[args.indexOf('--output-last-message')+1], 'x'.repeat(8*1024*1024+1)); console.log(JSON.stringify({type:'turn.completed'}));`],
  ]) {
    const f = await fixture(t, provider, { generate });
    await assert.rejects(runGeneration(request(provider), f.options), /8 MB limit/);
    await assert.rejects(stat((await f.audit())[1].cwd), { code: 'ENOENT' });
  }
});

test('timeout and AbortSignal kill the process tree and clean temporary files', async (t) => {
  for (const byAbort of [false, true]) {
    const f = await fixture(t, 'codex', { generate: `
      process.on('SIGTERM',()=>{});
      spawn(process.execPath, ['-e', "const fs=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync(" + JSON.stringify(${JSON.stringify(join(tmpdir(), 'unused'))}) + ",'x'),20)"], {stdio:'ignore'});
      setInterval(()=>{},1000);
    ` });
    // Give the descendant a test-owned heartbeat outside the temporary cwd.
    const beat = join(f.root, 'descendant-heartbeat');
    let code = await readFile(f.executable, 'utf8');
    code = code.replace(JSON.stringify(join(tmpdir(), 'unused')), JSON.stringify(beat));
    await writeFile(f.executable, code);
    const controller = new AbortController();
    const promise = runGeneration(request('codex', { timeoutMs: byAbort ? 4000 : 500 }), { ...f.options, signal: controller.signal });
    const rejection = assert.rejects(promise, byAbort ? /cancelled/ : /timed out/);
    await until(async () => { try { return (await stat(beat)).size > 0; } catch { return false; } });
    if (byAbort) controller.abort(new Error('auth-secret-sentinel'));
    await rejection;
    const size = (await stat(beat)).size;
    await delay(100);
    assert.equal((await stat(beat)).size, size, 'grandchild stopped executing');
    await assert.rejects(stat((await f.audit())[1].cwd), { code: 'ENOENT' });
  }
});

test('aborting an auth probe terminates it, and pre-aborted signals spawn nothing', async (t) => {
  const f = await fixture(t, 'codex', { authSource: 'setInterval(()=>{},1000);' });
  const controller = new AbortController();
  const pending = runGeneration(request(), { ...f.options, signal: controller.signal });
  const rejection = assert.rejects(pending, /cancelled/);
  await until(async () => { try { return (await f.audit()).length === 1; } catch { return false; } });
  controller.abort(); await rejection;
  await assert.rejects(runGeneration(request(), { ...f.options, signal: controller.signal }), /cancelled/);
  assert.equal((await f.audit()).length, 1);
});

test('large prompt to an early-closing stdin fails without unhandled EPIPE', async (t) => {
  const f = await fixture(t, 'codex', { authSource: `if (!fs.existsSync(${JSON.stringify('/nonexistent-placeholder')})) { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0); }` });
  const code = await readFile(f.executable, 'utf8');
  await writeFile(f.executable, code.replace("} else {\n  let input = '';", "} else {\n  process.stdin.destroy(); process.exit(2);\n  let input = '';"));
  await assert.rejects(runGeneration(request('codex', { prompt: 'x'.repeat(6 * 1024 * 1024) }), f.options), /prompt input|exited unsuccessfully/);
});

test('invalid requests cannot select executables, paths, providers or unbounded input', async () => {
  for (const extra of [{ provider: 'bash' }, { provider: '__proto__' }, { prompt: '' }, { schema: [] }, { timeoutMs: NaN }, { timeoutMs: 900001 }, { images: [{ mediaType: '../../x', data: 'eA==' }] }, { images: [{ mediaType: 'image/png', data: '%%%%' }] }, { prompt: 'x'.repeat(8 * 1024 * 1024) }]) {
    await assert.rejects(runGeneration(request('codex', extra)));
  }
});

function mockWebSocket(onSend: (socket: any, message: any) => void) {
  const instances: any[] = [];
  class MockWebSocket extends EventTarget {
    readyState = 0;
    bufferedAmount = 0;
    sent: any[] = [];
    constructor(public url: string) { super(); instances.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    send(data: string) { const message = JSON.parse(data); this.sent.push(message); onSend(this, message); }
    receive(message: any) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
    disconnect(code = 1006) { if (this.readyState === 3) return; this.readyState = 3; const event = new Event('close'); Object.defineProperty(event, 'code', { value: code }); this.dispatchEvent(event); }
    close() { this.disconnect(1000); }
  }
  return { MockWebSocket, instances };
}

test('WebSocket hello, welcome, heartbeat, status and dispatch use only the fixed protocol', async (t) => {
  const codex = await fixture(t), claude = await fixture(t, 'claude');
  const controller = new AbortController(), logs: string[] = [];
  const { MockWebSocket, instances } = mockWebSocket((socket, message) => {
    if (message.type === 'hello') {
      socket.receive({ type: 'welcome' }); socket.receive({ type: 'welcome' }); socket.receive({ type: 'ping' });
      socket.receive({ id: 'bad', method: 'exec', params: { command: 'rm -rf /', codexPath: '/untrusted' } });
      socket.receive({ id: 'status', method: 'status' });
      socket.receive({ id: 'generate', method: 'generate', params: { ...request(), codexPath: '/untrusted' } });
    }
    if (socket.sent.some((m: any) => m.id === 'status' && m.result) && socket.sent.some((m: any) => m.id === 'generate' && m.result)) controller.abort();
  });
  await startBridge({ server: 'https://swarm.test/old?secret=discard', token: 'local-pair-token', WebSocketImpl: MockWebSocket, ...codex.options, claudePath: claude.executable, signal: controller.signal, log: (message: string) => logs.push(message) });
  const socket = instances[0];
  assert.equal(socket.url, 'wss://swarm.test/api/cli-bridge');
  assert.equal(socket.sent[0].type, 'hello'); assert.equal(socket.sent[0].version, 1); assert.ok(socket.sent[0].device);
  assert.equal(socket.sent[0].token, 'local-pair-token');
  assert.ok(socket.sent.some((m: any) => m.type === 'pong'));
  assert.match(socket.sent.find((m: any) => m.id === 'bad').error, /Unsupported/);
  assert.equal(socket.sent.find((m: any) => m.id === 'status').result.codex.subscription, true);
  assert.deepEqual(logs, ['Connected to Swarm CLI bridge.']);
  assert.doesNotMatch(JSON.stringify(socket.sent.slice(1)), /private@example|auth-secret-sentinel|local-pair-token/);
});

test('eight same-provider WebSocket generations overlap, cancel independently and preserve quota errors', async (t) => {
  const f = await fixture(t, 'codex', { generate: `
    const held = setInterval(() => {
      if (!fs.existsSync(cwd + '/release')) return;
      clearInterval(held);
      audit({ kind: 'finished', input });
      if (input === 'quota') {
        process.stderr.write('429 subscription quota exceeded auth-secret-sentinel');
        process.exit(1);
      }
      fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ answer: input }));
      console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } }));
    }, 10);
  ` });
  const fallback = await fixture(t, 'claude', { generate: "throw new Error('Unexpected provider fallback');" });
  const controller = new AbortController();
  const prompts = ['cancel-me', 'quota', ...Array.from({ length: 6 }, (_, i) => `held-${i}`)];
  const { MockWebSocket, instances } = mockWebSocket((socket, message) => {
    if (message.type === 'hello') for (const prompt of prompts) {
      socket.receive({ id: prompt, method: 'generate', params: request('codex', { prompt, timeoutMs: 15000 }) });
    }
  });
  const bridge = startBridge({ server: 'ws://swarm.test', token: 'token', ...f.options, claudePath: fallback.executable, WebSocketImpl: MockWebSocket, signal: controller.signal });
  try {
    await until(async () => {
      try { return (await f.audit()).filter((event) => event.kind === 'generate').length === prompts.length; }
      catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
    }, 5000);
    const socket = instances[0], calls = await f.audit();
    const started = calls.filter((event) => event.kind === 'generate');
    const replies = () => socket.sent.filter((message: any) => typeof message.id === 'string');
    assert.equal(started.length, 8, 'all eight processes started while every release gate was closed');
    assert.equal(calls.filter((event) => event.kind === 'auth').length, 8, 'each overlapping job rechecks subscription auth');
    assert.equal(calls.some((event) => event.kind === 'finished'), false, 'none finished before all eight started');
    assert.deepEqual(replies(), [], 'overlapping jobs receive no capacity/busy response');
    for (const call of started) {
      assert.ok(call.args.includes('forced_login_method="chatgpt"'));
      assert.ok(call.args.includes('model_provider="openai"'));
      assert.doesNotMatch(JSON.stringify(call.env), /do-not-pass|untrusted|third-party|console/);
    }

    socket.receive({ id: 'cancel-me', method: 'cancel' });
    await until(() => replies().length === 1);
    assert.equal(replies()[0].id, 'cancel-me');
    assert.match(replies()[0].error, /cancelled/);
    const cancelledCall = started.find((call) => call.input === 'cancel-me');
    await assert.rejects(stat(cancelledCall.cwd), { code: 'ENOENT' });
    for (const call of started.filter((event) => event.input !== 'cancel-me')) await stat(call.cwd);
    assert.equal((await f.audit()).some((event) => event.kind === 'finished'), false, 'cancelling one did not finish or stop its peers');

    const quotaCall = started.find((call) => call.input === 'quota');
    await writeFile(join(quotaCall.cwd, 'release'), '');
    await until(() => replies().length === 2);
    const quota = replies().find((message: any) => message.id === 'quota');
    assert.match(quota.error, /subscription rate limit/);
    assert.equal(Object.hasOwn(quota, 'result'), false);
    assert.doesNotMatch(quota.error, /auth-secret-sentinel/);
    await assert.rejects(stat(fallback.auditFile), { code: 'ENOENT' });

    const successful = started.filter((call) => !['cancel-me', 'quota'].includes(call.input));
    for (const call of successful) await stat(call.cwd);
    await Promise.all(successful.map((call) => writeFile(join(call.cwd, 'release'), '')));
    await until(() => replies().length === 8);
    for (const call of successful) {
      const reply = replies().find((message: any) => message.id === call.input);
      assert.equal(Object.hasOwn(reply, 'error'), false);
      assert.deepEqual(JSON.parse(reply.result.text), { answer: call.input });
    }
    assert.equal((await f.audit()).filter((event) => event.kind === 'generate').length, 8, 'quota failure neither retries nor falls back');
    await assert.rejects(stat(fallback.auditFile), { code: 'ENOENT' });
    for (const call of started) await assert.rejects(stat(call.cwd), { code: 'ENOENT' });
  } finally { controller.abort(); await bridge; }
});

test('terminal WebSocket close codes stop retries with sanitized repair instructions', async () => {
  for (const code of [4400, 4401, 4403, 4409]) {
    const { MockWebSocket, instances } = mockWebSocket((socket) => queueMicrotask(() => socket.disconnect(code)));
    await assert.rejects(startBridge({ server: 'http://swarm.test', token: 'secret-token', WebSocketImpl: MockWebSocket }), (error: Error) => { assert.match(error.message, /pair|Pair/); assert.doesNotMatch(error.message, /secret-token/); return true; });
    assert.equal(instances.length, 1);
  }
});

test('cancel and disconnect abort active children without leaking replies into another connection', async (t) => {
  for (const disconnect of [false, true]) {
    const f = await fixture(t, 'codex', { generate: 'setInterval(()=>{},1000);' });
    const controller = new AbortController();
    const { MockWebSocket, instances } = mockWebSocket((socket, message) => {
      if (message.type === 'hello') socket.receive({ id: 'active', method: 'generate', params: request() });
      if (message.id === 'active' && message.error) controller.abort();
    });
    const bridge = startBridge({ server: 'ws://swarm.test', token: 'token', ...f.options, WebSocketImpl: MockWebSocket, signal: controller.signal });
    await until(async () => { try { return (await f.audit()).some((event) => event.kind === 'generate'); } catch { return false; } });
    if (disconnect) { instances[0].disconnect(); controller.abort(); }
    else instances[0].receive({ id: 'active', method: 'cancel' });
    await bridge;
    if (disconnect) assert.equal(instances[0].sent.length, 1);
    else assert.match(instances[0].sent.find((m: any) => m.id === 'active').error, /cancelled/);
    await assert.rejects(stat((await f.audit())[1].cwd), { code: 'ENOENT' });
  }
});

test('ordinary WebSocket disconnect reconnects after bounded backoff and abort interrupts waiting', async () => {
  const controller = new AbortController();
  const { MockWebSocket, instances } = mockWebSocket((socket) => {
    if (instances.length === 1) queueMicrotask(() => socket.disconnect());
    else controller.abort();
  });
  const started = Date.now();
  await startBridge({ server: 'http://swarm.test', token: 'token', WebSocketImpl: MockWebSocket, signal: controller.signal });
  assert.equal(instances.length, 2);
  assert.ok(Date.now() - started >= 350);
});

test('native global WebSocket answers control ping and carries an offline generation', async (t) => {
  const f = await fixture(t), server = createServer();
  let pong = false, response: any, hello: any;
  const sockets = new Set<any>();
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const frame = (opcode: number, payload: Buffer | string) => {
    const bytes = Buffer.from(payload);
    const header = bytes.length < 126 ? Buffer.from([0x80 | opcode, bytes.length]) : Buffer.from([0x80 | opcode, 126, bytes.length >> 8, bytes.length & 255]);
    return Buffer.concat([header, bytes]);
  };
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('error', () => {});
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let pending = Buffer.alloc(0);
    socket.on('data', (data) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 2) {
        const opcode = pending[0] & 15, masked = Boolean(pending[1] & 128);
        let size = pending[1] & 127, offset = 2;
        if (size === 126) { if (pending.length < 4) return; size = pending.readUInt16BE(2); offset = 4; }
        assert.notEqual(size, 127, 'test only sends small frames');
        if (pending.length < offset + (masked ? 4 : 0) + size) return;
        const mask = pending.subarray(offset, offset + 4);
        if (masked) offset += 4;
        const payload = Buffer.from(pending.subarray(offset, offset + size));
        if (masked) for (let index = 0; index < size; index++) payload[index] ^= mask[index % 4];
        pending = pending.subarray(offset + size);
        if (opcode === 10) { pong = payload.toString() === 'heartbeat'; continue; }
        if (opcode === 8) { socket.end(frame(8, payload)); continue; }
        if (opcode !== 1) continue;
        const message = JSON.parse(payload.toString());
        if (message.type === 'hello') {
          hello = message;
          socket.write(frame(9, 'heartbeat'));
          socket.write(frame(1, JSON.stringify({ type: 'welcome' })));
          socket.write(frame(1, JSON.stringify({ id: 'native-generation', method: 'generate', params: request() })));
        } else if (message.id === 'native-generation') {
          response = message;
          socket.write(frame(8, Buffer.from([4403 >> 8, 4403 & 255])));
        }
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  await assert.rejects(startBridge({ server: `http://127.0.0.1:${address.port}`, token: 'native-test-token', ...f.options }), /pairing is invalid or revoked/);
  assert.equal(hello.token, 'native-test-token');
  assert.equal(pong, true, 'Node automatically answers WebSocket control-frame ping');
  assert.deepEqual(JSON.parse(response.result.text), { answer: 'done' });
});

test('standalone module imports without starting a connection', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../companion/cli-bridge.mjs', import.meta.url).href)}); console.log('imported');`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; });
  const exit = await new Promise((done) => child.once('close', done));
  assert.equal(exit, 0); assert.equal(output.trim(), 'imported');
});

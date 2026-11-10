import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkProviders, runGeneration, startLogin } from '../companion/cli-bridge.mjs';

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(condition: () => unknown | Promise<unknown>, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await condition()) return; await delay(10); }
  throw new Error('Timed out waiting for fake login terminal');
}

async function fixture(t: any, source?: string) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-login-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, 'fake login cli.mjs'), audit = join(root, 'audit.json'), home = join(root, 'user');
  for (const path of [home, join(home, '.codex'), join(home, '.claude')]) await mkdir(path, { mode: 0o700 });
  const code = `#!${process.execPath}
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
const auditFile = ${JSON.stringify(audit)}, testRoot = ${JSON.stringify(root)};
const meta = { args:process.argv.slice(2), cwd:process.cwd(), files:fs.readdirSync(process.cwd()), env:process.env, stdinTTY:!!process.stdin.isTTY, stdoutTTY:!!process.stdout.isTTY, stderrTTY:!!process.stderr.isTTY, size:process.stdout.getWindowSize?.() };
fs.writeFileSync(auditFile,JSON.stringify(meta));
${source ?? `
process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.write('READY\\r\\n');
process.on('SIGWINCH',()=>process.stdout.write('SIZE:'+process.stdout.getWindowSize().join('x')+'\\r\\n'));
let input='';
process.stdin.on('data',(chunk)=>{
 input+=chunk.toString();
 if(input.endsWith('\\n')) {process.stdout.write('RECEIVED:'+input); process.exit(0);}
});
`}`;
  await writeFile(cli, code, { mode: 0o700 });
  const env = {
    PATH: process.env.PATH!, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), LANG: 'C.UTF-8',
    OPENAI_API_KEY: 'api-secret', CODEX_API_KEY: 'api-secret', ANTHROPIC_API_KEY: 'api-secret', ANTHROPIC_AUTH_TOKEN: 'api-secret', CLAUDE_CODE_OAUTH_TOKEN: 'api-secret',
    OPENAI_BASE_URL: 'https://untrusted.test', ANTHROPIC_BASE_URL: 'https://untrusted.test', ANTHROPIC_PROFILE: 'console', AWS_PROFILE: 'console',
    CLAUDE_CODE_USE_BEDROCK: '1', CODEX_MODEL_PROVIDER: 'third-party', HTTPS_PROXY: 'https://untrusted.test', NODE_OPTIONS: '--not-a-valid-node-option',
    BROWSER: 'untrusted-browser', NO_COLOR: '1', TERM: 'dumb', BASH_ENV: '/untrusted', PYTHONPATH: '/untrusted',
  };
  let output = '';
  const options = { codexPath: cli, claudePath: cli, env, timeoutMs: 5000, onData: (data: string) => { output += data; } };
  return { root, cli, audit, home, options, output: () => output, meta: async () => JSON.parse(await readFile(audit, 'utf8')) };
}

test('fixed subscription login commands use real TTYs, private empty cwd and isolated credentials', async (t) => {
  for (const provider of ['codex', 'claude']) {
    const f = await fixture(t), handle = await startLogin(provider, f.options);
    await until(() => f.output().includes('READY'));
    const meta = await f.meta();
    assert.equal(meta.stdinTTY, true); assert.equal(meta.stdoutTTY, true); assert.equal(meta.stderrTTY, true);
    assert.deepEqual(meta.files, []);
    assert.deepEqual(meta.size, [80, 24]);
    assert.deepEqual(meta.args, provider === 'codex' ? ['login', '--device-auth', '-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"'] : ['auth', 'login', '--claudeai']);
    assert.equal(meta.env.HOME, f.home); assert.equal(meta.env.CODEX_HOME, join(f.home, '.codex')); assert.equal(meta.env.CLAUDE_CONFIG_DIR, join(f.home, '.claude'));
    assert.equal(meta.env.TERM, 'xterm-256color'); assert.equal(meta.env.NO_COLOR, undefined); assert.equal(meta.env.FORCE_COLOR, '1');
    assert.doesNotMatch(JSON.stringify(meta.env), /api-secret|untrusted|third-party|console/);
    assert.equal(meta.env.NODE_OPTIONS, undefined); assert.equal(meta.env.PYTHONPATH, undefined);
    handle.write('keyboard-code-123\n');
    assert.deepEqual(await handle.done, { exitCode: 0 });
    assert.match(f.output(), /RECEIVED:keyboard-code-123/);
    await assert.rejects(stat(meta.cwd), { code: 'ENOENT' });
    await assert.rejects(stat(meta.env.BROWSER), { code: 'ENOENT' });
    assert.throws(() => handle.write('after-exit'), /closed/);
    handle.cancel();
  }
});

test('initial dimensions and ioctl resize reach the PTY child', async (t) => {
  const f = await fixture(t), handle = await startLogin('claude', { ...f.options, cols: 97, rows: 31 });
  await until(() => f.output().includes('READY'));
  assert.deepEqual((await f.meta()).size, [97, 31]);
  handle.resize(143, 47);
  await until(() => f.output().includes('SIZE:143x47'));
  handle.write('finish\n'); await handle.done;
});

test('split UTF-8 output survives base64 PTY transport without replacement characters', async (t) => {
  const f = await fixture(t, `
const bytes=Buffer.from('你好🦊 café');
for (const byte of bytes) { process.stdout.write(Buffer.from([byte])); await new Promise(r=>setTimeout(r,15)); }
`);
  const handle = await startLogin('claude', f.options);
  assert.deepEqual(await handle.done, { exitCode: 0 });
  assert.equal(f.output(), '你好🦊 café');
  assert.doesNotMatch(f.output(), /�/);
});

test('fixed browser helper prints URL arguments as data without launching another browser or shell input', async (t) => {
  const f = await fixture(t, `
const url='https://auth.example.test/login?state=fake&value=$(touch NEVER)';
const browser=spawnSync(process.env.BROWSER,[url],{stdio:'inherit'});
process.exit(browser.status ?? 1);
`);
  const handle = await startLogin('claude', f.options);
  assert.deepEqual(await handle.done, { exitCode: 0 });
  assert.match(f.output(), /https:\/\/auth.example.test\/login\?state=fake&value=\$\(touch NEVER\)/);
  assert.doesNotMatch(f.output(), /untrusted-browser/);
});

test('official CLI nonzero exit and auth output pass only through the owner callback', async (t) => {
  const f = await fixture(t, `process.stderr.write('Official CLI rejected fake code: owner-only-auth-transcript\\n'); process.exit(7);`);
  const handle = await startLogin('claude', f.options);
  assert.deepEqual(await handle.done, { exitCode: 7 });
  assert.match(f.output(), /owner-only-auth-transcript/);
});

test('cancel and caller abort kill the CLI process group and descendants and clean cwd', async (t) => {
  for (const bySignal of [false, true]) {
    const f = await fixture(t, `
process.on('SIGTERM',()=>{});
spawn(process.execPath,['-e',"const fs=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync("+JSON.stringify(testRoot+'/heartbeat')+",'x'),15);"],{stdio:'ignore'});
process.stdout.write('READY\\n'); setInterval(()=>{},1000);
`);
    const controller = new AbortController(), handle = await startLogin('codex', { ...f.options, signal: controller.signal });
    await until(async () => { try { return (await stat(join(f.root, 'heartbeat'))).size > 0; } catch { return false; } });
    if (bySignal) controller.abort(new Error('private-caller-reason')); else handle.cancel();
    assert.deepEqual(await handle.done, { exitCode: null });
    const size = (await stat(join(f.root, 'heartbeat'))).size;
    await delay(100); assert.equal((await stat(join(f.root, 'heartbeat'))).size, size);
    await assert.rejects(stat((await f.meta()).cwd), { code: 'ENOENT' });
  }
});

test('absolute timeout terminates an idle PTY and returns a fixed error', async (t) => {
  const f = await fixture(t, `process.on('SIGTERM',()=>{}); process.stdout.write('owner-only-transcript\\n'); setInterval(()=>{},1000);`);
  const handle = await startLogin('claude', { ...f.options, timeoutMs: 300 });
  await assert.rejects(handle.done, (error: Error) => { assert.match(error.message, /CLI login timed out/); assert.doesNotMatch(error.message, /owner-only|private/); return true; });
  await assert.rejects(stat((await f.meta()).cwd), { code: 'ENOENT' });
});

test('output over 512 KiB stops the login without retaining or forwarding excess output', async (t) => {
  const f = await fixture(t, `process.stdout.write(Buffer.alloc(600*1024,120)); setInterval(()=>{},1000);`);
  const handle = await startLogin('claude', f.options);
  await assert.rejects(handle.done, /512 KiB limit/);
  assert.ok(Buffer.byteLength(f.output()) <= 512 * 1024);
  await assert.rejects(stat((await f.meta()).cwd), { code: 'ENOENT' });
});

test('terminal input bounds measure UTF-8 bytes and reject malformed dimensions without killing a valid session', async (t) => {
  const f = await fixture(t), handle = await startLogin('claude', f.options);
  await until(() => f.output().includes('READY'));
  assert.throws(() => handle.write('x'.repeat(8193)), /8 KiB/);
  assert.throws(() => handle.write('🦊'.repeat(2049)), /8 KiB/);
  assert.throws(() => handle.write(null as any), /strings/);
  for (const [cols, rows] of [[0,24], [80,0], [1001,24], [80,NaN], [80,1.5]]) assert.throws(() => handle.resize(cols, rows), /dimensions/);
  handle.write('x'.repeat(8192)); handle.write('\n');
  assert.deepEqual(await handle.done, { exitCode: 0 });
  assert.ok(f.output().includes('RECEIVED:' + 'x'.repeat(8192)));
});

test('missing Python or CLI rejects safely and cleans the temporary working directory', async (t) => {
  const f = await fixture(t), oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = f.root;
  try {
    for (const extra of [{ pythonPath: join(f.root, 'missing-python') }, { claudePath: join(f.root, 'missing-cli') }]) {
      await assert.rejects(startLogin('claude', { ...f.options, ...extra }), (error: Error) => {
        assert.match(error.message, /Python 3 login terminal helper could not be started|Official login CLI could not be started/);
        assert.doesNotMatch(error.message, /ENOENT|swarm-login-test/); return true;
      });
      assert.equal((await readdir(f.root)).some((name) => name.startsWith('swarm-cli-login-')), false);
      assert.equal(f.output(), '');
    }
  } finally { if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; }
});

test('invalid provider, missing callback, bad timeout and aborted startup never begin a login', async (t) => {
  const f = await fixture(t);
  for (const provider of ['bash', '__proto__', null]) await assert.rejects(startLogin(provider, f.options), /Provider/);
  await assert.rejects(startLogin('claude', { ...f.options, onData: undefined }), /callback/);
  for (const timeoutMs of [0, -1, NaN, 600001]) await assert.rejects(startLogin('claude', { ...f.options, timeoutMs }), /timeout/);
  await assert.rejects(startLogin('claude', { ...f.options, cols: 0 }), /dimensions/);
  const controller = new AbortController(); controller.abort(new Error('private-reason'));
  await assert.rejects(startLogin('claude', { ...f.options, signal: controller.signal }), /CLI login cancelled/);
  await assert.rejects(stat(f.audit), { code: 'ENOENT' });
  const next = new AbortController(), pending = startLogin('claude', { ...f.options, signal: next.signal }); next.abort();
  await assert.rejects(pending, /CLI login cancelled/);
});

test('callback and helper infrastructure failures never expose exception details or helper stderr', async (t) => {
  const f = await fixture(t);
  const handle = await startLogin('claude', { ...f.options, onData() { throw new Error('private-exception'); } });
  await assert.rejects(handle.done, { message: 'Login terminal output could not be delivered.' });
  const badPython = join(f.root, 'bad-python.mjs');
  await writeFile(badPython, `#!${process.execPath}\nconsole.error('private-helper-stderr');process.exit(3);`, { mode: 0o700 });
  await assert.rejects(startLogin('claude', { ...f.options, pythonPath: badPython }), { message: 'Python 3 login terminal helper exited unexpectedly.' });
});

test('helper readiness is bounded to 10 seconds independently of the login lifetime', { timeout: 15000 }, async (t) => {
  const f = await fixture(t), hangingPython = join(f.root, 'hanging-python.mjs');
  await writeFile(hangingPython, `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);`, { mode: 0o700 });
  const before = Date.now();
  await assert.rejects(startLogin('claude', { ...f.options, pythonPath: hangingPython, timeoutMs: 600000 }), /did not become ready within 10 seconds/);
  assert.ok(Date.now() - before < 13000);
});

test('successful login exit also terminates descendants holding the PTY open', async (t) => {
  const f = await fixture(t, `
spawn(process.execPath,['-e',"const fs=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync("+JSON.stringify(testRoot+'/heartbeat')+",'x'),15);"],{stdio:'inherit'});
setTimeout(()=>process.exit(0),150);
`);
  const handle = await startLogin('claude', f.options);
  assert.deepEqual(await handle.done, { exitCode: 0 });
  const size = (await stat(join(f.root, 'heartbeat'))).size;
  await delay(100); assert.equal((await stat(join(f.root, 'heartbeat'))).size, size);
  await assert.rejects(stat((await f.meta()).cwd), { code: 'ENOENT' });
});

test('hosted file credential option scopes Codex status and generation without changing local defaults', async (t) => {
  const f = await fixture(t, `
const args=process.argv.slice(2);
fs.appendFileSync(testRoot+'/calls',JSON.stringify(args)+'\\n');
if(args[0]==='login'){process.stderr.write('Logged in using ChatGPT\\n');}
else {fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'{"ok":true}'); console.log(JSON.stringify({type:'turn.completed',usage:{}}));}
`);
  const request = { provider: 'codex', prompt: 'fake generation only', schema: { type: 'object' }, timeoutMs: 4000 };
  await checkProviders({ ...f.options, claudePath: '/missing/claude', fileCredentials: true });
  await runGeneration(request, { ...f.options, fileCredentials: true });
  const hostedCalls = (await readFile(join(f.root, 'calls'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(hostedCalls.length, 3);
  for (const args of hostedCalls) assert.ok(args.includes('cli_auth_credentials_store="file"'));
  await checkProviders({ ...f.options, claudePath: '/missing/claude' });
  const localCall = JSON.parse((await readFile(join(f.root, 'calls'), 'utf8')).trim().split('\n').at(-1)!);
  assert.equal(localCall.includes('cli_auth_credentials_store="file"'), false);
});

// node --import tsx --test --test-concurrency=1 tests/cli-login.test.mts
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { Hono } from 'hono';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-cli-login-'));
const profiles = path.join(temp, 'profiles');
const auditFile = path.join(temp, 'cli-audit.jsonl');
const apiRequests: string[] = [];
const sentinel = createServer((req, res) => {
  apiRequests.push(`${req.method} ${req.url}`);
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Paid API requests are forbidden in this test' } }));
});
sentinel.listen(0, '127.0.0.1');
await once(sentinel, 'listening');
const address = sentinel.address();
assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
const fakeCli = path.join(temp, 'fake official CLI.mjs');

// This is an actual executable, not a mock of startLogin. Fake authentication is
// written only beneath its isolated HOME; no provider endpoint or real login runs.
fs.writeFileSync(fakeCli, `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const args = process.argv.slice(2);
const provider = args[0] === 'login' || args[0] === 'exec' ? 'codex' : 'claude';
const marker = path.join(process.env.HOME, provider + '-fake-auth');
const audit = value => fs.appendFileSync(${JSON.stringify(auditFile)}, JSON.stringify({ ...value, provider, args, env: process.env, pid: process.pid, cwd: process.cwd() }) + '\\n');
const probe = args[0] === 'login' && args[1] === 'status' || args[0] === 'auth' && args[1] === 'status';
if (probe) {
  audit({ kind: 'status' });
  const hold = path.join(process.env.HOME, provider + '-hold-status');
  if (fs.existsSync(hold)) {
    audit({ kind: 'status-held' });
    while (fs.existsSync(hold)) await new Promise(resolve => setTimeout(resolve, 10));
  }
  const auth = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
  if (provider === 'codex') {
    console.error(auth === 'subscription' ? 'Logged in using ChatGPT' : auth === 'api' ? 'Logged in using an API key' : 'Not logged in');
  } else console.log(JSON.stringify({ loggedIn: !!auth, authMethod: auth === 'api' ? 'api_key' : 'claude.ai', subscriptionType: auth === 'subscription' ? 'max' : null }));
  process.exit(auth ? 0 : 1);
}
const login = args[0] === 'login' || args[0] === 'auth' && args[1] === 'login';
if (login) {
  audit({ kind: 'login', stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY });
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error('LOGIN_REQUIRES_REAL_TTY'); process.exit(87); }
  const size = () => console.log('TERMINAL_SIZE=' + process.stdout.columns + 'x' + process.stdout.rows);
  process.stdout.on('resize', size);
  console.log('https://signin.example.test/' + provider + '?flow=fake-only');
  console.log('Paste the test authorization code:');
  size();
  const input = readline.createInterface({ input: process.stdin, terminal: false });
  input.on('line', code => {
    if (code === 'OK') {
      fs.mkdirSync(process.env.HOME, { recursive: true });
      fs.writeFileSync(marker, 'subscription', { mode: 0o600 });
      console.log('FAKE_LOGIN_COMPLETE');
      process.exit(0);
    }
    if (code === 'API') { fs.writeFileSync(marker, 'api', { mode: 0o600 }); process.exit(0); }
    if (code === 'NOAUTH') process.exit(0);
    if (code === 'FAIL') { console.error('FAKE_LOGIN_FAILED'); process.exit(7); }
    if (code === 'SIZE') size();
    if (code === 'SPAM') { process.stdout.write('X'.repeat(600 * 1024) + '\\nEND_OF_LARGE_OUTPUT\\n'); }
    if (code.startsWith('ECHO:')) console.log('RECEIVED=' + code.slice(5));
  });
} else {
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  audit({ kind: 'generate', prompt });
  if (prompt.includes('HOLD_FOR_CLEANUP')) await new Promise(() => setInterval(() => {}, 1000));
  const output = { text: provider + ' profile ' + path.basename(process.env.HOME), tool_calls: [] };
  if (provider === 'codex') {
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(output));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 31, output_tokens: 9 } }));
  } else console.log(JSON.stringify({ type: 'result', subtype: 'success', structured_output: output, usage: { input_tokens: 31, output_tokens: 9 } }));
}
`, { mode: 0o700 });

Object.assign(process.env, {
  DB_PATH: path.join(temp, 'test.db'), FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'cli-login-test-secret',
  SERVER_URL: base, APP_URL: base, COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '',
  CLI_PROFILES_DIR: profiles, SWARM_CLI_CODEX_PATH: fakeCli, SWARM_CLI_CLAUDE_PATH: fakeCli,
  DIRECT_API_KEY: 'test-parent-direct-secret', DIRECT_BASE_URL: `${base}/direct`,
  OPENROUTER_API_KEY: 'test-parent-openrouter-secret', OPENROUTER_BASE_URL: `${base}/openrouter`, LLM_PROVIDER: 'openrouter',
  OPENAI_API_KEY: 'test-parent-openai-secret', ANTHROPIC_API_KEY: 'test-parent-anthropic-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'test-parent-oauth-secret', CODEX_API_KEY: 'test-parent-codex-secret',
  AWS_SECRET_ACCESS_KEY: 'test-parent-aws-secret', CUSTOM_OPERATOR_SECRET: 'test-parent-custom-secret',
  CODEX_HOME: path.join(temp, 'forbidden-parent-codex'), CLAUDE_CONFIG_DIR: path.join(temp, 'forbidden-parent-claude'),
  INKBOX_TUNNEL: '0',
});

const { db } = await import('../server/src/db.js');
const { cliApi } = await import('../server/src/cli/routes.js');
const { selectedCli } = await import('../server/src/cli/store.js');
const { cliRuntime } = await import('../server/src/cli/store.js');
const { createCliPairing, selectCli, setCliRuntime } = await import('../server/src/cli/store.js');
const { withCliMutation } = await import('../server/src/cli/lock.js');
const { revokeSession, sessionHash } = await import('../server/src/lib/auth.js');
const { startLoginSession, cancelUserLogins } = await import('../server/src/cli/login.js');
const { profilePath } = await import('../server/src/cli/hosted.js');
const { llmClient, defaultModel, llmProvider } = await import('../server/src/lib/llm.js');
const { withUsage } = await import('../server/src/usage-context.js');
const app = new Hono().route('/api/cli', cliApi);
type Provider = 'codex' | 'claude';
type Login = { id: string; provider: Provider; state: 'running' | 'verifying' | 'connected' | 'failed' | 'cancelled'; output: string; cursor: number; reset: boolean; error?: string; exitCode?: number };
let alice: string, bob: string, sequence = 0;
const sessions = new Map<string, string>();
const audit = () => fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) as any[] : [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function req(userId: string | null, route = '', method = 'GET', body?: unknown) {
  return app.request(`/api/cli${route}`, {
    method, headers: { ...(userId ? { cookie: `swarm_session=${encodeURIComponent(userId)}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function read(userId: string, id: string, cursor = 0): Promise<Login> {
  const response = await req(userId, `/login/${id}?cursor=${cursor}`);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const session = await response.json() as Login;
  assert.equal(session.id, id);
  assert.ok(['running', 'verifying', 'connected', 'failed', 'cancelled'].includes(session.state));
  assert.equal(typeof session.output, 'string');
  assert.ok(Number.isSafeInteger(session.cursor) && session.cursor >= 0);
  assert.equal(typeof session.reset, 'boolean');
  return session;
}
async function waitFor(userId: string, id: string, predicate: (session: Login) => boolean, description: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last: Login | undefined;
  while (Date.now() < deadline) {
    last = await read(userId, id);
    if (predicate(last)) return last;
    await delay(15);
  }
  assert.fail(`${description}: ${JSON.stringify(last)}`);
}
async function start(userId: string, provider: Provider, extra: Record<string, unknown> = {}) {
  const response = await req(userId, '/login', 'POST', { provider, cols: 91, rows: 27, ...extra });
  assert.ok(response.status === 200 || response.status === 201, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const login = await response.json() as Login;
  assert.equal(typeof login.id, 'string');
  assert.equal(login.provider, provider);
  sessions.set(login.id, userId);
  await waitFor(userId, login.id, session => session.output.includes('Paste the test authorization code:'), 'fake CLI starts on an actual PTY');
  return login;
}
async function input(userId: string, id: string, data: string) {
  const response = await req(userId, `/login/${id}/input`, 'POST', { data });
  assert.equal(response.status, 200, await response.clone().text());
}
async function login(userId: string, provider: Provider) {
  const session = await start(userId, provider);
  await input(userId, session.id, 'OK\r');
  return waitFor(userId, session.id, value => value.state === 'connected', 'subscription login should verify and connect');
}

async function until(predicate: () => boolean, description: string, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await delay(10);
  assert.ok(predicate(), description);
}

beforeEach(() => {
  apiRequests.length = 0;
  alice = `embedded/alice-${++sequence}@example.test`;
  bob = `embedded/bob-${sequence}@example.test`;
  for (const id of [alice, bob]) {
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, id, id, Date.now());
    db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3_600_000);
  db.prepare('UPDATE auth_sessions SET last_seen_at=created_at,authenticated_at=created_at WHERE token=session_hash(?)').run(id);
  }
});
afterEach(async () => {
  for (const [id, userId] of sessions) await req(userId, `/login/${id}`, 'DELETE');
  sessions.clear();
  await delay(50);
  db.exec('DELETE FROM users;');
  fs.rmSync(profiles, { recursive: true, force: true });
  fs.rmSync(auditFile, { force: true });
  assert.deepEqual(apiRequests, [], 'embedded CLI mode must not use API billing or fetch provider prices');
});
after(async () => {
  await new Promise<void>(resolve => sentinel.close(() => resolve()));
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('login terminal endpoints require an unexpired signed-in cookie', async () => {
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run('expired-login-session', alice, Date.now() - 2000, Date.now() - 1);
  for (const credential of [null, 'unknown', 'expired-login-session']) {
    for (const [route, method, body] of [
      ['/login', 'POST', { provider: 'codex', cols: 80, rows: 24 }],
      ['/login/unknown?cursor=0', 'GET', undefined],
      ['/login/unknown/input', 'POST', { data: 'OK\r' }],
      ['/login/unknown/resize', 'POST', { cols: 100, rows: 30 }],
      ['/login/unknown', 'DELETE', undefined],
    ] as const) assert.equal((await req(credential, route, method, body)).status, 401, `${method} ${route}`);
  }
  assert.equal(audit().length, 0, 'unauthenticated callers cannot start an executable');
});

test('server runtime availability and both CLI providers are reported without using an operator profile', async () => {
  const response = await req(alice);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.runtime, 'server');
  assert.equal(status.serverLoginAvailable, true);
  const refreshed = await req(alice, '/refresh', 'POST');
  assert.equal(refreshed.status, 200);
  const providers = (await refreshed.json()).providers;
  for (const provider of ['codex', 'claude']) {
    assert.equal(providers[provider].installed, true);
    assert.equal(providers[provider].authenticated, false);
    assert.equal(providers[provider].subscription, false);
  }
  assert.equal(selectedCli(alice), null);
  for (const call of audit()) assert.ok(call.env.HOME.startsWith(profiles + path.sep));
});

test('terminal output, input, resize and cancel are all inaccessible to another Swarm user', async () => {
  const a = await start(alice, 'codex');
  const b = await start(bob, 'claude');
  for (const [route, method, body] of [
    [`/login/${a.id}?cursor=0`, 'GET', undefined],
    [`/login/${a.id}/input`, 'POST', { data: 'OK\r' }],
    [`/login/${a.id}/resize`, 'POST', { cols: 120, rows: 40 }],
    [`/login/${a.id}`, 'DELETE', undefined],
  ] as const) {
    const response = await req(bob, route, method, body);
    assert.equal(response.status, 404, `${method} ${route}`);
    assert.ok(!(await response.text()).includes('signin.example.test'), 'foreign terminal content must never leak');
  }
  assert.equal((await read(alice, a.id)).state, 'running');
  assert.equal((await read(bob, b.id)).state, 'running');
  assert.equal(selectedCli(alice), null);
});

test('real PTY input, incremental output cursors and resize reach the fake login process', async () => {
  const session = await start(alice, 'codex');
  const first = await read(alice, session.id);
  assert.match(first.output, /https:\/\/signin.example.test\/codex/);
  assert.match(first.output, /TERMINAL_SIZE=91x27/);
  const idle = await read(alice, session.id, first.cursor);
  assert.equal(idle.output, '');
  assert.equal(idle.cursor, first.cursor);
  assert.equal(idle.reset, false);
  await input(alice, session.id, 'ECHO:pasted-code-reached-the-tty\r');
  await waitFor(alice, session.id, value => value.output.includes('RECEIVED=pasted-code-reached-the-tty'), 'PTY stdin reaches the CLI');
  const incremental = await read(alice, session.id, first.cursor);
  assert.ok(incremental.cursor > first.cursor);
  assert.match(incremental.output, /RECEIVED=pasted-code-reached-the-tty/);
  assert.ok(!incremental.output.includes('https://signin.example.test'), 'polling a cursor does not repeat previous terminal output');
  const resized = await req(alice, `/login/${session.id}/resize`, 'POST', { cols: 117, rows: 39 });
  assert.equal(resized.status, 200, await resized.clone().text());
  await input(alice, session.id, 'SIZE\r');
  await waitFor(alice, session.id, value => value.output.includes('TERMINAL_SIZE=117x39'), 'PTY reports its resized dimensions');
  const call = audit().find(value => value.kind === 'login');
  assert.equal(call.stdinTTY, true);
  assert.equal(call.stdoutTTY, true);
});

test('successful login rechecks subscription authentication and automatically selects each provider', async () => {
  for (const provider of ['codex', 'claude'] as const) {
    const connected = await login(alice, provider);
    assert.equal(connected.provider, provider);
    assert.equal(connected.exitCode, 0);
    assert.equal(selectedCli(alice), provider);
    const response = await req(alice);
    const status = await response.json();
    assert.equal(status.runtime, 'server');
    assert.equal(status.selected, provider);
    assert.equal(status.providers[provider].subscription, true);
    const calls = audit().filter(value => value.provider === provider);
    assert.ok(calls.some(value => value.kind === 'status' && value.pid !== calls.find(value => value.kind === 'login')?.pid), 'success must probe official CLI auth after the login process exits');
  }
  assert.equal(selectedCli(bob), null);
});

test('each user receives hashed private profiles and a child environment without server credentials', async () => {
  await login(alice, 'codex');
  await login(bob, 'codex');
  const calls = audit().filter(value => value.kind === 'login');
  assert.equal(calls.length, 2);
  const [a, b] = calls;
  assert.notEqual(a.env.HOME, b.env.HOME);
  assert.notEqual(a.env.CODEX_HOME, b.env.CODEX_HOME);
  for (const [call, userId] of [[a, alice], [b, bob]] as const) {
    const hash = createHash('sha256').update(userId).digest('hex');
    assert.ok(call.env.HOME.startsWith(profiles + path.sep));
    assert.ok(call.env.HOME.includes(hash), 'raw Swarm identifiers must never become profile directory names');
    assert.ok(!call.env.HOME.includes('@'));
    assert.ok(call.env.CODEX_HOME.startsWith(call.env.HOME + path.sep));
    assert.ok(call.env.CLAUDE_CONFIG_DIR.startsWith(call.env.HOME + path.sep));
    assert.equal(fs.readFileSync(path.join(call.env.HOME, 'codex-fake-auth'), 'utf8'), 'subscription');
    assert.equal(fs.statSync(call.env.HOME).mode & 0o077, 0, 'profile home is private to its OS account');
  }
  for (const call of audit()) {
    assert.doesNotMatch(JSON.stringify(call.env), /test-parent-|forbidden-parent-/);
    if (call.provider === 'codex') assert.ok(call.args.includes('cli_auth_credentials_store="file"'), `${call.kind} must use the account profile instead of a shared keychain`);
    for (const key of ['OPENAI_API_KEY', 'DIRECT_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'CUSTOM_OPERATOR_SECRET', 'NODE_OPTIONS', 'BASH_ENV']) {
      assert.equal(call.env[key], undefined, `${call.kind}: ${key}`);
    }
  }
});

test('exit zero without verified auth and API credentials cannot become connected or enable paid fallback', async () => {
  for (const provider of ['codex', 'claude'] as const) {
    for (const code of ['NOAUTH', 'API']) {
      const session = await start(alice, provider);
      await input(alice, session.id, `${code}\r`);
      const finished = await waitFor(alice, session.id, value => value.state === 'failed', `${provider} ${code} is rejected`);
      assert.equal(finished.exitCode, 0);
      assert.ok(finished.error);
      assert.equal(selectedCli(alice), null);
      assert.equal((await req(alice, '', 'PUT', { provider, runtime: 'server' })).status, 409);
    }
  }
});

test('failed CLI login preserves its exit status and cancelling a running terminal stops its process', async () => {
  const failed = await start(alice, 'claude');
  await input(alice, failed.id, 'FAIL\r');
  const failure = await waitFor(alice, failed.id, value => value.state === 'failed', 'nonzero CLI login is reported as failed');
  assert.equal(failure.exitCode, 7);
  assert.ok(failure.error);
  const running = await start(alice, 'codex');
  const pid = audit().findLast(value => value.kind === 'login').pid;
  const response = await req(alice, `/login/${running.id}`, 'DELETE');
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal((await req(alice, `/login/${running.id}`)).status, 404, 'DELETE disposes the cancelled terminal and its output');
  const deadline = Date.now() + 3000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive) await delay(20);
  }
  assert.equal(alive, false, 'cancel must stop the actual login child');
  assert.equal(selectedCli(alice), null);
});

test('invalid terminal input is rejected and request bodies cannot choose executables or credential homes', async () => {
  for (const body of [
    null, {}, { provider: 'bash', cols: 80, rows: 24 },
    ...[0, 19, 301, 80.5, '80'].map(cols => ({ provider: 'codex', cols, rows: 24 })),
    ...[0, 4, 121, 24.5, '24'].map(rows => ({ provider: 'claude', cols: 80, rows })),
  ]) assert.equal((await req(alice, '/login', 'POST', body)).status, 400);
  assert.equal(audit().length, 0, 'bad requests never start a process');
  const session = await start(alice, 'codex', {
    codexPath: '/must-not-execute/request-supplied-cli', pythonPath: '/must-not-execute/python',
    env: { HOME: '/must-not-use/request-supplied-home', OPENAI_API_KEY: 'request-key' },
  });
  for (const body of [null, {}, { data: '' }, { data: 42 }, { data: 'x'.repeat(8193) }, { data: 'é'.repeat(4097) }]) {
    assert.equal((await req(alice, `/login/${session.id}/input`, 'POST', body)).status, 400);
  }
  for (const body of [{ cols: 19, rows: 24 }, { cols: 80, rows: 121 }, { cols: '80', rows: 24 }]) {
    assert.equal((await req(alice, `/login/${session.id}/resize`, 'POST', body)).status, 400);
  }
  for (const cursor of ['-1', 'NaN', '1.5', '9007199254740992']) {
    assert.equal((await req(alice, `/login/${session.id}?cursor=${cursor}`)).status, 400);
  }
  const call = audit().find(value => value.kind === 'login');
  assert.ok(call.env.HOME.startsWith(profiles + path.sep));
  assert.ok(!call.env.HOME.includes('request-supplied'));
  assert.equal(call.env.OPENAI_API_KEY, undefined);
  assert.equal((await read(alice, session.id)).state, 'running');
});

test('an impossible cursor resets to the retained terminal output and excessive output fails within its bound', async () => {
  const session = await start(alice, 'codex');
  const first = await read(alice, session.id);
  const reset = await read(alice, session.id, Number.MAX_SAFE_INTEGER);
  assert.equal(reset.reset, true);
  assert.match(reset.output, /https:\/\/signin.example.test/);
  assert.ok(reset.cursor >= first.cursor);
  await input(alice, session.id, 'SPAM\r');
  const failed = await waitFor(alice, session.id, value => value.state === 'failed', 'excessive terminal output is stopped');
  assert.match(failed.error!, /output.*limit|output exceeded/i);
  assert.ok(Buffer.byteLength(failed.output) <= 512 * 1024);
  assert.equal(selectedCli(alice), null);
});

test('login timeout closes the actual pending terminal and never selects a subscription', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let id: string | undefined;
  try {
    const response = await req(alice, '/login', 'POST', { provider: 'claude', cols: 80, rows: 24 });
    assert.equal(response.status, 200, await response.clone().text());
    const session = await response.json() as Login;
    id = session.id; sessions.set(id, alice);
    assert.equal(session.state, 'running');
    t.mock.timers.tick(600_000);
  } finally { t.mock.timers.reset(); }
  assert.ok(id);
  const timedOut = await read(alice, id);
  assert.equal(timedOut.state, 'failed');
  assert.match(timedOut.error!, /timed out/i);
  assert.equal(selectedCli(alice), null);
  assert.equal((await req(alice, `/login/${id}`, 'DELETE')).status, 200);
  assert.equal((await req(alice, `/login/${id}`)).status, 404);
});

test('two simultaneous login starts for one account create exactly one interactive terminal', async () => {
  const responses = await Promise.all([
    req(alice, '/login', 'POST', { provider: 'codex', cols: 80, rows: 24 }),
    req(alice, '/login', 'POST', { provider: 'claude', cols: 80, rows: 24 }),
  ]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const active = await responses.find(response => response.status === 200)!.json() as Login;
  sessions.set(active.id, alice);
  await waitFor(alice, active.id, value => value.output.includes('Paste the test authorization code:'), 'one login reaches the PTY');
  assert.equal(audit().filter(value => value.kind === 'login').length, 1);
  assert.equal((await read(alice, active.id)).state, 'running');
});

test('stored server runtime and credential homes are reused across the same owner bots and message channels', async () => {
  await login(alice, 'codex');
  await login(bob, 'claude');
  const botIds = ['alice-chat', 'alice-sms', 'bob-chat'];
  for (const [i, userId] of [alice, alice, bob].entries()) {
    db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(botIds[i], userId, botIds[i], Date.now(), Date.now());
  }
  const responses = await Promise.all(botIds.map((botId, i) => withUsage({ userId: i === 2 ? alice : bob, botId }, async () => {
    assert.equal(cliRuntime(i === 2 ? bob : alice), 'server');
    assert.equal(defaultModel(), i === 2 ? 'claude/default' : 'codex/default');
    const response: any = await llmClient(3000).responses.create({
      model: defaultModel(), input: [{ role: 'user', content: i === 1 ? '[via SMS] answer me' : 'answer me in chat' }],
    });
    return { provider: llmProvider(), text: response.output_text };
  })));
  assert.equal(responses[0].provider, 'codex-cli');
  assert.equal(responses[1].provider, 'codex-cli');
  assert.equal(responses[2].provider, 'claude-cli');
  const calls = audit();
  const aHome = calls.find(value => value.kind === 'login' && value.provider === 'codex').env.HOME;
  const bHome = calls.find(value => value.kind === 'login' && value.provider === 'claude').env.HOME;
  const generations = calls.filter(value => value.kind === 'generate');
  assert.equal(generations.length, 3);
  assert.equal(generations.filter(value => value.env.HOME === aHome).length, 2);
  assert.equal(generations.filter(value => value.env.HOME === bHome).length, 1);
  assert.ok(generations.some(value => value.prompt.includes('[via SMS]')));
  assert.ok(responses[0].text.includes(path.basename(aHome)));
  assert.ok(responses[2].text.includes(path.basename(bHome)));
  for (const call of calls) assert.doesNotMatch(JSON.stringify(call.env), /test-parent-/);
  for (const call of generations.filter(value => value.provider === 'codex')) assert.ok(call.args.includes('cli_auth_credentials_store="file"'));
  fs.rmSync(path.join(aHome, 'codex-fake-auth'));
  await assert.rejects(withUsage({ botId: botIds[0] }, () => llmClient(3000).responses.create({ model: defaultModel(), input: 'auth was revoked' })), /subscription|sign in/i);
  assert.equal(audit().filter(value => value.kind === 'generate').length, 3, 'missing auth is rejected before generation, despite cached status and configured API keys');
  assert.equal(selectedCli(alice), 'codex');
});

test('switching to a local bridge cancels pending server sign-in without reviving it', async () => {
  const session = await start(alice, 'codex');
  const pid = audit().find(value => value.kind === 'login').pid;
  const paired = await req(alice, '/pair', 'POST');
  assert.equal(paired.status, 200);
  assert.match((await paired.json()).command, /--token/);
  assert.equal((await req(alice, `/login/${session.id}`)).status, 404);
  assert.equal(cliRuntime(alice), 'bridge');
  assert.equal((await (await req(alice)).json()).runtime, 'bridge');
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'source switch stops the real CLI login child');
  assert.equal(selectedCli(alice), null);
  assert.equal(audit().filter(value => value.kind === 'generate').length, 0);
});

test('switching sources during slow PTY startup waits for cleanup and cannot resurrect a server login', async () => {
  const slowPython = path.join(temp, 'slow-python-start.mjs');
  const startedFile = path.join(temp, 'python-wrapper-started');
  fs.rmSync(startedFile, { force: true });
  fs.writeFileSync(slowPython, `#!${process.execPath}
import fs from 'node:fs';
import { spawn } from 'node:child_process';
fs.writeFileSync(${JSON.stringify(startedFile)}, String(process.pid));
const timer = setTimeout(() => {
  const python = spawn('python3', process.argv.slice(2), { stdio: 'inherit', env: process.env });
  python.on('error', () => process.exit(88));
  python.on('exit', code => process.exit(code ?? 1));
}, 300);
process.on('SIGTERM', () => { clearTimeout(timer); process.exit(0); });
`, { mode: 0o700 });
  const previousPython = process.env.SWARM_CLI_PYTHON_PATH;
  let starting: Promise<Response> | undefined;
  try {
    process.env.SWARM_CLI_PYTHON_PATH = slowPython;
    starting = req(alice, '/login', 'POST', { provider: 'codex', cols: 80, rows: 24 });
    await until(() => fs.existsSync(startedFile), 'PTY infrastructure starts before cancelling its source');
    const paired = await req(alice, '/pair', 'POST');
    assert.equal(paired.status, 200, await paired.clone().text());
    const original = await starting;
    assert.ok([200, 404, 409].includes(original.status), `cancelled startup returns an expected response: ${original.status} ${await original.clone().text()}`);
    if (original.status === 200) {
      const session = await original.json() as Login;
      assert.notEqual(session.state, 'connected');
      assert.equal((await req(alice, `/login/${session.id}`)).status, 404);
    }
    assert.equal(cliRuntime(alice), 'bridge');
    assert.equal(selectedCli(alice), null);
    const pid = Number(fs.readFileSync(startedFile, 'utf8'));
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'cancelled PTY startup process is reaped');
    const logins = audit().filter(value => value.kind === 'login');
    for (const call of logins) await until(() => { try { process.kill(call.pid, 0); return false; } catch { return true; } }, 'any CLI launched before the source switch is stopped');
    await delay(350);
    assert.equal(audit().filter(value => value.kind === 'login').length, logins.length, 'the completed source switch cannot launch another CLI afterward');
  } finally {
    if (previousPython === undefined) delete process.env.SWARM_CLI_PYTHON_PATH;
    else process.env.SWARM_CLI_PYTHON_PATH = previousPython;
    await starting;
  }
});

test('immediate startLoginSession versus cancelUserLogins waits for startup and releases the user cleanly', async () => {
  const starting = startLoginSession(alice, 'codex', 80, 24);
  const cancelling = cancelUserLogins(alice);
  await assert.rejects(startLoginSession(alice, 'claude', 80, 24), (error: any) => error.status === 409);
  const [session] = await Promise.all([starting, cancelling]);
  assert.equal(session.state, 'cancelled');
  assert.equal((await req(alice, `/login/${session.id}`)).status, 404);
  assert.equal(audit().filter(value => value.kind === 'login').length, 0, 'immediate cancellation prevents executable startup');
  assert.equal(selectedCli(alice), null);
  const next = await start(alice, 'claude');
  assert.equal((await read(alice, next.id)).state, 'running', 'settled cancellation leaves no stale busy/signing-in state');
});

test('reauthentication blocks model requests until its terminal is closed and keeps the existing runtime', async () => {
  await login(alice, 'codex');
  const session = await start(alice, 'codex');
  await assert.rejects(withUsage({ userId: alice }, () => llmClient(3000).responses.create({ model: defaultModel(), input: 'do not run during sign-in' })), /sign-in is in progress|finish or cancel/i);
  assert.equal(audit().filter(value => value.kind === 'generate').length, 0);
  assert.equal(selectedCli(alice), 'codex');
  assert.equal((await req(alice, `/login/${session.id}`, 'DELETE')).status, 200);
  const response: any = await withUsage({ userId: alice }, () => llmClient(3000).responses.create({ model: defaultModel(), input: 'saved profile is reusable' }));
  assert.equal(response.provider, 'codex-cli');
  assert.equal(response.billing, 'subscription');
  assert.equal(cliRuntime(alice), 'server');
  assert.equal(audit().filter(value => value.kind === 'generate').length, 1);
});

test('server disconnect removes its saved profile and pending login while preserving selection and the other user credentials', async () => {
  await login(alice, 'codex');
  await login(bob, 'claude');
  const ownHome = profilePath(alice), otherHome = profilePath(bob);
  assert.equal(fs.readFileSync(path.join(ownHome, 'codex-fake-auth'), 'utf8'), 'subscription');
  const pending = await start(alice, 'codex');
  const pid = audit().findLast(value => value.kind === 'login' && value.env.HOME === ownHome).pid;
  const response = await req(alice, '/pair', 'DELETE', { userId: bob });
  assert.equal(response.status, 200, await response.clone().text());
  const disconnected = await response.json();
  assert.equal(disconnected.runtime, 'server');
  assert.equal(disconnected.connected, false);
  assert.equal(disconnected.selected, 'codex');
  assert.equal(fs.existsSync(ownHome), false, 'disconnect deletes the entire private credential directory');
  assert.equal((await req(alice, `/login/${pending.id}`)).status, 404);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'disconnect reaps the pending login process');
  assert.equal(fs.readFileSync(path.join(otherHome, 'claude-fake-auth'), 'utf8'), 'subscription');
  assert.equal(selectedCli(bob), 'claude');
  assert.equal((await (await req(bob)).json()).connected, true);
  await assert.rejects(withUsage({ userId: alice }, () => llmClient(3000).responses.create({ model: defaultModel(), input: 'must reject after disconnect' })), /subscription|sign in/i);
  assert.equal(selectedCli(alice), 'codex', 'a deleted profile must not silently restore API mode');
  assert.equal(fs.existsSync(path.join(ownHome, 'codex-fake-auth')), false);
  assert.equal(audit().filter(value => value.kind === 'generate' && value.env.HOME === ownHome).length, 0);
  const otherResponse: any = await withUsage({ userId: bob }, () => llmClient(3000).responses.create({ model: defaultModel(), input: 'other account still works' }));
  assert.equal(otherResponse.provider, 'claude-cli');
  assert.equal(otherResponse.billing, 'subscription');
});

test('server disconnect cancels an in-flight generation before deleting its credentials and leaves the other account usable', async () => {
  await login(alice, 'claude');
  await login(bob, 'codex');
  const ownHome = profilePath(alice), otherHome = profilePath(bob);
  const pending = withUsage({ userId: alice }, () => llmClient(10_000).responses.create({ model: defaultModel(), input: 'HOLD_FOR_CLEANUP' }));
  const rejected = assert.rejects(pending, /cancelled|disconnected|stopping/i);
  try {
    await until(() => audit().some(value => value.kind === 'generate' && value.env.HOME === ownHome), 'generation starts before disconnect');
    const generation = audit().findLast(value => value.kind === 'generate' && value.env.HOME === ownHome);
    const response = await req(alice, '/pair', 'DELETE');
    assert.equal(response.status, 200, await response.clone().text());
    await rejected;
    assert.equal((await response.json()).selected, 'claude');
    assert.equal(fs.existsSync(ownHome), false);
    await until(() => { try { process.kill(generation.pid, 0); return false; } catch { return true; } }, 'disconnect reaps the in-flight generation process');
    assert.equal(fs.existsSync(generation.cwd), false, 'generation temporary working directory is also cleaned');
    assert.equal(fs.readFileSync(path.join(otherHome, 'codex-fake-auth'), 'utf8'), 'subscription');
    assert.equal(selectedCli(bob), 'codex');
    await assert.rejects(withUsage({ userId: alice }, () => llmClient(3000).responses.create({ model: defaultModel(), input: 'no API fallback after cancellation' })), /subscription|sign in/i);
    assert.equal(selectedCli(alice), 'claude');
    const otherResponse: any = await withUsage({ userId: bob }, () => llmClient(3000).responses.create({ model: defaultModel(), input: 'other account remains usable' }));
    assert.equal(otherResponse.provider, 'codex-cli');
  } finally {
    await req(alice, '/pair', 'DELETE');
    await rejected;
  }
});

test('account deletion removes saved CLI credentials and pending login processes without affecting another account', async () => {
  // These are the same production modules initialized by the full server. No
  // Apple identity is attached, so deleting this fake account needs no network.
  const { deleteAccount } = await import('../server/src/accounts.js');
  await import('../server/src/messaging/store.js');
  await login(alice, 'claude');
  await login(bob, 'codex');
  const ownHome = profilePath(alice), otherHome = profilePath(bob);
  const pending = await start(alice, 'claude');
  const pid = audit().findLast(value => value.kind === 'login' && value.env.HOME === ownHome).pid;
  assert.equal(fs.readFileSync(path.join(ownHome, 'claude-fake-auth'), 'utf8'), 'subscription');
  await deleteAccount(alice);
  assert.equal(fs.existsSync(ownHome), false);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'account deletion reaps its login process');
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id=?').get(alice), undefined);
  assert.equal(db.prepare('SELECT 1 FROM auth_sessions WHERE user_id=?').get(alice), undefined);
  assert.equal(db.prepare('SELECT 1 FROM cli_preferences WHERE user_id=?').get(alice), undefined);
  assert.equal(db.prepare('SELECT 1 FROM cli_runtimes WHERE user_id=?').get(alice), undefined);
  assert.equal((await req(alice)).status, 401, 'deleted account cookies cannot access CLI state');
  assert.equal((await req(alice, `/login/${pending.id}`)).status, 401);
  assert.equal(fs.readFileSync(path.join(otherHome, 'codex-fake-auth'), 'utf8'), 'subscription');
  assert.equal(selectedCli(bob), 'codex');
  assert.equal((await req(bob)).status, 200);
  const otherResponse: any = await withUsage({ userId: bob }, () => llmClient(3000).responses.create({ model: defaultModel(), input: 'remaining account still works' }));
  assert.equal(otherResponse.provider, 'codex-cli');
});

test('another session of the same account cannot operate the sign-in terminal', async () => {
  const terminal = await start(alice, 'codex');
  const second = `${alice}-second-device`;
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES(session_hash(?),?,?,?,?,?)')
    .run(second,alice,Date.now(),Date.now()+3600000,Date.now(),Date.now());
  for (const [route,method,body] of [
    [`/login/${terminal.id}`,'GET',undefined],
    [`/login/${terminal.id}/input`,'POST',{data:'OK\r'}],
    [`/login/${terminal.id}/resize`,'POST',{cols:80,rows:24}],
    [`/login/${terminal.id}`,'DELETE',undefined],
  ] as const) assert.equal((await req(second,route,method,body)).status,404);
  const { revokeSession, sessionHash } = await import('../server/src/lib/auth.js');
  revokeSession(sessionHash(alice));
  await delay(100);
  assert.equal((await req(alice,`/login/${terminal.id}`)).status,401);
  assert.equal((await req(second,`/login/${terminal.id}`)).status,404);
});

test('a verified hosted subscription is shared by browser sessions of one account, independent of the login browser', async () => {
  await login(alice, 'codex');
  const second = `${alice}-ipad`;
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES(session_hash(?),?,?,?,?,?)')
    .run(second, alice, Date.now(), Date.now() + 3_600_000, Date.now(), Date.now());
  revokeSession(sessionHash(alice));
  const status = await (await req(second)).json();
  assert.equal(status.runtime, 'server');
  assert.equal(status.selected, 'codex');
  assert.equal(status.providers.codex.subscription, true);
  assert.equal((await req(second, '/refresh', 'POST')).status, 200);
  const other = await (await req(bob)).json();
  assert.equal(other.selected, null);
  assert.equal(other.providers.codex.authenticated, false);
  const response: any = await withUsage({ userId: alice }, () => llmClient(3000).responses.create({ model: defaultModel(), input: 'Original browser is signed out. Use the saved server profile.' }));
  assert.equal(response.provider, 'codex-cli');
  assert.equal(response.billing, 'subscription');
  assert.equal(cliRuntime(alice), 'server');
});

test('credential replacement requires recent authentication', async () => {
  db.prepare('UPDATE auth_sessions SET authenticated_at=? WHERE token=session_hash(?)').run(Date.now()-11*60000,alice);
  assert.equal((await req(alice,'/login','POST',{provider:'codex',cols:80,rows:24})).status,401);
  assert.equal((await req(alice,'/pair','POST',{})).status,401);
});

const credentialMutations = [
  { name: 'login', route: '/login', method: 'POST', body: { provider: 'claude', cols: 80, rows: 24 }, recent: true },
  { name: 'pair creation', route: '/pair', method: 'POST', body: undefined, recent: true },
  { name: 'disconnect', route: '/pair', method: 'DELETE', body: undefined, recent: true },
  // Selecting API mode would remove the existing subscription without an auth
  // refresh, so it also exercises the mutation's initial authorization boundary.
  { name: 'provider selection', route: '', method: 'PUT', body: { provider: null }, recent: false },
] as const;
type CredentialMutation = typeof credentialMutations[number];

async function queuedMutation(userId: string, mutation: CredentialMutation, whileWaiting: () => void | Promise<void> = () => {}) {
  let release!: () => void, acquired!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { acquired = resolve; });
  const holder = withCliMutation(userId, async () => { acquired(); await gate; });
  await entered;
  const oldSeen = Date.now() - 120_000;
  db.prepare('UPDATE auth_sessions SET last_seen_at=? WHERE token=session_hash(?)').run(oldSeen, userId);
  let settled = false;
  const pending = req(userId, mutation.route, mutation.method, mutation.body).finally(() => { settled = true; });
  try {
    await until(() => (db.prepare('SELECT last_seen_at FROM auth_sessions WHERE token=session_hash(?)').get(userId) as any)?.last_seen_at > oldSeen,
      'the request authenticates before its session changes');
    // Let JSON parsing and the auth middleware finish while the lock remains held.
    await delay(0);
    assert.equal(settled, false, 'a valid request must wait behind the held account mutation');
    await whileWaiting();
  } finally {
    release();
    await holder;
  }
  return pending;
}

function seedMutationState(mutation: CredentialMutation) {
  createCliPairing(alice);
  setCliRuntime(alice, mutation.name === 'login' ? 'bridge' : 'server');
  selectCli(alice, 'codex');
  if (mutation.name !== 'login') {
    fs.mkdirSync(profilePath(alice), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(profilePath(alice), 'codex-fake-auth'), 'subscription', { mode: 0o600 });
  }
}

function mutationState(userId: string) {
  const home = profilePath(userId);
  return {
    selected: selectedCli(userId), runtime: cliRuntime(userId),
    savedRuntime: db.prepare('SELECT location FROM cli_runtimes WHERE user_id=?').get(userId),
    pairing: db.prepare('SELECT token_hash,expires_at FROM cli_pairings WHERE user_id=?').get(userId),
    profile: fs.existsSync(home) ? fs.readdirSync(home, { recursive: true }).sort().map(relative => {
      const full = path.join(home, relative), stat = fs.statSync(full);
      return { relative, mode: stat.mode, content: stat.isFile() ? fs.readFileSync(full).toString('base64') : null };
    }) : null,
    cliCalls: audit().length,
  };
}

for (const invalidation of ['revoked', 'expired'] as const) {
  for (const mutation of credentialMutations) {
    test(`queued ${mutation.name} rejects a session ${invalidation} while waiting without changing credentials or routing`, async () => {
      seedMutationState(mutation);
      const before = mutationState(alice);
      try {
        const response = await queuedMutation(alice, mutation, () => {
          if (invalidation === 'revoked') revokeSession(sessionHash(alice));
          else db.prepare('UPDATE auth_sessions SET expires_at=? WHERE token=session_hash(?)').run(Date.now() - 1, alice);
        });
        assert.equal(response.status, 401, await response.clone().text());
        assert.deepEqual(mutationState(alice), before, 'rejected requests cannot create/delete profiles, start a CLI, rotate/revoke pairing, or change selection/runtime');
      } finally { await cancelUserLogins(alice); }
    });
  }
}

for (const mutation of credentialMutations.filter(value => value.recent)) {
  test(`queued ${mutation.name} requires authentication to remain recent while waiting`, async () => {
    seedMutationState(mutation);
    const before = mutationState(alice);
    try {
      const response = await queuedMutation(alice, mutation, () => {
        db.prepare('UPDATE auth_sessions SET authenticated_at=? WHERE token=session_hash(?)').run(Date.now() - 11 * 60_000, alice);
      });
      assert.equal(response.status, 401, await response.clone().text());
      assert.equal((await response.json()).code, 'reauth_required');
      assert.equal((await req(alice)).status, 200, 'the session itself remains valid; only recent authentication aged out');
      assert.deepEqual(mutationState(alice), before);
    } finally { await cancelUserLogins(alice); }
  });
}

test('valid sessions queued behind the same lock can log in, pair, disconnect and select API mode', async () => {
  const [loginMutation, pairMutation, disconnectMutation, selectMutation] = credentialMutations;
  const started = await queuedMutation(alice, loginMutation);
  assert.equal(started.status, 200, await started.clone().text());
  const terminal = await started.json() as Login;
  sessions.set(terminal.id, alice);
  await waitFor(alice, terminal.id, value => value.output.includes('Paste the test authorization code:'), 'an authorized queued login starts the real PTY');
  await input(alice, terminal.id, 'OK\r');
  await waitFor(alice, terminal.id, value => value.state === 'connected', 'the authorized queued login verifies its subscription');
  assert.equal(selectedCli(alice), 'claude');
  const paired = await queuedMutation(alice, pairMutation);
  assert.equal(paired.status, 200, await paired.clone().text());
  assert.match((await paired.json()).command, /--token /);
  assert.ok(db.prepare('SELECT 1 FROM cli_pairings WHERE user_id=?').get(alice));
  assert.equal(cliRuntime(alice), 'bridge');
  // Disconnect the saved server profile, using the same held-lock path.
  setCliRuntime(alice, 'server');
  const disconnected = await queuedMutation(alice, disconnectMutation);
  assert.equal(disconnected.status, 200, await disconnected.clone().text());
  assert.equal(fs.existsSync(profilePath(alice)), false);
  assert.equal(db.prepare('SELECT 1 FROM cli_pairings WHERE user_id=?').get(alice), undefined);
  assert.equal(selectedCli(alice), 'claude', 'disconnect preserves the explicit subscription choice');
  const selected = await queuedMutation(alice, selectMutation);
  assert.equal(selected.status, 200, await selected.clone().text());
  assert.equal(selectedCli(alice), null, 'a still-authorized explicit request may choose API mode');
});

test('revocation during async CLI auth refresh cannot select a verified provider', async () => {
  await login(alice, 'codex');
  const home = profilePath(alice), hold = path.join(home, 'claude-hold-status');
  fs.writeFileSync(path.join(home, 'claude-fake-auth'), 'subscription', { mode: 0o600 });
  fs.writeFileSync(hold, 'wait for session revocation');
  const pending = req(alice, '', 'PUT', { provider: 'claude' });
  try {
    await until(() => audit().some(value => value.kind === 'status-held' && value.provider === 'claude' && value.env.HOME === home),
      'provider selection is awaiting the actual fake CLI authentication probe');
    assert.equal(selectedCli(alice), 'codex');
    revokeSession(sessionHash(alice));
    fs.rmSync(hold);
    const response = await pending;
    assert.equal(response.status, 401, await response.clone().text());
    assert.equal(selectedCli(alice), 'codex', 'a successful auth probe cannot authorize the revoked browser session');
    assert.equal(cliRuntime(alice), 'server');
    assert.equal(db.prepare('SELECT 1 FROM cli_pairings WHERE user_id=?').get(alice), undefined);
    assert.equal(fs.readFileSync(path.join(home, 'codex-fake-auth'), 'utf8'), 'subscription');
    assert.equal(fs.readFileSync(path.join(home, 'claude-fake-auth'), 'utf8'), 'subscription');
    assert.equal(audit().filter(value => value.kind === 'generate').length, 0);
  } finally {
    fs.rmSync(hold, { force: true });
    await pending;
    await cancelUserLogins(alice);
  }
});

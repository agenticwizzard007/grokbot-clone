// node --import tsx --test tests/cli-hosted-concurrency.test.mts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-hosted-concurrency-'));
const auditDir = path.join(temp, 'audit'), gatesDir = path.join(temp, 'gates');
fs.mkdirSync(auditDir); fs.mkdirSync(gatesDir);
const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
const fakeCli = path.join(temp, 'fake-subscription-cli.py');
// Python keeps 36 simultaneously held CLI processes inexpensive. These are real
// executables, reached through hostedGenerate and the unmodified CLI runner.
// Each process writes one atomic audit file; completion requires a test gate.
fs.writeFileSync(fakeCli, `#!${python}
import json, os, pathlib, sys, time
args = sys.argv[1:]
provider = 'codex' if args and args[0] in ('login', 'exec') else 'claude'
home = pathlib.Path(os.environ['HOME'])
audit_dir = pathlib.Path(${JSON.stringify(auditDir)})
gates_dir = pathlib.Path(${JSON.stringify(gatesDir)})
def audit(kind, **fields):
    record = dict(kind=kind, provider=provider, args=args, home=str(home), cwd=os.getcwd(), pid=os.getpid(), env=dict(os.environ), **fields)
    destination = audit_dir / (str(os.getpid()) + '-' + kind + '.json')
    pending = destination.with_suffix('.pending')
    pending.write_text(json.dumps(record))
    pending.replace(destination)
probe = args[:2] in (['login', 'status'], ['auth', 'status'])
if probe:
    audit('auth')
    marker = home / '.fake-subscription'
    subscribed = marker.is_file() and marker.read_text() == 'subscription'
    if provider == 'codex':
        print('Logged in using ChatGPT' if subscribed else 'Not logged in', file=sys.stderr)
    else:
        print(json.dumps(dict(loggedIn=subscribed, authMethod='claude.ai' if subscribed else 'none', subscriptionType='max' if subscribed else None)))
    sys.exit(0 if subscribed else 1)
prompt = sys.stdin.read()
audit('generate', prompt=prompt)
gate = gates_dir / prompt
while not gate.exists(): time.sleep(0.02)
audit('finished', prompt=prompt)
if prompt.endswith('-quota'):
    print('429 subscription quota exceeded auth-secret-sentinel', file=sys.stderr)
    sys.exit(29)
answer = dict(answer=prompt, profile=home.name)
if provider == 'codex':
    pathlib.Path(args[args.index('--output-last-message') + 1]).write_text(json.dumps(answer))
    print(json.dumps(dict(type='turn.completed', usage=dict(input_tokens=3, output_tokens=2))))
else:
    print(json.dumps(dict(type='result', subtype='success', structured_output=answer, usage=dict(input_tokens=3, output_tokens=2))))
`, { mode: 0o700 });

const paidApiRequests: string[] = [];
const sentinel = createServer((req, res) => {
  paidApiRequests.push(`${req.method} ${req.url}`);
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Paid API fallback is forbidden in this test' } }));
});
sentinel.listen(0, '127.0.0.1'); await once(sentinel, 'listening');
const address = sentinel.address(); assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
Object.assign(process.env, {
  NODE_ENV: 'test', SWARM_ROLE: 'standalone', SWARM_CLI_SERVER_LOGIN: '1',
  DB_PATH: path.join(temp, 'test.db'), FILES_DIR: path.join(temp, 'files'), SESSION_SECRET: 'hosted-concurrency-test-only',
  SERVER_URL: base, APP_URL: base, COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', INKBOX_TUNNEL: '0',
  CLI_PROFILES_DIR: path.join(temp, 'profiles'), SWARM_CLI_CODEX_PATH: fakeCli, SWARM_CLI_CLAUDE_PATH: fakeCli,
  DIRECT_API_KEY: 'forbidden-paid-api-secret', DIRECT_BASE_URL: `${base}/direct`, LLM_PROVIDER: 'direct',
  OPENROUTER_API_KEY: 'forbidden-paid-api-secret', OPENROUTER_BASE_URL: `${base}/openrouter`,
  OPENAI_API_KEY: 'forbidden-paid-api-secret', CODEX_API_KEY: 'forbidden-paid-api-secret', ANTHROPIC_API_KEY: 'forbidden-paid-api-secret',
  ANTHROPIC_AUTH_TOKEN: 'forbidden-paid-api-secret', CLAUDE_CODE_OAUTH_TOKEN: 'forbidden-paid-api-secret',
  OPENAI_BASE_URL: `${base}/openai`, ANTHROPIC_BASE_URL: `${base}/anthropic`, HTTPS_PROXY: `${base}/proxy`,
  CODEX_HOME: path.join(temp, 'forbidden-parent-codex'), CLAUDE_CONFIG_DIR: path.join(temp, 'forbidden-parent-claude'),
});

// Deployment, database and hosted modules see only this file's isolated test env.
const { db } = await import('../server/src/db.js');
const { deleteHostedProfile, hostedGenerate, hostedOptions, profilePath, stopHostedJobs } = await import('../server/src/cli/hosted.js');
type Provider = 'codex' | 'claude';
type Audit = { kind: string; provider: Provider; args: string[]; home: string; cwd: string; pid: number; env: Record<string, string>; prompt?: string };
type Outcome = { status: 'fulfilled'; value: any } | { status: 'rejected'; reason: Error };
type Job = { userId: string; prompt: string; controller: AbortController; outcome?: Outcome; done: Promise<Outcome> };
const owners = new Set<string>(), jobs: Job[] = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const audit = (provider: Provider): Audit[] => fs.readdirSync(auditDir).filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(fs.readFileSync(path.join(auditDir, name), 'utf8')) as Audit).filter(record => record.provider === provider);
async function until(check: () => boolean, description: string, timeout = 8000) {
  const expires = Date.now() + timeout;
  while (!check() && Date.now() < expires) await delay(10);
  assert.ok(check(), description);
}
const schema = { type: 'object', properties: { answer: { type: 'string' }, profile: { type: 'string' } }, required: ['answer', 'profile'], additionalProperties: false };
const params = (provider: Provider, prompt: string) => ({ provider, prompt, schema, timeoutMs: 20000 });
function launch(userId: string, provider: Provider, prompt: string): Job {
  const job = { userId, prompt, controller: new AbortController() } as Job;
  job.done = hostedGenerate(userId, params(provider, prompt), job.controller.signal).then(
    value => job.outcome = { status: 'fulfilled', value },
    reason => job.outcome = { status: 'rejected', reason },
  );
  jobs.push(job);
  return job;
}
function rejected(job: Job, pattern: RegExp) {
  assert.equal(job.outcome?.status, 'rejected', `${job.prompt} must reject`);
  const outcome = job.outcome as Extract<Outcome, { status: 'rejected' }>;
  assert.match(outcome.reason.message, pattern);
  assert.doesNotMatch(outcome.reason.message, /auth-secret-sentinel|forbidden-paid-api-secret/);
}

after(async () => {
  for (const userId of owners) stopHostedJobs(userId);
  await Promise.all(jobs.map(job => job.done));
  for (const userId of owners) await deleteHostedProfile(userId);
  await new Promise<void>(resolve => sentinel.close(() => resolve()));
  db.close(); fs.rmSync(temp, { recursive: true, force: true });
  assert.deepEqual(paidApiRequests, [], 'no configured paid endpoint may be called, including after quota and authentication failures');
});

for (const provider of ['codex', 'claude'] as const) test(`${provider}: hostedGenerate starts 36 held jobs, with independent request and account cancellation`, { timeout: 30000 }, async () => {
  const alice = `usr_hosted_${provider}_alice`, bob = `usr_hosted_${provider}_bob`;
  for (const userId of [alice, bob]) {
    owners.add(userId);
    db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, userId, Date.now());
    const options = await hostedOptions(userId);
    assert.equal(options.fileCredentials, true);
    fs.writeFileSync(path.join(options.env.HOME!, '.fake-subscription'), 'subscription', { mode: 0o600 });
  }
  const aliceHome = profilePath(alice), bobHome = profilePath(bob);
  assert.notEqual(aliceHome, bobHome);
  const aliceJobs = Array.from({ length: 18 }, (_, i) => launch(alice, provider, `${provider}-alice-${i}`));
  const bobJobs = Array.from({ length: 18 }, (_, i) => launch(bob, provider, i ? `${provider}-bob-${i}` : `${provider}-bob-quota`));
  const batch = [...aliceJobs, ...bobJobs];
  try {
    await until(() => audit(provider).filter(record => record.kind === 'generate').length === 36,
      'all 36 hosted CLI processes start before any release, exceeding both the former per-account 4 and global 32 caps');
    const records = audit(provider), running = records.filter(record => record.kind === 'generate');
    assert.equal(running.filter(record => record.home === aliceHome).length, 18);
    assert.equal(running.filter(record => record.home === bobHome).length, 18);
    assert.equal(records.filter(record => record.kind === 'auth').length, 36, 'every overlapping job validates subscription auth');
    assert.equal(records.some(record => record.kind === 'finished'), false, 'no earlier job completes to free a capacity slot');
    assert.ok(batch.every(job => !job.outcome), 'there are no busy/capacity rejections or completed jobs');
    assert.deepEqual(fs.readdirSync(gatesDir), [], 'every generation is held behind an unopened test gate');
    for (const record of running) {
      assert.equal(record.env.CODEX_HOME, path.join(record.home, '.codex'));
      assert.equal(record.env.CLAUDE_CONFIG_DIR, path.join(record.home, '.claude'));
      assert.doesNotMatch(JSON.stringify(record.env), /forbidden-paid-api-secret|forbidden-parent|127\.0\.0\.1/);
      if (provider === 'codex') for (const flag of ['forced_login_method="chatgpt"', 'model_provider="openai"', 'cli_auth_credentials_store="file"']) assert.ok(record.args.includes(flag));
      else assert.equal(record.args[record.args.indexOf('--tools') + 1], '');
    }

    aliceJobs[0].controller.abort(); await aliceJobs[0].done;
    rejected(aliceJobs[0], /cancelled/i);
    assert.ok(batch.slice(1).every(job => !job.outcome), 'cancelling one request leaves every same-account and other-account peer held');
    for (const record of running.filter(record => record.prompt !== aliceJobs[0].prompt)) process.kill(record.pid, 0);
    const cancelledRecord = running.find(record => record.prompt === aliceJobs[0].prompt)!;
    assert.equal(fs.existsSync(cancelledRecord.cwd), false, 'request cancellation cleans its own temporary cwd');

    fs.writeFileSync(path.join(gatesDir, bobJobs[0].prompt), 'release');
    await bobJobs[0].done; rejected(bobJobs[0], /subscription rate limit/i);
    assert.ok([...aliceJobs.slice(1), ...bobJobs.slice(1)].every(job => !job.outcome), 'provider quota failure neither completes nor cancels siblings');
    assert.deepEqual(paidApiRequests, []);

    // Exercise the actual hosted disconnect lifecycle, not a mocked abort map.
    await deleteHostedProfile(alice);
    await Promise.all(aliceJobs.map(job => job.done));
    for (const job of aliceJobs) rejected(job, /cancelled/i);
    assert.equal(fs.existsSync(aliceHome), false, 'disconnect removes only its own account profile after cancelling its jobs');
    assert.equal(fs.readFileSync(path.join(bobHome, '.fake-subscription'), 'utf8'), 'subscription');
    assert.ok(bobJobs.slice(1).every(job => !job.outcome), 'other-account jobs remain held after disconnect');
    for (const record of running.filter(record => record.home === aliceHome)) assert.equal(fs.existsSync(record.cwd), false);
    for (const record of running.filter(record => record.home === bobHome && record.prompt !== bobJobs[0].prompt)) {
      process.kill(record.pid, 0); assert.equal(fs.existsSync(record.cwd), true);
    }

    await assert.rejects(hostedGenerate(alice, params(provider, `${provider}-after-disconnect`)), /subscription login/i);
    assert.equal(audit(provider).filter(record => record.kind === 'generate').length, 36, 'missing auth does not start another CLI generation or retry');
    for (const job of bobJobs.slice(1)) fs.writeFileSync(path.join(gatesDir, job.prompt), 'release');
    await Promise.all(bobJobs.slice(1).map(job => job.done));
    for (const job of bobJobs.slice(1)) {
      assert.equal(job.outcome?.status, 'fulfilled', `${job.prompt} still completes independently`);
      const result = (job.outcome as Extract<Outcome, { status: 'fulfilled' }>).value;
      assert.deepEqual(JSON.parse(result.text), { answer: job.prompt, profile: path.basename(bobHome) });
      assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 2 });
    }
    const final = audit(provider);
    assert.equal(final.filter(record => record.kind === 'generate').length, 36, 'quota and disconnect never cause retries or paid API fallback');
    assert.equal(final.filter(record => record.kind === 'finished' && record.home === bobHome).length, 18);
    assert.equal(final.some(record => record.kind === 'finished' && record.home === aliceHome), false);
    assert.deepEqual(paidApiRequests, []);
    for (const record of running) assert.equal(fs.existsSync(record.cwd), false, 'all completed/cancelled jobs clean their temporary cwd');
  } finally {
    stopHostedJobs(alice); stopHostedJobs(bob);
    await Promise.all(batch.map(job => job.done));
    // Clear gates so the next provider must prove it also starts before release.
    for (const name of fs.readdirSync(gatesDir)) fs.rmSync(path.join(gatesDir, name));
  }
});

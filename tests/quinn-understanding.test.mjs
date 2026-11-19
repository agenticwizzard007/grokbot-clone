import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { SCENARIOS, fixtureAnswer, gradeAnswer, scenarioPrompt, answerSchema, hash } from '../scripts/quinn-understanding-cases.mjs';
import { Unavailable, assertSubscription, makeRequest, runUnderstanding, validateUnderstandingConfig, httpPreflight } from '../scripts/qualify-quinn-understanding.mjs';
const config = () => ({ version: 1, target: { kind: 'dedicated-staging', origin: 'https://quinn-staging.example', approvedOrigin: 'https://quinn-staging.example', appId: 'reviewed-quinn-staging', imageDigest: 'sha256:' + 'a'.repeat(64), dbPath: '/private/staging/app.db' }, account: { userId: 'usr_quinn_staging_01', botId: 'bot_staging_quinn', sessionFile: '/private/staging/session', provider: 'codex', runtime: 'server', model: 'codex/explicit-catalog-model', effort: 'medium' }, approval: { reference: 'fixture-test-only', disposableAccount: true }, allowApiFallback: false, budget: { maxInvocations: 4, maxMinutes: 2, requestTimeoutSeconds: 20, maxOutputTokens: 2000 }, evidenceDir: '/private/staging/quinn-evidence' });
const adapter = (overrides = {}) => {
  let generated = 0;
  return { preflight: async () => {}, checkRoute: async () => {}, generate: async () => { const scenario = SCENARIOS[generated++]; return { text: JSON.stringify(fixtureAnswer(scenario)), billing: 'subscription', provider: 'codex-cli', runtime: 'server', model: 'codex/actual-observed-model', usageStatus: 'unavailable' }; }, ...overrides };
};

test('frozen known answers pass all four scenario graders and remain stable', () => {
  assert.deepEqual(SCENARIOS.map(s => s.id), ['coverage-and-unknowns', 'specialist-human-sources', 'decisions-and-exact-revisions', 'stale-state-and-uncertain-effects']);
  for (const scenario of SCENARIOS) {
    assert.equal(gradeAnswer(scenario, fixtureAnswer(scenario)).passed, true);
    assert.equal(gradeAnswer(scenario, JSON.stringify(fixtureAnswer(scenario))).correct, scenario.questions.length);
    assert.equal(hash(scenarioPrompt(scenario)), hash(scenarioPrompt(structuredClone(scenario))));
  }
});

test('grader rejects every incorrect classification, missing/extra answers and invalid JSON', () => {
  for (const scenario of SCENARIOS) {
    for (const q of scenario.questions) {
      const answer = fixtureAnswer(scenario); answer[q.id].answer = q.options.find(option => option !== q.expected.answer);
      assert.equal(gradeAnswer(scenario, answer).passed, false, scenario.id + ':' + q.id);
    }
    const missing = fixtureAnswer(scenario); delete missing[scenario.questions[0].id]; assert.equal(gradeAnswer(scenario, missing).passed, false);
    const extra = { ...fixtureAnswer(scenario), unsupported_claim: { answer: 'everything succeeded', sources: [] } }; assert.equal(gradeAnswer(scenario, extra).passed, false);
    assert.equal(gradeAnswer(scenario, '```json\n{}\n```').passed, false);
    assert.equal(gradeAnswer(scenario, null).passed, false);
  }
});

test('grader rejects fabricated, stale, missing and duplicate citations even when the answer is correct', () => {
  for (const scenario of SCENARIOS) {
    const q = scenario.questions[0];
    for (const citations of [[], ['fabricated-source'], [...q.expected.sources, ...q.expected.sources], [...q.expected.sources, scenario.records.at(-1).id]]) {
      const answer = fixtureAnswer(scenario); answer[q.id].sources = citations;
      assert.equal(gradeAnswer(scenario, answer).passed, false);
    }
    const answer = fixtureAnswer(scenario); answer[q.id].explanation = 'I already sent the report.';
    assert.equal(gradeAnswer(scenario, answer).passed, false, 'ungraded narrative claims are forbidden');
  }
  const stale = fixtureAnswer(SCENARIOS[3]); stale.current_outcome.sources = ['old-projection'];
  assert.equal(gradeAnswer(SCENARIOS[3], stale).passed, false);
});

test('model prompts omit the answer key and provide only frozen input; requests have zero tools', () => {
  for (const scenario of SCENARIOS) {
    const prompt = JSON.parse(scenarioPrompt(scenario));
    assert.equal(prompt.questions.some(q => Object.hasOwn(q, 'expected')), false);
    const request = makeRequest(scenario, config());
    assert.deepEqual(request.tools, []); assert.equal(request.tool_choice, 'none'); assert.equal(request.stream, false);
    assert.deepEqual(request.text.format.schema, answerSchema(scenario)); assert.equal(request.model, config().account.model);
    assert.equal(request.max_output_tokens, config().budget.maxOutputTokens);
  }
});

test('configuration requires reviewed exact staging identity, current server subscription, no fallback and a strict bound', () => {
  assert.equal(validateUnderstandingConfig(config()).account.provider, 'codex');
  for (const mutate of [c => c.target.kind = 'production', c => c.target.origin = 'https://swarm-team.fly.dev', c => c.target.approvedOrigin = 'https://other.example', c => c.target.dbPath = './app.db', c => c.account.sessionFile = 'session', c => c.account.provider = 'direct', c => c.account.runtime = 'bridge', c => c.account.model = 'claude/wrong-route', c => c.account.model = 'codex/default', c => c.allowApiFallback = true, c => c.approval.disposableAccount = false, c => c.budget.maxInvocations = 100, c => c.budget.requestTimeoutSeconds = 1000]) {
    const c = config(); mutate(c); assert.throws(() => validateUnderstandingConfig(c), Unavailable);
  }
});

test('missing or changed selected subscription refuses generation without a paid fallback', async () => {
  const c = config();
  const valid = { selected: 'codex', runtime: 'server', connected: true, providers: { codex: { installed: true, authenticated: true, subscription: true } } };
  assert.doesNotThrow(() => assertSubscription(valid, c.account));
  for (const wrong of [{ ...valid, selected: null }, { ...valid, selected: 'claude' }, { ...valid, runtime: 'bridge' }, { ...valid, connected: false }, { ...valid, providers: {} }]) assert.throws(() => assertSubscription(wrong, c.account), Unavailable);
  let calls = 0;
  const report = await runUnderstanding({ config: c, adapter: adapter({ checkRoute: async () => { throw new Unavailable('selected-subscription-unavailable-no-fallback'); }, generate: async () => { calls++; } }) });
  assert.equal(report.status, 'unavailable'); assert.equal(report.liveModelQualified, false); assert.equal(calls, 0); assert.equal(report.modelInvocations, 0);
});

test('budget is reserved and pending evidence saved before each model call; successful receipts retain observed model', async () => {
  const trace = [], c = config();
  const real = adapter(), original = real.generate;
  real.generate = async (...args) => { trace.push('generate'); return original(...args); };
  const report = await runUnderstanding({ config: c, adapter: real, consume: async () => trace.push('reserve'), persist: async report => { if (report.cases.at(-1)?.status === 'submitted') trace.push('submitted'); } });
  assert.equal(report.status, 'pass'); assert.equal(report.liveModelQualified, true); assert.equal(report.releaseQualified, false);
  assert.equal(report.modelInvocations, 4); assert.deepEqual(trace, Array.from({ length: 4 }, () => ['reserve', 'submitted', 'generate']).flat());
  assert.equal(report.cases[0].observed.model, 'codex/actual-observed-model'); assert.equal(report.cases[0].observed.usageStatus, 'unavailable'); assert.equal(report.cases[0].observed.usage, null);
});

test('failed or uncertain provider requests are consumed once, redacted, and never retried', async () => {
  let calls = 0, reserved = 0;
  const report = await runUnderstanding({ config: config(), adapter: adapter({ generate: async () => { calls++; throw new Error('SECRET_PROVIDER_TOKEN'); } }), consume: async () => { reserved++; } });
  assert.equal(calls, 1); assert.equal(reserved, 1); assert.equal(report.modelInvocations, 1);
  assert.equal(report.liveModelQualified, false); assert.equal(report.status, 'error'); assert.equal(report.unrunScenarios.length, 3);
  assert.ok(!JSON.stringify(report).includes('SECRET_PROVIDER_TOKEN'));
});

test('API billing, route mismatch and unexpected tool requests cannot qualify a live model', async () => {
  for (const fields of [{ billing: 'api' }, { provider: 'claude-cli' }, { runtime: 'bridge' }, { model: 'openai/api-model' }, { toolCalls: [{ name: 'send_message' }] }]) {
    let calls = 0;
    const report = await runUnderstanding({ config: config(), adapter: adapter({ generate: async () => { calls++; return { text: JSON.stringify(fixtureAnswer(SCENARIOS[0])), billing: 'subscription', provider: 'codex-cli', runtime: 'server', model: 'codex/model', ...fields }; } }) });
    assert.equal(report.liveModelQualified, false); assert.equal(report.status, 'unavailable'); assert.equal(calls, 1);
  }
});

test('time expiration cannot submit another model request', async () => {
  let clock = 0, calls = 0;
  const report = await runUnderstanding({ config: config(), adapter: adapter({ preflight: async () => { clock = 999999; }, generate: async () => { calls++; } }), now: () => clock });
  assert.equal(report.status, 'unavailable'); assert.equal(report.code, 'run-time-budget-exhausted'); assert.equal(calls, 0);
});

test('known-answer dry runs make no provider calls and never claim live qualification', async () => {
  let calls = 0;
  const report = await runUnderstanding({ fixture: true, adapter: adapter({ generate: async () => { calls++; } }) });
  assert.equal(report.status, 'simulated_pass'); assert.equal(report.scope, 'simulated-harness-self-test'); assert.equal(report.modelInvocations, 0);
  assert.equal(report.liveModelQualified, false); assert.equal(report.releaseQualified, false); assert.equal(calls, 0);
});

test('missing credential files produce unavailable before any network request', async () => {
  let calls = 0;
  await assert.rejects(httpPreflight(config(), async () => { calls++; throw new Error('Network must not run'); }), error => error.code === 'private-staging-session-unavailable');
  assert.equal(calls, 0);
});

test('CLI dry run and absent-config live gate leave inspectable private receipts without credentials', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quinn-understanding-'));
  try {
    const dry = spawnSync(process.execPath, ['scripts/qualify-quinn-understanding.mjs', '--dry-run', '--evidence-dir', path.join(directory, 'dry')], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    const dryReceipt = JSON.parse(dry.stdout); assert.equal(dryReceipt.liveModelQualified, false); assert.equal(dryReceipt.status, 'simulated_pass');
    const report = JSON.parse(await fs.readFile(dryReceipt.evidence, 'utf8')); assert.equal(report.cases.length, 4); assert.ok(report.cases.every(entry => entry.grade.passed));
    const unavailable = spawnSync(process.execPath, ['scripts/qualify-quinn-understanding.mjs', '--execute', '--evidence-dir', path.join(directory, 'absent')], { encoding: 'utf8' });
    assert.equal(unavailable.status, 2, unavailable.stderr);
    const receipt = JSON.parse(unavailable.stdout); assert.equal(receipt.status, 'unavailable'); assert.equal(receipt.code, 'staging-configuration-required'); assert.equal(receipt.modelInvocations, 0);
    assert.equal((await fs.stat(receipt.evidence)).mode & 0o077, 0); assert.equal((await fs.stat(path.dirname(receipt.evidence))).mode & 0o077, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

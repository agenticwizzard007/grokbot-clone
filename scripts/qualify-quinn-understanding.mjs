#!/usr/bin/env node
// One structured, tool-free model invocation per frozen scenario. No chat jobs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { GateError, Api, privateFile } from './qualify-providers.mjs';
import { SUITE_VERSION, SCENARIOS, hash, SYSTEM_INSTRUCTIONS, scenarioPrompt, answerSchema, fixtureAnswer, gradeAnswer } from './quinn-understanding-cases.mjs';
export class Unavailable extends GateError { constructor(code) { super(code, true); } }
const need = (condition, code) => { if (!condition) throw new Unavailable(code); };
export function validateUnderstandingConfig(config) {
  need(config?.version === 1 && config.target?.kind === 'dedicated-staging', 'dedicated-staging-required');
  let origin; try { origin = new URL(config.target.origin); } catch { throw new Unavailable('staging-origin-required'); }
  need(origin.protocol === 'https:' && !origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname === '/' && origin.origin === config.target.origin && origin.origin === config.target.approvedOrigin, 'exact-approved-https-staging-origin-required');
  need(!['swarm-team.fly.dev', 'grokbot-team.fly.dev', 'localhost'].includes(origin.hostname) && !/^127\./.test(origin.hostname), 'production-or-loopback-forbidden');
  need(typeof config.target.appId === 'string' && config.target.appId.length > 0 && /^sha256:[a-f0-9]{64}$/.test(config.target.imageDigest), 'staging-inventory-required');
  need(path.isAbsolute(config.target.dbPath ?? ''), 'explicit-staging-database-required');
  need(config.approval?.disposableAccount === true && typeof config.approval.reference === 'string' && config.approval.reference.length > 0, 'reviewed-staging-account-required');
  const account = config.account;
  need(account && typeof account.userId === 'string' && typeof account.botId === 'string' && /^[-_a-zA-Z0-9]{1,200}$/.test(account.userId) && /^[-_a-zA-Z0-9]{1,200}$/.test(account.botId) && path.isAbsolute(account.sessionFile ?? ''), 'explicit-account-and-private-session-required');
  need(['codex', 'claude'].includes(account.provider) && account.runtime === 'server' && config.allowApiFallback === false, 'selected-server-subscription-required-no-api-fallback');
  need(typeof account.model === 'string' && account.model.startsWith(account.provider + '/') && account.model.length <= 120 && account.model !== account.provider + '/default', 'explicit-subscription-model-required');
  need(account.effort === undefined || ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(account.effort), 'valid-model-effort-required');
  need(config.budget?.maxInvocations === SCENARIOS.length && Number.isInteger(config.budget.maxMinutes) && config.budget.maxMinutes >= 1 && config.budget.maxMinutes <= 10 && Number.isInteger(config.budget.requestTimeoutSeconds) && config.budget.requestTimeoutSeconds >= 5 && config.budget.requestTimeoutSeconds <= 120 && Number.isInteger(config.budget.maxOutputTokens) && config.budget.maxOutputTokens >= 256 && config.budget.maxOutputTokens <= 4096, 'bounded-four-invocation-budget-required');
  need(path.isAbsolute(config.evidenceDir ?? ''), 'absolute-private-evidence-directory-required');
  return config;
}
export function assertSubscription(status, account) {
  const selected = status?.providers?.[account.provider];
  need(status?.selected === account.provider && status.runtime === account.runtime && status.connected === true && selected?.installed === true && selected.authenticated === true && selected.subscription === true && !selected.error, 'selected-subscription-unavailable-no-fallback');
}
export function makeRequest(scenario, config) {
  return { model: config.account.model, stream: false, tools: [], tool_choice: 'none', max_output_tokens: config.budget.maxOutputTokens,
    ...(config.account.effort ? { reasoning: { effort: config.account.effort } } : {}),
    text: { format: { type: 'json_schema', name: 'quinn_understanding', strict: true, schema: answerSchema(scenario) } },
    input: [{ role: 'system', content: [{ type: 'input_text', text: SYSTEM_INSTRUCTIONS }] }, { role: 'user', content: [{ type: 'input_text', text: scenarioPrompt(scenario) }] }] };
}
export function newReport(config, fixture = false) {
  return { version: 1, suite: SUITE_VERSION, suiteHash: hash(SCENARIOS), runId: randomUUID(), startedAt: new Date().toISOString(), scope: fixture ? 'simulated-harness-self-test' : 'frozen-scenarios-live-subscription',
    target: config ? { origin: config.target.origin, appId: config.target.appId, expectedImageDigest: config.target.imageDigest, imageIdentity: 'operator-supplied-not-remotely-attested', userId: config.account.userId, botId: config.account.botId, requestedProvider: config.account.provider, requestedModel: config.account.model } : null,
    approvalReference: config?.approval.reference ?? null, status: 'not_run', cases: [], modelInvocations: 0, liveModelQualified: false, releaseQualified: false };
}
export async function runUnderstanding({ config, adapter, fixture = false, persist = async () => {}, consume = async () => {}, report = newReport(config, fixture), now = Date.now, deadline = now() + (config?.budget.maxMinutes ?? 1) * 60000 }) {
  try {
    if (!fixture) { validateUnderstandingConfig(config); need(adapter, 'live-subscription-adapter-unavailable'); await adapter.preflight(); }
    for (const scenario of SCENARIOS) {
      need(now() < deadline, 'run-time-budget-exhausted');
      const entry = { id: scenario.id, status: 'pending', prompt: scenarioPrompt(scenario), promptHash: hash(scenarioPrompt(scenario)), schema: answerSchema(scenario) };
      report.cases.push(entry); await persist(report);
      let response;
      if (fixture) response = { text: JSON.stringify(fixtureAnswer(scenario)), source: 'known-answer-fixture' };
      else {
        await adapter.checkRoute();
        await consume(); report.modelInvocations++; entry.status = 'submitted'; await persist(report);
        const timeout = Math.min(config.budget.requestTimeoutSeconds * 1000, deadline - now()); need(timeout > 0, 'run-time-budget-exhausted');
        response = await adapter.generate(makeRequest(scenario, config), AbortSignal.timeout(timeout));
        await adapter.checkRoute();
        entry.observed = { billing: response?.billing ?? null, provider: response?.provider ?? null, runtime: response?.runtime ?? null, model: response?.model ?? null };
        need(response?.billing === 'subscription' && response.provider === config.account.provider + '-cli' && response.runtime === config.account.runtime && typeof response.model === 'string' && response.model.startsWith(config.account.provider + '/'), 'subscription-receipt-unverifiable-no-fallback');
        need(!response.toolCalls?.length, 'unexpected-tool-request-no-dispatch');
      }
      need(typeof response.text === 'string' && Buffer.byteLength(response.text) <= 32768, 'bounded-model-response-required');
      entry.response = response.text; entry.responseHash = hash(response.text);
      entry.observed = fixture ? { source: 'known-answer-fixture' } : { billing: response.billing, provider: response.provider, runtime: response.runtime, model: response.model, usageStatus: response.usageStatus ?? 'unavailable', usage: response.usage ?? null };
      entry.grade = gradeAnswer(scenario, response.text); entry.status = entry.grade.passed ? 'pass' : 'fail'; await persist(report);
    }
    const passed = report.cases.length === SCENARIOS.length && report.cases.every(entry => entry.status === 'pass');
    report.status = fixture ? passed ? 'simulated_pass' : 'simulated_fail' : passed ? 'pass' : 'fail';
    report.liveModelQualified = !fixture && passed;
  } catch (error) {
    report.status = error instanceof GateError && error.incomplete ? 'unavailable' : 'error';
    report.code = error instanceof GateError ? error.code : 'invocation-failed-no-automatic-retry-details-redacted';
    const last = report.cases.at(-1); if (last && ['pending', 'submitted'].includes(last.status)) { last.status = report.status; last.code = report.code; }
  }
  report.finishedAt = new Date().toISOString();
  report.unrunScenarios = SCENARIOS.filter(s => !report.cases.some(entry => entry.id === s.id)).map(s => s.id);
  await persist(report); return report;
}
export async function httpPreflight(config, fetcher = fetch, deadline = Date.now() + config.budget.maxMinutes * 60000) {
  let cookie; try { cookie = await privateFile(config.account.sessionFile); } catch { throw new Unavailable('private-staging-session-unavailable'); }
  const api = new Api(config.target.origin, cookie, fetcher);
  api.deadline = deadline;
  const health = await api.json('/api/health'); need(health.ok === true && ['platform', 'tenant'].includes(health.role), 'isolated-staging-platform-required');
  const me = await api.json('/api/auth/me'); need(me.user?.id === config.account.userId, 'staging-session-account-mismatch');
  const inventory = await api.json('/api/bots');
  const bot = inventory.bots?.find(bot => bot.id === config.account.botId);
  const live = inventory.live?.find(state => state.botId === config.account.botId);
  need(bot?.isPrimary === true && live?.isRunning === false && !live.awaiting, 'idle-owned-primary-required');
  const checkRoute = async () => assertSubscription(await api.json('/api/cli'), config.account);
  await checkRoute(); return checkRoute;
}
async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory); need(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.(), 'private-evidence-directory-required');
}
const save = async (filename, value) => { const temp = filename + '.new'; await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await fs.rename(temp, filename); };
export async function main(args = process.argv.slice(2)) {
  const opts = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (['--execute', '--dry-run', '--help'].includes(name)) opts[name.slice(2)] = true;
    else if (['--config', '--evidence-dir'].includes(name) && args[index + 1] && !args[index + 1].startsWith('--')) opts[name.slice(2)] = args[++index];
    else throw new Unavailable('unknown-or-incomplete-command-option');
  }
  if (opts.help || !opts.execute && !opts['dry-run'] && !opts.config) { console.log('node --import tsx scripts/qualify-quinn-understanding.mjs --config /private/quinn-staging.json [--execute]\nnode scripts/qualify-quinn-understanding.mjs --dry-run [--evidence-dir /private/results]\nWithout --execute, no network or model calls. See docs/quinn-understanding-qualification.md.'); return; }
  need(!(opts.execute && opts['dry-run']), 'choose-live-or-fixture-mode');
  let config, report, lock;
  const directory = path.resolve(opts['evidence-dir'] ?? path.join('.context', 'quinn-understanding', randomUUID()));
  let evidenceDir = directory;
  try {
    if (opts.config) { const source = await fs.readFile(opts.config, 'utf8'); need(Buffer.byteLength(source) <= 65536, 'bounded-config-required'); config = validateUnderstandingConfig(JSON.parse(source)); evidenceDir = config.evidenceDir; }
    await privateDirectory(evidenceDir);
    const lockPath = path.join(evidenceDir, 'running.lock'); lock = { path: lockPath, handle: await fs.open(lockPath, 'wx', 0o600) };
    const persist = value => save(path.join(evidenceDir, `${value.runId}.json`), value);
    report = newReport(config, !!opts['dry-run']);
    if (opts['dry-run']) await runUnderstanding({ fixture: true, report, persist });
    else if (!opts.execute) { report.status = 'configuration_validated'; report.finishedAt = new Date().toISOString(); await persist(report); }
    else {
      need(config, 'staging-configuration-required');
      const journalPath = path.join(evidenceDir, 'budget.json'), identity = hash({ config, suite: SUITE_VERSION, suiteHash: hash(SCENARIOS) });
      let journal;
      try { journal = JSON.parse(await fs.readFile(journalPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; journal = { identity, invocations: 0 }; }
      need(journal.identity === identity && Number.isSafeInteger(journal.invocations) && journal.invocations >= 0, 'budget-journal-mismatch');
      const consume = async () => { need(journal.invocations < config.budget.maxInvocations, 'invocation-budget-exhausted'); journal.invocations++; await save(journalPath, journal); };
      const { createLiveUnderstandingAdapter } = await import('./quinn-understanding-live.mts');
      const deadline = Date.parse(report.startedAt) + config.budget.maxMinutes * 60000;
      const adapter = await createLiveUnderstandingAdapter(config, deadline);
      await runUnderstanding({ config, adapter, report, persist, consume, deadline });
    }
  } catch (error) {
    report ??= newReport(config, !!opts['dry-run']); report.status = 'unavailable'; report.code = error instanceof GateError ? error.code : 'qualification-unavailable-details-redacted'; report.finishedAt = new Date().toISOString();
    // Failure receipts contain no tokens, cookie paths, provider stderr or raw exceptions.
    await privateDirectory(evidenceDir); await save(path.join(evidenceDir, `${report.runId}.json`), report);
  } finally { if (lock) { await lock.handle.close(); await fs.unlink(lock.path); } }
  console.log(JSON.stringify({ status: report.status, code: report.code ?? null, modelInvocations: report.modelInvocations, liveModelQualified: report.liveModelQualified, releaseQualified: false, evidence: path.join(evidenceDir, `${report.runId}.json`) }));
  if (['unavailable', 'error', 'fail', 'simulated_fail'].includes(report.status)) process.exitCode = report.status === 'unavailable' ? 2 : 1;
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => { console.error('qualification-unavailable-details-redacted'); process.exitCode = 2; });

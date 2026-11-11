#!/usr/bin/env node
// Node 22+, no packages. Credentials stay in the CLIs' normal home/keychain stores.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StringDecoder } from 'node:string_decoder';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TIMEOUT_MS = 15 * 60_000;
const AUTH_TIMEOUT_MS = 15_000;
const LABEL = { codex: 'Codex', claude: 'Claude' };
const CLAUDE_PLANS = new Set(['pro', 'max', 'ultra', 'team', 'enterprise']);
// auth status uses machine values ("max"), while initialize can return a
// display label ("Claude Ultra"). Accept only those same known subscription
// tiers; the separate auth probe must still prove claude.ai subscription auth.
const claudeCatalogPlan = value => typeof value === 'string' && CLAUDE_PLANS.has(value.trim().toLowerCase().replace(/^claude /, ''));
const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

class RunnerError extends Error {
  constructor(message, code = 'runner') { super(message); this.name = 'RunnerError'; this.code = code; }
}
const cancelled = () => new RunnerError('Request cancelled.', 'cancelled');
function aborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof RunnerError ? signal.reason : cancelled();
}
function safeError(error) {
  // Never forward CLI diagnostics, exception stacks, auth JSON, or local paths.
  return error instanceof RunnerError ? error.message : 'CLI bridge request failed.';
}

function childEnvironment(source = process.env) {
  // An allowlist also strips future API keys, OAuth tokens, endpoint/provider overrides,
  // NODE_OPTIONS/preloads, shell startup files, proxy settings, and nested-agent state.
  const keep = /^(PATH|HOME|USER|LOGNAME|USERPROFILE|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|PROGRAMDATA|TMPDIR|TMP|TEMP|LANG|LC_[A-Z_]+|XDG_CONFIG_HOME|XDG_DATA_HOME|XDG_STATE_HOME|XDG_CACHE_HOME|CODEX_HOME|CLAUDE_CONFIG_DIR)$/i;
  const env = Object.fromEntries(Object.entries(source).filter(([key, value]) => keep.test(key) && typeof value === 'string'));
  return { ...env, NO_COLOR: '1', TERM: 'dumb', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}

async function deadline(signal, timeoutMs, work) {
  aborted(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason instanceof RunnerError ? signal.reason : cancelled());
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new RunnerError('CLI request timed out.', 'timeout')), timeoutMs);
  try { return await work(controller.signal); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
}

function killTree(child, force) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // This command is fixed locally; server input can never select an executable.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', env: childEnvironment() });
    killer.on('error', () => { try { child.kill(); } catch {} });
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch { try { child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
  }
}

function execute(executable, args, { cwd, env, signal, input = '', onStdout }) {
  aborted(signal);
  return new Promise((resolveResult, reject) => {
    let child;
    try {
      child = spawn(executable, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch { reject(new RunnerError('CLI executable could not be started.', 'unavailable')); return; }
    const stdout = [], stderr = [];
    let bytes = 0, failure, killTimer, settled = false, intercepted = false;
    const terminate = () => {
      child.stdin.destroy();
      killTree(child, false);
      // Cancellation may arrive while a captured action is shutting down.
      // Keep a single escalation timer, owned and cleared by this request.
      if (!killTimer) killTimer = setTimeout(() => killTree(child, true), 200);
    };
    const stop = (error) => {
      if (failure || settled) return;
      failure = error;
      terminate();
    };
    const onAbort = () => stop(signal.reason instanceof RunnerError ? signal.reason : cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
    // Covers an abort between the initial check and registering the listener.
    if (signal?.aborted) onAbort();
    const collect = (parts, inspect) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) stop(new RunnerError('CLI output exceeded the 8 MB limit.', 'output_limit'));
      else if (!failure) {
        parts.push(chunk);
        if (inspect && !intercepted) {
          try {
            if (inspect(chunk) === true) {
              intercepted = true;
              terminate();
            }
          } catch { stop(new RunnerError('Invalid CLI action event.')); }
        }
      }
    };
    child.stdout.on('data', collect(stdout, onStdout));
    child.stderr.on('data', collect(stderr));
    child.stdout.on('error', () => stop(new RunnerError('Could not read CLI output.')));
    child.stderr.on('error', () => stop(new RunnerError('Could not read CLI output.')));
    child.stdin.on('error', () => { if (!intercepted) stop(new RunnerError('CLI closed its prompt input unexpectedly.', 'stdin')); });
    child.once('error', (error) => stop(new RunnerError(error.code === 'ENOENT' ? 'CLI executable is not installed.' : 'CLI executable could not be started.', 'unavailable')));
    // A child may exit while descendants still hold its pipes. Kill the entire group
    // on both success and failure; never let a detached descendant outlive a request.
    child.once('exit', () => killTree(child, true));
    child.once('close', (code) => {
      settled = true;
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      killTree(child, true);
      if (failure) reject(failure);
      else resolveResult({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), bytes, intercepted });
    });
    if (!failure) child.stdin.end(input);
  });
}

function diagnostic(provider, output, fallback) {
  if (/prompt was flagged as potentially violating (?:our|the) usage policy|\b(?:content|safety)_policy_violation\b/i.test(output)) {
    return new RunnerError(`${LABEL[provider]} declined this request under its usage policy. Review the request in the official CLI. No API fallback was used.`, 'policy');
  }
  if (/rate.?limit|too many requests|\b429\b|quota.{0,30}(?:exceed|reach)|(?:usage|subscription) limit|hit your limit/i.test(output)) {
    return new RunnerError(`${LABEL[provider]} subscription rate limit reached. Try again later.`, 'rate_limit');
  }
  if (/unauthenticated|not (?:logged|signed) in|authentication.{0,30}(?:fail|error|requir)|(?:token|credentials?).{0,30}(?:expired|invalid)|(?:sign|log) in (?:again|to)|\b401\b/i.test(output)) {
    return new RunnerError(`${LABEL[provider]} subscription authentication failed. Sign in again using the official CLI.`, 'auth');
  }
  if (/unexpected argument|unknown (?:option|argument|feature)|unrecognized (?:option|argument)|unsupported (?:option|feature)|invalid configuration|error (?:loading|parsing) config/i.test(output)) {
    return new RunnerError(`${LABEL[provider]} CLI does not support the required isolated configuration. Update the official CLI.`, 'configuration');
  }
  return new RunnerError(fallback);
}

function executable(provider, options) {
  const path = options[`${provider}Path`];
  if (path !== undefined && (typeof path !== 'string' || !path || path.includes('\0'))) throw new RunnerError('Invalid local CLI executable path.');
  return path === undefined ? provider : isAbsolute(path) ? path : resolve(path);
}

async function providerStatus(provider, options, cwd, signal) {
  const result = { installed: true, authenticated: false, subscription: false };
  try {
    const args = provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'];
    if (provider === 'codex' && options.fileCredentials === true) args.push('-c', 'cli_auth_credentials_store="file"');
    const output = await deadline(signal, AUTH_TIMEOUT_MS, (authSignal) => execute(executable(provider, options), args, { cwd, env: childEnvironment(options.env), signal: authSignal }));
    aborted(signal);
    if (provider === 'codex') {
      const text = `${output.stdout}\n${output.stderr}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      const chatgpt = /(?:^|\n)\s*Logged in using ChatGPT[ \t]*(?:\r?\n|$)/i.test(text);
      const api = /(?:API[ -]?key|access token)/i.test(text);
      result.authenticated = output.code === 0 && (chatgpt || /Logged in using/i.test(text));
      result.subscription = output.code === 0 && chatgpt && !api;
    } else {
      let status;
      try { status = JSON.parse(output.stdout); } catch {}
      result.authenticated = output.code === 0 && status?.loggedIn === true;
      // authMethod alone cannot rule out Console OAuth on every CLI version.
      // Require explicit plan evidence before allowing subscription generation.
      const plan = status && Object.hasOwn(status, 'subscriptionType') && CLAUDE_PLANS.has(status.subscriptionType);
      result.subscription = result.authenticated && status.authMethod === 'claude.ai' && plan;
    }
    if (!result.subscription) result.error = provider === 'claude'
      ? 'Claude requires an official claude.ai subscription login with a recognized subscriptionType. Update the official Claude CLI and sign in with a subscription account. API and unverified billing are disabled.'
      : 'Codex requires an official ChatGPT subscription login. API and unknown authentication methods are disabled.';
  } catch (error) {
    aborted(signal);
    result.installed = !(error instanceof RunnerError && error.code === 'unavailable');
    result.error = safeError(error);
  }
  return result;
}

/** Read-only auth probes. Options: { codexPath, claudePath, env, signal }. */
export async function checkProviders(options = {}) {
  return Object.fromEntries(await Promise.all(['codex', 'claude'].map(async (provider) => {
    aborted(options.signal);
    const cwd = await mkdtemp(join(tmpdir(), 'swarm-cli-status-'));
    try { return [provider, await providerStatus(provider, options, cwd, options.signal)]; }
    finally { await rm(cwd, { recursive: true, force: true }); }
  })));
}

// Read-only control protocols: no prompt, turn, native tool, or model inference is sent.
// Keep stdin open for replies, and stop the entire child group before returning.
async function controlSession(provider, args, options, cwd, signal, work) {
  aborted(signal);
  const child = spawn(executable(provider, options), args, { cwd, env: childEnvironment(options.env), detached: process.platform !== 'win32', windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let next = 0, buffer = '', bytes = 0, failure;
  const fail = error => { failure = error; for (const p of pending.values()) p.reject(error); pending.clear(); killTree(child, true); };
  const abort = () => fail(cancelled());
  const closed = new Promise(resolve => child.once('close', resolve));
  child.on('error', () => fail(new RunnerError('CLI catalog could not be started. Update the official CLI.')));
  child.stdin.on('error', () => fail(new RunnerError('CLI catalog connection closed.')));
  child.stdout.on('error', () => fail(new RunnerError('CLI catalog output closed.')));
  child.stderr.on('error', () => fail(new RunnerError('CLI catalog output closed.')));
  child.once('exit', () => fail(new RunnerError('CLI catalog connection closed. Update the official CLI.')));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const count = chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) fail(new RunnerError('CLI catalog exceeded the output limit.')); };
  child.stderr.on('data', count);
  const decoder = new StringDecoder('utf8');
  child.stdout.on('data', chunk => {
    count(chunk); if (failure) return;
    buffer += decoder.write(chunk);
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let event; try { event = JSON.parse(line); } catch { fail(new RunnerError('CLI returned an invalid catalog.')); return; }
      const reply = provider === 'claude' ? event.type === 'control_response' && event.response : event;
      const id = provider === 'claude' ? reply?.request_id : reply?.id;
      const p = pending.get(id); if (!p) continue;
      pending.delete(id);
      if (reply.error || reply.subtype === 'error') p.reject(new RunnerError('The CLI could not report this account information.'));
      else p.resolve(provider === 'claude' ? reply.response : reply.result);
    }
  });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const request = (method, params = {}, timeoutMs) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = String(++next);
    const timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(new RunnerError('CLI account information is unavailable.')); }, timeoutMs) : undefined;
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    send(provider === 'claude' ? { type: 'control_request', request_id: id, request: { subtype: method, ...params } } : { id, method, params });
  });
  try { return await work(request, send); }
  finally { signal.removeEventListener('abort', abort); killTree(child, true); await closed; }
}

const modelId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:[\]-]{0,119}$/.test(value);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const effortList = values => Array.isArray(values) ? [...new Set(values.filter(v => EFFORTS.has(v)))] : [];
const safeLabel = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) : '';
const percent = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100;
function codexWindows(result) {
  const buckets = result?.rateLimitsByLimitId ?? (result?.rateLimits ? { codex: result.rateLimits } : {});
  return Object.entries(buckets).flatMap(([key, bucket]) => ['primary', 'secondary'].flatMap(kind => {
    const w = bucket?.[kind];
    return w && percent(w.usedPercent) ? [{ label: `${safeLabel(bucket.limitName || key)} · ${w.windowDurationMins ? `${w.windowDurationMins} min` : kind}`, usedPercent: w.usedPercent,
      resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt * 1000 : null }] : [];
  }));
}
function claudeWindows(result) {
  if (!result?.rate_limits_available || !result.rate_limits) return [];
  const limits = result.rate_limits;
  if (Array.isArray(limits.limits)) return limits.limits.filter(w => percent(w.percent)).map(w => ({
    label: [w.group, w.scope?.model?.display_name, w.scope?.surface?.display_name, w.kind].filter(Boolean).map(safeLabel).join(' · '), usedPercent: w.percent,
    resetsAt: Number.isFinite(Date.parse(w.resets_at)) ? Date.parse(w.resets_at) : null,
  }));
  return Object.entries(limits).filter(([, w]) => w && percent(w.utilization)).map(([key, w]) => ({
    label: safeLabel(key.replaceAll('_', ' ')), usedPercent: w.utilization, resetsAt: Number.isFinite(Date.parse(w.resets_at)) ? Date.parse(w.resets_at) : null,
  }));
}

/** Current account's picker and usage. No hardcoded model versions or quota estimates. */
export async function readCatalog(params, options = {}) {
  const provider = params?.provider;
  if (!Object.hasOwn(LABEL, provider)) throw new RunnerError('Provider must be codex or claude.');
  return deadline(options.signal, 20_000, async signal => {
    const cwd = await mkdtemp(join(tmpdir(), 'swarm-cli-catalog-'));
    try {
      const status = await providerStatus(provider, options, cwd, signal);
      if (!status.subscription) throw new RunnerError(status.error, 'auth');
      const args = provider === 'codex' ? ['app-server', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api"', '-c', 'features.hooks=false', '-c', 'features.plugins=false', '-c', 'features.apps=false', '-c', 'mcp_servers={}', '-c', 'notify=[]'] :
        ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--permission-mode', 'dontAsk', '--no-session-persistence', '--disable-slash-commands', '--safe-mode', '--settings', '{"disableAllHooks":true,"forceLoginMethod":"claudeai"}'];
      if (provider === 'codex' && options.fileCredentials) args.push('-c', 'cli_auth_credentials_store="file"');
      return await controlSession(provider, args, options, cwd, signal, async (request, send) => {
        let models, plan = null, windows = [], defaultModel = null;
        if (provider === 'codex') {
          await request('initialize', { clientInfo: { name: 'swarm', version: '1.0.0' }, capabilities: { experimentalApi: true } });
          send({ method: 'initialized' });
          const account = await request('account/read', { refreshToken: false });
          if (account?.account?.type !== 'chatgpt') throw new RunnerError('Codex requires a ChatGPT plan login.', 'auth');
          plan = safeLabel(account.account.planType) || null;
          models = []; let cursor = null; const seen = new Set();
          do {
            const page = await request('model/list', { limit: 100, includeHidden: false, cursor });
            if (!Array.isArray(page?.data)) throw new RunnerError('Codex returned an invalid model catalog.');
            for (const m of page.data) {
              if (m.hidden || !modelId(m.model)) continue;
              const efforts = effortList(m.supportedReasoningEfforts?.map(e => e.reasoningEffort));
              models.push({ id: `codex/${m.model}`, name: safeLabel(m.displayName) || m.model, efforts, defaultEffort: efforts.includes(m.defaultReasoningEffort) ? m.defaultReasoningEffort : null,
                vision: !m.inputModalities || m.inputModalities.includes('image') });
              if (m.isDefault) defaultModel = `codex/${m.model}`;
            }
            cursor = page.nextCursor;
            if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new RunnerError('Codex catalog pagination did not finish.');
            if (cursor) seen.add(cursor);
          } while (cursor);
          try { windows = codexWindows(await request('account/rateLimits/read', {}, 5000)); } catch { /* Unknown is never zero usage. */ }
        } else {
          const init = await request('initialize');
          if (!claudeCatalogPlan(init?.account?.subscriptionType) || (init.account.apiProvider && init.account.apiProvider !== 'firstParty') || init.account.tokenSource === 'none') throw new RunnerError('Claude subscription authentication changed. Sign in again.', 'auth');
          if (!Array.isArray(init?.models)) throw new RunnerError('Claude returned an invalid model catalog.');
          plan = safeLabel(init.account?.subscriptionType) || null;
          models = init.models.filter(m => modelId(m.value)).map(m => ({ id: `claude/${m.value}`, name: safeLabel(m.displayName) || m.value, ...(modelId(m.resolvedModel) ? { resolvedModel: m.resolvedModel } : {}),
            efforts: m.supportsEffort ? effortList(m.supportedEffortLevels) : [], defaultEffort: null, vision: true }));
          defaultModel = models.find(m => m.id === 'claude/default')?.id ?? null;
          try { const result = await request('get_usage', { skip_behaviors: true }, 5000); windows = claudeWindows(result); plan = safeLabel(result?.subscription_type) || plan; } catch { /* Older CLIs don't expose plan usage. */ }
        }
        aborted(signal);
        return { models, defaultModel, plan, usage: { windows, available: windows.length > 0, checkedAt: Date.now() } };
      });
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}

function validateParams(params) {
  if (!params || typeof params !== 'object' || !Object.hasOwn(LABEL, params.provider)) throw new RunnerError('Provider must be codex or claude.');
  if (typeof params.prompt !== 'string' || !params.prompt.trim()) throw new RunnerError('A nonempty prompt is required.');
  if (!params.schema || typeof params.schema !== 'object' || Array.isArray(params.schema)) throw new RunnerError('A JSON Schema object is required.');
  if (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs < 1 || params.timeoutMs > MAX_TIMEOUT_MS) throw new RunnerError('timeoutMs must be an integer from 1 to 900000.');
  if (params.model !== undefined && !modelId(params.model)) throw new RunnerError('Invalid CLI model.');
  if (params.effort !== undefined && !EFFORTS.has(params.effort)) throw new RunnerError('Invalid CLI effort.');
  if (params.actionNames !== undefined && (!Array.isArray(params.actionNames) || params.actionNames.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(name)))) throw new RunnerError('Invalid Swarm action manifest.');
  let schema;
  try { schema = JSON.stringify(params.schema); } catch { throw new RunnerError('Schema must be serializable JSON.'); }
  let bytes = Buffer.byteLength(params.prompt) + Buffer.byteLength(schema) + Buffer.byteLength(JSON.stringify(params.actionNames ?? []));
  if (params.images !== undefined && (!Array.isArray(params.images) || params.images.length > 16)) throw new RunnerError('images must contain at most 16 images.');
  const images = (params.images ?? []).map((image) => {
    if (!image || !Object.hasOwn(IMAGE_EXT, image.mediaType) || typeof image.data !== 'string' || !image.data.length || image.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) throw new RunnerError('Images require a supported mediaType and valid base64 data.');
    bytes += Buffer.byteLength(image.data);
    return image;
  });
  if (bytes > MAX_BYTES) throw new RunnerError('CLI input exceeded the 8 MB limit.');
  return { ...params, schema, images };
}

const tokens = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
function usage(input, output, cached) {
  return { input_tokens: input, output_tokens: output, ...(cached ? { input_tokens_details: { cached_tokens: cached } } : {}) };
}
function structuredText(value, provider) {
  const text = typeof value === 'string' ? value.trim() : JSON.stringify(value);
  if (!text) throw new RunnerError(`${LABEL[provider]} returned empty structured output.`);
  try { JSON.parse(text); }
  catch { throw diagnostic(provider, text, `${LABEL[provider]} returned malformed structured output.`); }
  return text;
}

async function readBounded(file, remaining) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw new RunnerError('Codex returned invalid structured output.');
    if (stat.size > remaining) throw new RunnerError('CLI output exceeded the 8 MB limit.', 'output_limit');
    const buffer = Buffer.alloc(Math.max(0, remaining) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > remaining) throw new RunnerError('CLI output exceeded the 8 MB limit.', 'output_limit');
    return buffer.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new RunnerError('Codex did not return a readable structured output file.');
  } finally { await handle?.close(); }
}

async function generateCodex(params, options, cwd, signal) {
  const schemaFile = join(cwd, 'schema.json'), outputFile = join(cwd, 'output.json');
  await writeFile(schemaFile, params.schema, { mode: 0o600 });
  const args = ['exec', '--json', '--output-schema', schemaFile, '--output-last-message', outputFile,
    '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
    '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-c', 'web_search="disabled"',
    '-c', 'mcp_servers={}', '-c', 'notify=[]', '-c', 'approval_policy="never"'];
  if (options.fileCredentials === true) args.push('-c', 'cli_auth_credentials_store="file"');
  // shell_tool is the supported command-execution gate. unified_exec alone is
  // insufficient (newer releases ignore user opt-outs for that feature).
  for (const feature of ['shell_tool', 'shell_snapshot', 'unified_exec', 'code_mode', 'code_mode_host', 'multi_agent', 'apps', 'plugins', 'hooks', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'view_image', 'goals']) {
    args.push('-c', `features.${feature}=false`);
  }
  for (const [index, image] of params.images.entries()) {
    const imageFile = join(cwd, `image-${index}.${IMAGE_EXT[image.mediaType]}`);
    await writeFile(imageFile, Buffer.from(image.data, 'base64'), { mode: 0o600 });
    args.push('--image', imageFile);
  }
  if (params.model && params.model !== 'default') args.push('--model', params.model);
  if (params.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(params.effort)}`);
  args.push('-');
  const output = await execute(executable('codex', options), args, { cwd, env: childEnvironment(options.env), signal, input: params.prompt });
  aborted(signal);
  if (output.code !== 0) throw diagnostic('codex', output.stderr + output.stdout, 'Codex CLI exited unsuccessfully.');
  const events = output.stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line); } catch { throw diagnostic('codex', output.stderr + output.stdout, 'Codex returned malformed JSON events.'); }
  });
  let input = 0, generated = 0, cached = 0, completed = false;
  for (const event of events) {
    if (event?.type === 'error' || event?.type === 'turn.failed') throw diagnostic('codex', JSON.stringify(event), 'Codex generation failed.');
    if (event?.type === 'turn.completed') {
      completed = true;
      input += tokens(event.usage?.input_tokens);
      generated += tokens(event.usage?.output_tokens);
      cached += tokens(event.usage?.cached_input_tokens);
    }
  }
  if (!completed) throw new RunnerError('Codex returned no completed generation.');
  return { ...(params.model ? { model: params.model } : {}), text: structuredText(await readBounded(outputFile, MAX_BYTES - output.bytes), 'codex'), usage: usage(input, generated, cached) };
}

async function generateClaude(params, options, cwd, signal) {
  // Observe complete assistant events so Swarm actions accidentally emitted as native
  // tool_use blocks can return to the app before Claude loops on "No such tool" errors.
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--json-schema', params.schema, '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--permission-mode', 'dontAsk',
    '--no-session-persistence', '--disable-slash-commands', '--safe-mode', '--settings', '{"disableAllHooks":true,"forceLoginMethod":"claudeai"}',
    '--system-prompt', 'You are the stateless reasoning engine for Swarm. Follow the supplied conversation roles and return the requested JSON schema. Available Swarm tools are actions for the outer application, not native CLI tools. Put requested actions in tool_calls with JSON-encoded arguments, then stop so Swarm can execute them. Do not attempt native tool_use calls, use local tools, or infer that a Swarm action is unavailable from the CLI tool registry. Only supplied application tool results establish execution outcomes.'];
  if (params.model) args.push('--model', params.model);
  if (params.effort) args.push('--effort', params.effort);
  let input = params.prompt;
  if (params.images.length) {
    args.push('--input-format', 'stream-json');
    input = JSON.stringify({ type: 'user', message: { role: 'user', content: [
      { type: 'text', text: params.prompt },
      ...params.images.map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } })),
    ] } }) + '\n';
  }
  const names = JSON.parse(params.schema)?.properties?.tool_calls?.items?.properties?.name?.enum;
  // Explicit metadata distinguishes action envelopes from arbitrary structured
  // output schemas, which may coincidentally contain a field called tool_calls.
  const allowed = new Set((params.actionNames ?? []).filter(name => Array.isArray(names) && names.includes(name)));
  let actionMessage;
  let actionText;
  let pending = '';
  const decoder = new StringDecoder('utf8');
  const onStdout = chunk => {
    if (!allowed.size) return false;
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type !== 'assistant' || event.error || event.message?.role !== 'assistant' || !Array.isArray(event.message.content)) continue;
      const calls = event.message.content.filter(block => block?.type === 'tool_use');
      if (!calls.length || calls.length > 32 || !calls.every(call => allowed.has(call.name) && call.input && typeof call.input === 'object' && !Array.isArray(call.input))) continue;
      const tool_calls = calls.map(call => ({ name: call.name, arguments: JSON.stringify(call.input) }));
      if (tool_calls.some(call => call.arguments.length > 1_000_000)) throw new RunnerError('CLI action arguments are too large.');
      actionMessage = event.message;
      // Drop native narration: an attempted action has no execution result yet.
      actionText = JSON.stringify({ text: '', tool_calls });
      return true;
    }
    return false;
  };
  const output = await execute(executable('claude', options), args, { cwd, env: childEnvironment(options.env), signal, input, onStdout });
  aborted(signal);
  if (output.intercepted && actionMessage) {
    const used = actionMessage.usage ?? {};
    const cached = tokens(used.cache_read_input_tokens);
    const model = typeof actionMessage.model === 'string' ? actionMessage.model : params.model;
    return { ...(model ? { model } : {}), text: actionText,
      usage: usage(tokens(used.input_tokens) + tokens(used.cache_creation_input_tokens) + cached, tokens(used.output_tokens), cached) };
  }
  if (output.code !== 0) throw diagnostic('claude', output.stderr + output.stdout, 'Claude CLI exited unsuccessfully.');
  let result;
  try {
    const events = output.stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    const results = events.filter((event) => event?.type === 'result');
    if (results.length !== 1) throw new Error('Missing or duplicate result');
    result = results[0];
  }
  catch { throw diagnostic('claude', output.stderr + output.stdout, 'Claude returned malformed JSON output.'); }
  if (!result || typeof result !== 'object' || result.is_error || (typeof result.subtype === 'string' && result.subtype.startsWith('error'))) throw diagnostic('claude', output.stdout, 'Claude generation failed.');
  const text = structuredText(result.structured_output ?? result.result, 'claude');
  const used = result.usage ?? {};
  const cached = tokens(used.cache_read_input_tokens);
  const totals = Object.values(result.modelUsage ?? {});
  const reportedTotals = totals.length > 0 && totals.every(u => Number.isSafeInteger(u.inputTokens) && Number.isSafeInteger(u.outputTokens));
  const aggregate = reportedTotals ? usage(totals.reduce((n, u) => n + tokens(u.inputTokens) + tokens(u.cacheCreationInputTokens) + tokens(u.cacheReadInputTokens), 0), totals.reduce((n, u) => n + tokens(u.outputTokens), 0), totals.reduce((n, u) => n + tokens(u.cacheReadInputTokens), 0)) : null;
  const actualModels = Object.keys(result.modelUsage ?? {});
  return { ...(actualModels.length === 1 || params.model ? { model: actualModels.length === 1 ? actualModels[0] : params.model } : {}), text, usage: aggregate ?? usage(tokens(used.input_tokens) + tokens(used.cache_creation_input_tokens) + cached, tokens(used.output_tokens), cached) };
}

/** Generate JSON text using subscription auth. Options never come from the server. */
export async function runGeneration(params, options = {}) {
  const valid = validateParams(params);
  return deadline(options.signal, valid.timeoutMs, async (signal) => {
    const cwd = await mkdtemp(join(tmpdir(), 'swarm-cli-generate-'));
    try {
      const status = await providerStatus(valid.provider, options, cwd, signal);
      aborted(signal);
      if (!status.subscription) throw new RunnerError(status.error ?? 'Official subscription login required.', 'auth');
      return await (valid.provider === 'codex' ? generateCodex : generateClaude)(valid, options, cwd, signal);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}

// This helper owns a real Unix controlling terminal. Its only parent commands
// are terminal input, window size, and cancellation; CLI argv is fixed by JS.
const LOGIN_PTY_HELPER = String.raw`
import base64, errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time

pid, master, status = 0, -1, None
stopping = False
def stop(*_):
    global stopping
    stopping = True
for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, stop)
def emit(event):
    try:
        sys.stdout.write(json.dumps(event, separators=(',', ':')) + '\n')
        sys.stdout.flush()
    except (OSError, BrokenPipeError):
        stop()
def kill_group(sig):
    if pid:
        try: os.killpg(pid, sig)
        except ProcessLookupError: pass
def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
try:
    argv, cols, rows, timeout_ms = json.loads(sys.argv[1])
    expires = time.monotonic() + timeout_ms / 1000
    err_r, err_w = os.pipe()
    pid, master = pty.fork()
    if pid == 0:
        try:
            os.close(err_r)
            resize(0, cols, rows)
            os.execvpe(argv[0], argv, os.environ)
        except BaseException:
            try: os.write(err_w, b'cli')
            except OSError: pass
            os._exit(127)
    os.close(err_w)
    emit({'type': 'spawn', 'pid': pid})
    exec_error = os.read(err_r, 16)
    os.close(err_r)
    if exec_error:
        emit({'type': 'error', 'code': 'cli'})
        stopping = True
    if not stopping:
        os.set_blocking(master, False)
        os.set_blocking(0, False)
        emit({'type': 'ready'})
    incoming, queued, output_bytes, eof = b'', b'', 0, False
    while not stopping:
        if time.monotonic() >= expires:
            emit({'type': 'error', 'code': 'timeout'})
            break
        if status is None:
            waited, value = os.waitpid(pid, os.WNOHANG)
            if waited:
                status = value
                # Descendants must not keep the terminal open after CLI exit.
                kill_group(signal.SIGKILL)
        if status is not None and eof: break
        readers = ([] if eof else [master]) + ([0] if status is None else [])
        readable, writable, _ = select.select(readers, [master] if queued and not eof else [], [], 0.05)
        if 0 in readable:
            block = os.read(0, 16384)
            if not block:
                stopping = True
                break
            incoming += block
            if len(incoming) > 65536:
                emit({'type': 'error', 'code': 'input'})
                break
            while b'\n' in incoming:
                line, incoming = incoming.split(b'\n', 1)
                try:
                    command = json.loads(line)
                    if command['type'] == 'cancel':
                        stopping = True
                        break
                    elif command['type'] == 'write':
                        data = base64.b64decode(command['data'], validate=True)
                        if len(data) > 8192 or len(queued) + len(data) > 65536: raise ValueError()
                        queued += data
                    elif command['type'] == 'resize':
                        c, r = command['cols'], command['rows']
                        if type(c) is not int or type(r) is not int or not 1 <= c <= 1000 or not 1 <= r <= 1000: raise ValueError()
                        resize(master, c, r)
                    else: raise ValueError()
                except (ValueError, KeyError, TypeError, OSError):
                    emit({'type': 'error', 'code': 'input'})
                    stopping = True
                    break
        if stopping: break
        if master in writable:
            try: queued = queued[os.write(master, queued):]
            except BlockingIOError: pass
            except OSError:
                queued = b''
        if master in readable:
            try:
                data = os.read(master, 16384)
                if not data: eof = True
                elif output_bytes + len(data) > 524288:
                    emit({'type': 'error', 'code': 'output'})
                    break
                else:
                    output_bytes += len(data)
                    emit({'type': 'data', 'data': base64.b64encode(data).decode('ascii')})
            except BlockingIOError: pass
            except OSError as error:
                if error.errno == errno.EIO: eof = True
                else: raise
except BaseException:
    emit({'type': 'error', 'code': 'pty'})
finally:
    if pid:
        if status is None:
            kill_group(signal.SIGTERM)
            end = time.monotonic() + 0.2
            while time.monotonic() < end:
                try:
                    waited, value = os.waitpid(pid, os.WNOHANG)
                    if waited:
                        status = value
                        break
                except ChildProcessError: break
                time.sleep(0.01)
        kill_group(signal.SIGKILL)
        if status is None:
            try: _, status = os.waitpid(pid, 0)
            except ChildProcessError: pass
    if master >= 0:
        try: os.close(master)
        except OSError: pass
    code = os.WEXITSTATUS(status) if status is not None and os.WIFEXITED(status) else None
    emit({'type': 'exit', 'exitCode': code})
`;

const LOGIN_ERRORS = {
  cli: 'Official login CLI could not be started. Install or update the selected CLI.',
  pty: 'Login terminal could not be created. Python 3 with Unix PTY support is required.',
  timeout: 'CLI login timed out. Start a new login session.',
  input: 'Login terminal input could not be delivered.',
  output: 'CLI login output exceeded the 512 KiB limit. Start a new login session.',
};
function loginDimensions(cols, rows) {
  if (![cols, rows].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 1000)) throw new RunnerError('Login terminal dimensions must be integers from 1 to 1000.');
}

/** Server-owned interactive login, never exposed as a local bridge RPC.
 * Options are local only: executable paths, env, signal, onData, cols, rows.
 * pythonPath and timeoutMs (at most 10 minutes) support offline test injection.
 * cancel/abort resolve done with exitCode:null; infrastructure failures reject.
 */
export async function startLogin(provider, options = {}) {
  if (typeof provider !== 'string' || !Object.hasOwn(LABEL, provider)) throw new RunnerError('Provider must be codex or claude.');
  if (process.platform === 'win32') throw new RunnerError(LOGIN_ERRORS.pty);
  if (typeof options.onData !== 'function') throw new RunnerError('Login terminal output callback is required.');
  const cols = options.cols ?? 80, rows = options.rows ?? 24, timeoutMs = options.timeoutMs ?? 600_000;
  loginDimensions(cols, rows);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new RunnerError('CLI login timeout must be an integer from 1 to 600000.');
  if (options.signal?.aborted) throw new RunnerError('CLI login cancelled.', 'cancelled');
  const cli = executable(provider, options), python = options.pythonPath === undefined ? 'python3' : executable('python', options);
  const startedAt = Date.now();
  let root, cwd, browser;
  try {
    root = await mkdtemp(join(tmpdir(), 'swarm-cli-login-'));
    cwd = join(root, 'work'); browser = join(root, 'print-login-url');
    await mkdir(cwd, { mode: 0o700 });
    // BROWSER is a fixed, private URL printer. Arguments are data to printf;
    // neither terminal input nor the server can supply shell program text.
    await writeFile(browser, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o700 });
  } catch {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
    throw new RunnerError('Login terminal working directory could not be created.');
  }
  const env = childEnvironment(options.env);
  delete env.NO_COLOR;
  Object.assign(env, { TERM: 'xterm-256color', FORCE_COLOR: '1', CLICOLOR: '1', BROWSER: browser });
  const args = provider === 'codex' ? ['login', '--device-auth', '-c', 'forced_login_method="chatgpt"', '-c', 'cli_auth_credentials_store="file"'] : ['auth', 'login', '--claudeai'];
  const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
  let child;
  try {
    child = spawn(python, ['-I', '-u', '-c', LOGIN_PTY_HELPER, JSON.stringify([[cli, ...args], cols, rows, remaining])], {
      cwd, env, detached: true, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw new RunnerError('Python 3 login terminal helper could not be started.');
  }
  let readyResolve, readyReject, doneResolve, doneReject;
  const ready = new Promise((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
  const done = new Promise((resolveDone, rejectDone) => { doneResolve = resolveDone; doneReject = rejectDone; });
  // A very fast failed startup may finish before callers can attach to done.
  done.catch(() => {});
  let loginPid = 0, receivedReady = false, receivedExit = false, exitCode = null;
  let closed = false, stopping = false, wasCancelled = false, failure, stopTimer;
  let protocol = '', outputBytes = 0, stderrBytes = 0;
  const decoder = new StringDecoder('utf8');
  const killLoginGroup = (force) => {
    if (loginPid > 1) { try { process.kill(-loginPid, force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
  };
  const stop = () => {
    if (closed || stopping) return;
    stopping = true;
    try { child.stdin.end(JSON.stringify({ type: 'cancel' }) + '\n'); } catch {}
    killLoginGroup(false);
    // pty.fork creates a separate session; terminating Python alone is insufficient.
    try { child.kill('SIGTERM'); } catch {}
    stopTimer = setTimeout(() => { killLoginGroup(true); killTree(child, true); }, 750);
  };
  const fail = (message, code = 'login') => {
    if (closed || failure) return;
    failure = new RunnerError(message, code);
    stop();
  };
  const cancel = () => {
    if (closed) return;
    wasCancelled = true;
    stop();
  };
  const send = (command) => {
    if (closed || stopping || !receivedReady || child.stdin.destroyed) throw new RunnerError('Login terminal is closed.');
    const data = JSON.stringify(command) + '\n';
    if (child.stdin.writableLength + Buffer.byteLength(data) > 65_536) throw new RunnerError('Login terminal input buffer is full.');
    try { child.stdin.write(data); } catch { fail(LOGIN_ERRORS.input); throw new RunnerError(LOGIN_ERRORS.input); }
  };
  const handle = {
    write(data) {
      if (typeof data !== 'string' || Buffer.byteLength(data) > 8192) throw new RunnerError('Login input chunks must be strings of at most 8 KiB.');
      send({ type: 'write', data: Buffer.from(data, 'utf8').toString('base64') });
    },
    resize(newCols, newRows) { loginDimensions(newCols, newRows); send({ type: 'resize', cols: newCols, rows: newRows }); },
    cancel,
    done,
  };
  const emitData = (data) => {
    if (!data || failure || wasCancelled) return;
    try { options.onData(data); }
    catch {
      failure ??= new RunnerError('Login terminal output could not be delivered.');
      stop();
    }
  };
  child.stdout.on('data', (chunk) => {
    if (closed) return;
    protocol += chunk.toString('ascii');
    while (protocol.includes('\n')) {
      const end = protocol.indexOf('\n'), line = protocol.slice(0, end);
      protocol = protocol.slice(end + 1);
      if (line.length > 65_536) { fail('Login terminal helper returned invalid output.'); return; }
      let event;
      try { event = JSON.parse(line); } catch { fail('Login terminal helper returned invalid output.'); return; }
      if (event?.type === 'spawn' && !loginPid && Number.isSafeInteger(event.pid) && event.pid > 1 && event.pid !== process.pid) {
        loginPid = event.pid;
        if (stopping) killLoginGroup(false);
      } else if (event?.type === 'ready' && loginPid && !receivedReady) {
        receivedReady = true;
        clearTimeout(startupTimer);
        if (!stopping) readyResolve(handle);
      } else if (event?.type === 'data' && receivedReady && typeof event.data === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data)) {
        const bytes = Buffer.from(event.data, 'base64');
        outputBytes += bytes.length;
        if (outputBytes > 524_288) fail(LOGIN_ERRORS.output, 'output_limit');
        else emitData(decoder.write(bytes));
      } else if (event?.type === 'exit' && (event.exitCode === null || (Number.isSafeInteger(event.exitCode) && event.exitCode >= 0 && event.exitCode <= 255))) {
        receivedExit = true; exitCode = event.exitCode;
      } else if (event?.type === 'error' && typeof event.code === 'string' && Object.hasOwn(LOGIN_ERRORS, event.code)) fail(LOGIN_ERRORS[event.code], event.code);
      else { fail('Login terminal helper returned invalid output.'); return; }
    }
    if (protocol.length > 65_536) fail('Login terminal helper returned invalid output.');
  });
  child.stdout.on('error', () => fail('Login terminal output could not be read.'));
  child.stderr.on('data', (chunk) => {
    // Python infrastructure diagnostics are never an authentication transcript.
    // Drain them without retaining or disclosing executable paths or internals.
    stderrBytes += chunk.length;
    if (stderrBytes > 8192) fail('Python 3 login terminal helper failed.');
  });
  child.stderr.on('error', () => fail('Python 3 login terminal helper failed.'));
  child.stdin.on('error', () => { if (!stopping && !receivedExit) fail(LOGIN_ERRORS.input); });
  child.once('error', () => fail('Python 3 login terminal helper could not be started.'));
  const timer = setTimeout(() => fail(LOGIN_ERRORS.timeout, 'timeout'), remaining);
  const startupTimer = setTimeout(() => fail('Login terminal did not become ready within 10 seconds. Check the Python 3 and CLI installation.', 'startup'), 10_000);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  child.once('close', async (code) => {
    closed = true;
    clearTimeout(timer); clearTimeout(startupTimer); clearTimeout(stopTimer);
    options.signal?.removeEventListener('abort', cancel);
    killLoginGroup(true); killTree(child, true);
    if (!failure && !wasCancelled && (!receivedExit || code !== 0 || protocol.trim())) failure = new RunnerError('Python 3 login terminal helper exited unexpectedly.');
    emitData(decoder.end());
    try { await rm(root, { recursive: true, force: true }); }
    catch { failure ??= new RunnerError('Login terminal working directory could not be cleaned up.'); }
    if (!receivedReady || stopping && !wasCancelled && failure) readyReject(failure ?? new RunnerError('CLI login cancelled.', 'cancelled'));
    else if (wasCancelled) readyReject(new RunnerError('CLI login cancelled.', 'cancelled'));
    if (failure) doneReject(failure);
    else doneResolve({ exitCode: wasCancelled ? null : exitCode });
  });
  return ready;
}

function bridgeURL(server) {
  let url;
  try { url = new URL(server); } catch { throw new RunnerError('A valid --server URL is required.'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new RunnerError('--server must use http(s) or ws(s) without embedded credentials.');
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
  url.pathname = '/api/cli-bridge'; url.search = ''; url.hash = '';
  return url.href;
}

function pause(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((done) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); done(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

async function connection(url, options) {
  const controllers = new Map(), pending = new Set();
  let socket, closed = false, openedAt = 0, welcomed = false, terminal, finish;
  const done = new Promise((resolveDone) => { finish = resolveDone; });
  const stop = () => {
    if (closed) return;
    closed = true;
    for (const controller of controllers.values()) controller.abort(cancelled());
    try { socket?.close(); } catch {}
    finish();
  };
  const send = (value) => {
    if (closed || socket?.readyState !== 1) return;
    try {
      const data = JSON.stringify(value);
      if (socket.bufferedAmount > MAX_BYTES) { stop(); return; }
      if (Buffer.byteLength(data) > MAX_BYTES) {
        if (typeof value.id === 'string') socket.send(JSON.stringify({ id: value.id, error: 'CLI bridge response exceeded the 8 MB limit.' }));
        else stop();
        return;
      }
      socket.send(data);
    } catch { stop(); }
  };
  const receive = (event) => {
    if (closed) return;
    if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_BYTES) { stop(); return; }
    let message;
    try { message = JSON.parse(event.data); } catch { stop(); return; }
    if (!message || typeof message !== 'object') { stop(); return; }
    if (message.type === 'welcome') {
      if (!welcomed) { welcomed = true; options.log?.('Connected to Swarm CLI bridge.'); }
      return;
    }
    // Node's WebSocket automatically answers control-frame pings. Also support
    // optional application heartbeats, without depending on them for liveness.
    if (message.type === 'ping') { send({ type: 'pong' }); return; }
    if (message.type === 'pong') return;
    if (typeof message.id !== 'string' || !message.id || message.id.length > 256) return;
    if (message.method === 'cancel') { controllers.get(message.id)?.abort(cancelled()); return; }
    if (!['status', 'generate', 'catalog'].includes(message.method)) { send({ id: message.id, error: 'Unsupported bridge method.' }); return; }
    if (controllers.has(message.id)) { send({ id: message.id, error: 'Request ID is already in use.' }); return; }
    const controller = new AbortController();
    controllers.set(message.id, controller);
    const localOptions = { codexPath: options.codexPath, claudePath: options.claudePath, env: options.env, signal: controller.signal };
    const job = Promise.resolve().then(() => message.method === 'status' ? checkProviders(localOptions) : message.method === 'catalog' ? readCatalog(message.params, localOptions) : runGeneration(message.params, localOptions))
      .then((result) => send({ id: message.id, result }), (error) => send({ id: message.id, error: safeError(error) }))
      .finally(() => { controllers.delete(message.id); pending.delete(job); });
    pending.add(job);
  };
  options.signal?.addEventListener('abort', stop, { once: true });
  const handshake = setTimeout(stop, 10_000);
  try {
    aborted(options.signal);
    socket = new options.WebSocketImpl(url);
    socket.addEventListener('open', () => {
      if (closed) { try { socket.close(); } catch {} return; }
      clearTimeout(handshake); openedAt = Date.now();
      send({ type: 'hello', token: options.token, version: 1, device: hostname() });
    });
    socket.addEventListener('message', receive);
    socket.addEventListener('close', (event) => {
      if ([4400, 4401, 4403, 4409].includes(event.code)) {
        terminal = new RunnerError(event.code === 4400
          ? 'Bridge protocol is incompatible. Update the bridge and pair this computer again.'
          : event.code === 4409
            ? 'This bridge connection was replaced. Re-pair this computer before reconnecting.'
            : 'Bridge pairing is invalid or revoked. Re-pair this computer before reconnecting.', 'terminal');
      }
      stop();
    }, { once: true });
    socket.addEventListener('error', stop, { once: true });
    await done;
  } finally {
    stop(); clearTimeout(handshake);
    options.signal?.removeEventListener('abort', stop);
    socket?.removeEventListener('message', receive);
    await Promise.allSettled(pending);
  }
  if (terminal) throw terminal;
  return openedAt && Date.now() - openedAt >= 5_000;
}

/** Connect until signal aborts. WebSocketImpl is injectable for offline tests. */
export async function startBridge(options) {
  const url = bridgeURL(options.server);
  if (typeof options.token !== 'string' || !options.token.trim() || options.token.length > 8192) throw new RunnerError('A nonempty --token is required.');
  const local = { ...options, WebSocketImpl: options.WebSocketImpl ?? globalThis.WebSocket };
  if (typeof local.WebSocketImpl !== 'function') throw new RunnerError('Node 22 or newer with global WebSocket is required.');
  // Resolve explicit operator paths before any subprocess enters a temporary cwd.
  for (const provider of ['codex', 'claude']) if (local[`${provider}Path`] !== undefined) local[`${provider}Path`] = executable(provider, local);
  let attempts = 0;
  while (!local.signal?.aborted) {
    let stable = false;
    try { stable = await connection(url, local); }
    catch (error) {
      if (error instanceof RunnerError && error.code === 'terminal') throw error;
      if (local.signal?.aborted) break;
    }
    if (local.signal?.aborted) break;
    if (stable) attempts = 0;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(attempts++, 6)) * (0.8 + Math.random() * 0.2);
    local.log?.('CLI bridge disconnected; reconnecting.');
    await pause(delay, local.signal);
  }
}

async function main() {
  let values;
  try { ({ values } = parseArgs({ options: { server: { type: 'string' }, token: { type: 'string' }, 'codex-path': { type: 'string' }, 'claude-path': { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true })); }
  catch { throw new RunnerError('Invalid CLI arguments. Run with --help for usage.'); }
  if (values.help) { console.log('Usage: node cli-bridge.mjs --server URL --token TOKEN [--codex-path PATH] [--claude-path PATH]'); return; }
  const controller = new AbortController();
  const stop = () => controller.abort(cancelled());
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await startBridge({ server: values.server, token: values.token, codexPath: values['codex-path'], claudePath: values['claude-path'], signal: controller.signal, log: (message) => console.error(message) });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
}

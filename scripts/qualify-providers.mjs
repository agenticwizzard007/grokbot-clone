#!/usr/bin/env node
// Explicit, bounded staging checks. No infrastructure creation or automatic provider login.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const PHASES = ['preflight', 'login', 'catalog', 'models', 'oauth-start', 'oauth-browser', 'connections', 'mcp', 'revoke-cli', 'revoke-connection', 'revoke-mcp', 'revoke-session'];
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export class GateError extends Error {
  constructor(code, incomplete = false) { super(code); this.code = code; this.incomplete = incomplete; }
}
const need = (condition, code, incomplete = false) => { if (!condition) throw new GateError(code, incomplete); };
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = v => JSON.stringify(v, (_, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);
export async function boundedText(response, limit) {
  const reader = response.body?.getReader(); let size = 0; const chunks = [];
  if (reader) try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; need(size <= limit, 'response-too-large'); chunks.push(value); } } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
export const liveFor = (bots, botId) => {
  const state = Array.isArray(bots.live) && bots.live.find(s => s.botId === botId);
  need(state && typeof state.isRunning === 'boolean', 'bot-live-state-missing'); return state;
};

export function validateConfig(c) {
  need(c?.version === 1 && c.target?.kind === 'dedicated-staging', 'dedicated-staging-required');
  let url; try { url = new URL(c.target.origin); } catch { throw new GateError('invalid-staging-origin'); }
  need(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'https-origin-only');
  need(!['swarm-team.fly.dev', 'grokbot-team.fly.dev', 'localhost'].includes(url.hostname) && !/^127\./.test(url.hostname), 'production-or-loopback-forbidden');
  need(c.target.origin === url.origin && c.target.approvedOrigin === url.origin, 'exact-approved-origin-required');
  need(typeof c.target.appId === 'string' && c.target.appId.length > 0 && /^sha256:[a-f0-9]{64}$/.test(c.target.imageDigest), 'staging-inventory-required');
  need(typeof c.approval?.reference === 'string' && c.approval.reference.length > 0 && c.approval.disposableAccounts === true && c.approval.modelLoopRiskAcknowledged === true, 'reviewed-test-accounts-required');
  need(Number.isInteger(c.budget?.maxTurns) && c.budget.maxTurns > 0 && Number.isInteger(c.budget.maxMinutes) && c.budget.maxMinutes > 0, 'explicit-budget-required');
  need(path.isAbsolute(c.evidenceDir ?? ''), 'absolute-evidence-directory-required');
  need(Array.isArray(c.users) && c.users.length === 2, 'two-test-users-required');
  need(new Set(c.users.map(u => u.alias)).size === 2 && new Set(c.users.map(u => u.userId)).size === 2 && new Set(c.users.map(u => u.botId)).size === 2, 'distinct-test-identities-required');
  for (const u of c.users) {
    need(/^[a-z][a-z0-9-]{0,30}$/.test(u.alias) && /^[-_a-zA-Z0-9]+$/.test(u.userId) && /^[-_a-zA-Z0-9]+$/.test(u.botId), 'invalid-test-identity');
    need(u.disposableBot === true && path.isAbsolute(u.sessionFile ?? ''), 'disposable-bot-and-private-session-file-required');
    if (u.observerSessionFile) need(path.isAbsolute(u.observerSessionFile), 'absolute-observer-session-file-required');
    for (const link of u.connections ?? []) {
      need(typeof link.id === 'string' && /^[a-z0-9_-]+$/.test(link.toolkit), 'invalid-connection-fixture');
      need(link.readOnlyReviewed === true && /^[A-Z][A-Z0-9_]+$/.test(link.toolSlug) && !link.toolSlug.startsWith('COMPOSIO_'), 'reviewed-read-tool-required');
      need(link.arguments && typeof link.arguments === 'object' && !Array.isArray(link.arguments) && typeof link.expectedMarker === 'string' && link.expectedMarker.length >= 8, 'read-fixture-marker-required');
      need(!JSON.stringify(link.arguments).includes(link.expectedMarker), 'marker-must-not-be-in-read-arguments');
    }
  }
  return c;
}

export async function privateFile(filename) {
  const stat = await fs.lstat(filename);
  need(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.() && stat.size <= 8192, 'private-file-must-be-owner-only');
  return (await fs.readFile(filename, 'utf8')).trim();
}

export class Api {
  constructor(origin, cookie, fetcher = fetch) {
    need(/^swarm_session=[A-Za-z0-9_-]+$/.test(cookie), 'invalid-session-file');
    this.origin = origin; this.cookie = cookie; this.fetcher = fetcher;
  }
  async request(route, method = 'GET', body, accepted = [200]) {
    need(route.startsWith('/api/') && !route.includes('\\') && !route.includes('#'), 'api-path-required');
    const url = new URL(route, this.origin);
    need(url.origin === this.origin, 'cross-origin-session-blocked');
    const timeout = Math.min(30_000, (this.deadline ?? Infinity) - Date.now()); need(timeout > 0, 'run-time-budget-exhausted');
    let response;
    try { response = await this.fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { cookie: this.cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { throw new GateError('http-transport-failed-no-automatic-retry'); }
    need(accepted.includes(response.status), `unexpected-http-${response.status}`);
    // Never put raw provider output, cookies, OAuth URLs, message text or tokens in receipts.
    const text = await boundedText(response, 8 * 1024 * 1024);
    let data; try { data = JSON.parse(text); } catch { data = undefined; }
    return { status: response.status, data, text };
  }
  async json(...args) { const r = await this.request(...args); need(r.data !== undefined, 'expected-json'); return r.data; }
}

export class Qualification {
  constructor(config, clients, { consume = async () => {}, persist = async () => {}, terminal = process.stdout, fixture = false } = {}) {
    this.c = config; this.clients = clients; this.consume = consume; this.persist = persist; this.terminal = terminal;
    this.deadline = Date.now() + config.budget.maxMinutes * 60_000;
    for (const api of Object.values(clients)) api.deadline = this.deadline;
    this.report = { version: 1, runId: randomUUID(), scope: fixture ? 'simulated-harness-self-test' : 'staging-http-observations', target: config.target.origin, expectedImageDigest: config.target.imageDigest, imageIdentity: 'operator-supplied-not-remotely-attested', approvalReference: config.approval.reference, startedAt: new Date().toISOString(), cases: [], releaseQualified: false };
  }
  checkTime() { need(Date.now() < this.deadline, 'run-time-budget-exhausted'); }
  api(u) { return this.clients[u.alias]; }
  async record(name, details, fn) {
    this.checkTime();
    try { const observed = await fn(); this.report.cases.push({ name, ...details, status: 'pass', ...(observed ? { observed } : {}) }); }
    catch (e) { this.report.cases.push({ name, ...details, status: e instanceof GateError && e.incomplete ? 'incomplete' : 'fail', code: e instanceof GateError ? e.code : 'unexpected-error-redacted' }); throw e; }
    finally { await this.persist(this.report); }
  }
  async identity(u) { const me = await this.api(u).json('/api/auth/me'); need(me.user?.id === u.userId, 'wrong-or-expired-test-session'); }
  async preflight() {
    const health = await this.api(this.c.users[0]).json('/api/health');
    need(health.ok === true && health.role === 'platform', 'isolated-platform-staging-required');
    for (const u of this.c.users) {
      await this.identity(u);
      const bots = await this.api(u).json('/api/bots');
      need(bots.bots?.some(b => b.id === u.botId) && !liveFor(bots, u.botId).isRunning && !liveFor(bots, u.botId).awaiting, 'idle-owned-test-bot-required');
      need((await this.api(u).json('/api/usage?scope=all&range=today')).scope === 'me', 'non-admin-test-user-required');
      const other = this.c.users.find(x => x !== u);
      await this.api(u).request(`/api/bots/${other.botId}/rows`, 'GET', undefined, [403, 404]);
    }
  }
  async select(u, provider) {
    need(['codex', 'claude'].includes(provider), 'provider-required');
    const status = await this.api(u).json('/api/cli/refresh', 'POST');
    const auth = status.providers?.[provider];
    need(status.runtime === 'server' && status.connected && auth?.installed && auth.authenticated && auth.subscription && !auth.error, 'hosted-subscription-login-required', true);
    const chosen = await this.api(u).json('/api/cli', 'PUT', { provider });
    need(chosen.selected === provider && chosen.runtime === 'server', 'wrong-selected-runtime');
    this.provider = provider;
  }
  async assertProvider(u) {
    need(['codex', 'claude'].includes(this.provider), 'subscription-provider-required-before-turn');
    const s = await this.api(u).json('/api/cli');
    need(s.runtime === 'server' && s.selected === this.provider && s.connected && s.providers?.[this.provider]?.subscription === true, 'plan-changed-before-turn');
  }
  async catalog(u, provider) {
    await this.select(u, provider);
    const c = await this.api(u).json('/api/models');
    need(c.billing === 'plan' && c.provider === `${provider}-cli` && c.canFast === false && !c.error && c.models?.length > 0, 'plan-catalog-unavailable', true);
    need(new Set(c.models.map(m => m.id)).size === c.models.length, 'duplicate-catalog-model');
    for (const m of c.models) need(m.id.startsWith(`${provider}/`) && m.billing === 'plan' && Array.isArray(m.efforts) && m.efforts.every(e => EFFORTS.has(e)), 'invalid-plan-model-capabilities');
    return c;
  }
  async quota(u, provider) {
    const c = await this.catalog(u, provider);
    need(typeof c.plan === 'string' && c.plan.length > 0 && c.usage?.available === true && c.usage.windows?.length > 0, 'provider-quota-not-reported', true);
    need(Number.isFinite(c.usage.checkedAt) && Math.abs(Date.now() - c.usage.checkedAt) < 120_000, 'stale-quota-snapshot');
    for (const w of c.usage.windows) need(Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 && (w.resetsAt === null || Number.isFinite(w.resetsAt)), 'invalid-quota-window');
    return { plan: c.plan.slice(0, 160), models: c.models.map(m => ({ id: m.id, efforts: m.efforts, vision: m.vision })), usage: c.usage };
  }
  async prepareImage(u) {
    const a = u.imageFixture;
    need(a?.url && a?.tokenFile && a?.identity, 'controlled-desktop-fixture-required', true);
    const url = new URL(a.url);
    need(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.origin !== this.c.target.origin, 'invalid-image-fixture-url');
    const token = await privateFile(a.tokenFile); need(token && !/[\r\n]/.test(token), 'invalid-image-fixture-token');
    const probe = randomUUID(), marker = `VISION-${randomUUID()}`;
    this.checkTime();
    const r = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(10_000, this.deadline - Date.now())), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ probe, marker }) });
    need(r.ok, 'image-fixture-unavailable');
    const receipt = JSON.parse(await boundedText(r, 8192));
    need(receipt.identity === a.identity && receipt.probe === probe && receipt.prepared === true && receipt.markerHash === digest(marker), 'desktop-fixture-not-ready');
    // The new code is never sent to the model as text, or stored in the test receipt.
    return marker;
  }
  async turn(u, text, { allowedTool = () => false, pending = false } = {}) {
    this.checkTime(); await this.assertProvider(u); await this.consume();
    const api = this.api(u), sent = await api.json(`/api/bots/${u.botId}/messages`, 'POST', { text });
    need(Number.isInteger(sent.row?.seq), 'message-receipt-missing');
    return this.observe(u, sent.row, { allowedTool, pending });
  }
  async observe(u, sent, { allowedTool = () => false, pending = false, approve = false } = {}) {
    const api = this.api(u); let complete = false;
    const approved = new Set();
    try {
      while (Date.now() < this.deadline) {
        const log = await api.json(`/api/bots/${u.botId}/rows?limit=1000`);
        const rows = log.rows.filter(r => r.seq > sent.seq);
        const calls = rows.filter(r => r.body.type === 'tool-call');
        need(calls.every(r => allowedTool(r.body)), 'unexpected-tool-call');
        need(calls.length <= 2 && calls.filter(r => r.body.name !== 'SWARM_APPS_SEARCH').length <= 1, 'unexpected-additional-tool-call');
        const approval = rows.find(r => r.body.card === 'approval' && r.body.status === 'pending');
        if (approval) {
          if (pending) { complete = true; return { rows, approval, sent }; }
          const call = calls.find(r => r.body.status === 'awaiting-approval');
          need(approve && call && allowedTool(call.body) && isDeepStrictEqual(call.body.args, approval.body.args), 'manual-approval-required', true);
          need(!approved.has(approval.body.approvalId), 'approval-did-not-resolve');
          approved.add(approval.body.approvalId);
          await api.request(`/api/approvals/${encodeURIComponent(approval.body.approvalId)}`, 'POST', { decision: 'allow' });
          continue;
        }
        const bots = await api.json('/api/bots');
        const reply = rows.filter(r => r.body.role === 'assistant' && !r.body.streaming).at(-1);
        const live = liveFor(bots, u.botId);
        if (!live.isRunning && rows.some(r => r.body.type === 'notice' && r.body.tone === 'error')) throw new GateError('model-turn-failed');
        if (reply && !live.isRunning && !live.awaiting) { complete = true; return { rows, reply, sent }; }
        await pause(300);
      }
      throw new GateError('turn-timeout-no-automatic-retry');
    } finally { if (!complete) await api.request(`/api/bots/${u.botId}/interrupt`, 'POST').catch(() => {}); }
  }
  async models(u, provider) {
    const c = await this.catalog(u, provider), api = this.api(u);
    const original = (await api.json('/api/bots')).bots.find(b => b.id === u.botId);
    try {
      // Every advertised model/effort is exercised, rather than substituting a preset list.
      for (const m of [...c.models].sort((a, b) => Number(b.vision) - Number(a.vision))) {
        for (const effort of m.efforts.length ? m.efforts : [null]) {
          await this.record('model-effort-tool', { user: u.alias, provider, model: m.id, effort }, async () => {
            const saved = await api.json(`/api/bots/${u.botId}`, 'PATCH', { model: m.id, effort: effort ?? 'medium', fast: false });
            need(saved.bot?.model === m.id && saved.bot.effort === (effort ?? 'medium') && !saved.bot.fast, 'model-selection-not-persisted');
            const beforeUsage = await api.json('/api/usage?scope=me&range=today');
            const before = beforeUsage.byBot?.find(b => b.key === u.botId);
            const marker = `qualification-${randomUUID()}`;
            const r = await this.turn(u, `Use only remember to save exactly this test memory: ${marker}. Then reply with exactly ${marker}. Do not use any other tools.`, { allowedTool: b => b.name === 'remember' && b.args?.text === marker });
            need(r.reply?.body.text.trim() === marker && r.rows.some(r => r.body.name === 'remember' && r.body.status === 'done'), 'model-or-tool-result-not-proven');
            const memory = (await api.json(`/api/bots/${u.botId}/memories`)).memories?.find(x => x.text === marker);
            need(memory, 'remember-side-effect-not-proven');
            await api.request(`/api/memories/${encodeURIComponent(memory.id)}`, 'DELETE');
            const usage = await api.json('/api/usage?scope=me&range=today');
            const row = usage.byBot?.find(b => b.key === u.botId);
            need(row?.requests > (before?.requests ?? 0) && row.costUsd === (before?.costUsd ?? 0) && usage.provider === `${provider}-cli`, 'subscription-usage-attribution-failed');
            const identities = [m.id, ...(m.resolvedModel ? [`${provider}/${m.resolvedModel}`] : [])];
            const changedModels = usage.byModel.filter(x => x.requests > (beforeUsage.byModel.find(b => b.key === x.key)?.requests ?? 0));
            need(changedModels.length > 0 && changedModels.every(x => identities.includes(x.key)), 'selected-model-usage-identity-not-proven');
            need((await api.json('/api/cli')).selected === provider, 'provider-selection-changed');
          });
        }
        if (m.vision) await this.record('live-image-and-history', { user: u.alias, provider, model: m.id }, async () => {
          const imageMarker = await this.prepareImage(u);
          const r = await this.turn(u, 'Use computer_screenshot once on the existing qualification desktop. Read the large qualification code visible in the screenshot and reply with only that code. Do not navigate or use any other tools.', { allowedTool: b => b.name === 'computer_screenshot' });
          need(r.reply?.body.text.trim() === imageMarker && r.rows.some(r => r.body.name === 'computer_screenshot' && r.body.status === 'done'), 'live-image-not-proven');
          const marker = `history-${randomUUID()}`;
          const after = await this.turn(u, `Now reply with exactly ${marker}, without using tools.`);
          need(after.reply?.body.text.trim() === marker, 'text-after-image-failed');
        });
      }
    } finally { await api.request(`/api/bots/${u.botId}`, 'PATCH', { model: original.model, effort: original.effort, fast: original.fast }); }
  }
  async login(u, provider) {
    need(['codex', 'claude'].includes(provider), 'provider-required');
    need(process.stdin.isTTY && this.terminal.isTTY, 'interactive-terminal-required', true);
    const api = this.api(u), foreign = this.api(this.c.users.find(x => x !== u));
    const t = await api.json('/api/cli/login', 'POST', { provider, cols: process.stdout.columns || 90, rows: process.stdout.rows || 25 });
    need(typeof t.id === 'string', 'login-id-missing');
    let finished = false, cursor = 0, inputError;
    let inputChain = Promise.resolve();
    const input = data => { inputChain = inputChain.then(() => api.request(`/api/cli/login/${t.id}/input`, 'POST', { data: data.toString('utf8') })).catch(() => { inputError = true; }); };
    try {
      for (const [suffix, method, body] of [['', 'GET'], ['/input', 'POST', { data: '' }], ['/resize', 'POST', { cols: 80, rows: 24 }], ['', 'DELETE']]) await foreign.request(`/api/cli/login/${t.id}${suffix}`, method, body, [403, 404]);
      process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', input);
      while (Date.now() < this.deadline) {
        need(!inputError, 'login-input-failed');
        const status = await api.json(`/api/cli/login/${t.id}?cursor=${cursor}`);
        // Terminal output is displayed interactively only; never written to evidence files.
        if (status.output) this.terminal.write(status.output);
        cursor = status.cursor;
        if (status.state === 'connected') { finished = true; break; }
        need(!['failed', 'cancelled'].includes(status.state), 'provider-login-failed');
        await pause(250);
      }
      need(finished, 'provider-login-timeout'); await this.select(u, provider);
    } finally {
      process.stdin.off('data', input); process.stdin.setRawMode(false); process.stdin.pause();
      await inputChain;
      if (!finished) await api.request(`/api/cli/login/${t.id}`, 'DELETE').catch(() => {});
    }
  }
  async oauthStart(u, provider, index) {
    need(this.terminal.isTTY, 'interactive-terminal-required', true);
    const api = this.api(u); let reply;
    if (provider === 'mcp') {
      need(u.mcp?.serverId, 'mcp-server-required', true);
      reply = await api.json(`/api/mcp/servers/${encodeURIComponent(u.mcp.serverId)}/oauth`, 'POST');
    } else {
      const link = u.connections?.[index]; need(link, 'reviewed-connection-fixture-required', true);
      reply = await api.json(`/api/apps/${encodeURIComponent(link.toolkit)}/connect`, 'POST', {});
    }
    const url = reply.redirectUrl ?? reply.url; need(typeof url === 'string' && new URL(url).protocol === 'https:', 'oauth-url-unavailable');
    this.terminal.write(`Complete authorization in the same signed-in browser. This link is not saved to evidence:\n${url}\n`);
    throw new GateError('oauth-completion-needs-separate-verification', true);
  }
  async verifyOAuthCallback(u, provider, callback) {
    const url = new URL(callback), route = provider === 'mcp' ? '/api/mcp/servers/oauth/callback' : '/api/apps/callback';
    need(url.origin === this.c.target.origin && url.pathname === route && url.searchParams.has('state'), 'unexpected-oauth-callback');
    const foreign = this.api(this.c.users.find(x => x !== u));
    await foreign.request(url.pathname + url.search, 'GET', undefined, [400, 401, 403, 404]);
    // Same-owner secondary sessions must also be refused without consuming the valid attempt.
    need(u.observerSessionFile, 'same-owner-observer-session-required', true);
    const observer = new Api(this.c.target.origin, await privateFile(u.observerSessionFile)); observer.deadline = this.deadline;
    need(observer.cookie !== this.api(u).cookie && (await observer.json('/api/auth/me')).user?.id === u.userId, 'observer-session-identity-mismatch');
    await observer.request(url.pathname + url.search, 'GET', undefined, [400, 401, 403, 404]);
    const success = await this.api(u).request(url.pathname + url.search);
    need(success.text.includes(provider === 'mcp' ? 'MCP connected' : 'App connected'), 'oauth-success-not-confirmed');
    await this.api(u).request(url.pathname + url.search, 'GET', undefined, [400, 401, 403, 404]);
  }
  async oauthBrowser(u, provider, index) {
    need(['mcp', 'composio'].includes(provider), 'oauth-provider-required');
    need(u.observerSessionFile, 'same-owner-observer-session-required', true);
    let chromium; try { ({ chromium } = await import('playwright')); } catch { throw new GateError('playwright-browser-runtime-required', true); }
    const observerCookie = await privateFile(u.observerSessionFile);
    const observer = new Api(this.c.target.origin, observerCookie); observer.deadline = this.deadline;
    need(observerCookie !== this.api(u).cookie && (await observer.json('/api/auth/me')).user?.id === u.userId, 'observer-session-identity-mismatch');
    let browser;
    try { browser = await chromium.launch({ headless: false, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) }); }
    catch { throw new GateError('graphical-browser-unavailable', true); }
    let timer;
    try {
      const ctx = await browser.newContext();
      await ctx.addCookies([{ name: 'swarm_session', value: this.api(u).cookie.slice('swarm_session='.length), url: this.c.target.origin, httpOnly: true, secure: true, sameSite: 'Lax' }]);
      const page = await ctx.newPage();
      const callbackPath = provider === 'mcp' ? '/api/mcp/servers/oauth/callback' : '/api/apps/callback';
      let resolve, reject;
      const callbackDone = new Promise((yes, no) => { resolve = yes; reject = no; });
      // Attach a rejection handler immediately; the operator may take minutes to sign in.
      callbackDone.catch(() => {});
      await page.route(url => url.origin === this.c.target.origin && url.pathname === callbackPath, async route => {
        try {
          await this.verifyOAuthCallback(u, provider, route.request().url());
          await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>OAuth session isolation and replay checks completed. Return to the terminal.</p>' }); resolve();
        } catch (e) { await route.abort().catch(() => {}); reject(e); }
      });
      let result;
      if (provider === 'mcp') {
        need(u.mcp?.serverId, 'mcp-server-required', true);
        result = await this.api(u).json(`/api/mcp/servers/${encodeURIComponent(u.mcp.serverId)}/oauth`, 'POST', {});
      } else {
        const link = u.connections?.[index]; need(link, 'reviewed-connection-fixture-required', true);
        result = await this.api(u).json(`/api/apps/${encodeURIComponent(link.toolkit)}/connect`, 'POST', {});
      }
      const link = new URL(result.redirectUrl);
      need(link.protocol === 'https:' && !link.username && !link.password, 'invalid-oauth-authorization-url');
      console.log('Complete the approved test-account OAuth login in the temporary browser. No trace, video or credentials will be saved.');
      await page.goto(link.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await Promise.race([callbackDone, new Promise((_, no) => { timer = setTimeout(() => no(new GateError('oauth-operator-timeout', true)), Math.max(1, this.deadline - Date.now())); })]);
      return { foreignUserRefused: true, sameOwnerOtherSessionRefused: true, initiatingSessionSucceeded: true, replayRefused: true, providerGrantRevocation: 'separate-phase' };
    } finally { clearTimeout(timer); await browser.close(); }
  }
  async providerWitness(link) {
    const a = link.audit; need(a?.url && a?.identity && a?.tokenFile, 'independent-provider-read-witness-required', true);
    const url = new URL(a.url);
    need(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.origin !== this.c.target.origin, 'invalid-provider-witness-url');
    const token = await privateFile(a.tokenFile); need(token && !/[\r\n]/.test(token), 'invalid-witness-token');
    this.checkTime();
    const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(Math.min(10_000, this.deadline - Date.now())), headers: { authorization: `Bearer ${token}` } });
    need(r.ok, 'provider-witness-unavailable');
    const data = JSON.parse(await boundedText(r, 64 * 1024));
    need(data.identity === a.identity && Number.isSafeInteger(data.cursor) && data.cursor >= 0 && Array.isArray(data.records), 'invalid-provider-witness');
    need(data.records.every(r => Number.isSafeInteger(r.sequence) && r.sequence >= 0 && r.sequence <= data.cursor && ['search', 'execute'].includes(r.kind)) && new Set(data.records.map(r => r.sequence)).size === data.records.length, 'invalid-provider-witness-sequence');
    return data;
  }
  async connectedRead(u, link, implicitDefault = false) {
    const before = await this.providerWitness(link);
    const selection = implicitDefault ? 'Omit connectionId from SEARCH to use the current default. Use only the connectionId returned by SEARCH for EXECUTE.' : `Select connectionId ${link.id} for SEARCH and EXECUTE.`;
    const r = await this.turn(u, `Use SWARM_APPS_SEARCH to discover the schema for ${link.toolSlug} in ${link.toolkit}. ${selection} Then use SWARM_APPS_EXECUTE exactly once with that connection, the returned revision, tool_slug ${link.toolSlug}, and arguments ${JSON.stringify(link.arguments)}. This is the approved read-only qualification fixture. Report the unique test marker in the result; do not use another connection or any other tools.`, {
      allowedTool: b => b.name === 'SWARM_APPS_SEARCH' ? b.args?.toolkit === link.toolkit && (implicitDefault ? b.args.connectionId === undefined : b.args.connectionId === link.id) : b.name === 'SWARM_APPS_EXECUTE' && b.args?.connectionId === link.id && b.args.tool_slug === link.toolSlug && isDeepStrictEqual(b.args.arguments, link.arguments),
    });
    need(r.rows.some(r => r.body.name === 'SWARM_APPS_EXECUTE' && r.body.status === 'done' && r.body.summary !== 'failed') && r.reply?.body.text.includes(link.expectedMarker), 'private-account-read-not-proven');
    const after = await this.providerWitness(link);
    const fresh = after.records.filter(x => x.sequence > before.cursor);
    const executions = fresh.filter(x => x.kind === 'execute');
    need(after.cursor > before.cursor && executions.length === 1 && executions[0].status === 'success' && executions[0].connectionHash === digest(link.id) && executions[0].toolSlug === link.toolSlug && executions[0].argumentsHash === digest(canonical(link.arguments)), 'fresh-provider-read-not-proven');
    if (implicitDefault) {
      const selected = fresh.filter(x => x.kind === 'search');
      const dispatched = r.rows.find(row => row.body.name === 'SWARM_APPS_EXECUTE');
      need(selected.length === 1 && selected[0].explicitConnection === false && selected[0].toolkit === link.toolkit && selected[0].connectionHash === digest(link.id) && selected[0].revision === dispatched?.body.args?.revision && selected[0].sequence < executions[0].sequence, 'default-search-result-witness-required', true);
    }
    for (const other of this.c.users.flatMap(x => x.connections ?? [])) if (other.id !== link.id) need(!r.reply.body.text.includes(other.expectedMarker), 'foreign-account-marker-leaked');
  }
  async connections(u) {
    const configured = u.connections ?? [];
    const overlap = (this.c.users[0].connections ?? []).filter(l => l.toolkit === this.c.users[0].connections?.[0]?.toolkit);
    need(overlap.length >= 2 && new Set(overlap.map(l => l.id)).size === overlap.length && this.c.users[1].connections?.some(l => l.toolkit === overlap[0].toolkit), 'same-owner-overlapping-provider-accounts-required', true);
    need(configured.length > 0, 'private-provider-fixtures-required', true);
    const api = this.api(u), own = (await api.json('/api/apps/connections')).connections;
    need(configured.every(l => own.some(c => c.id === l.id && c.status === 'ACTIVE' && c.toolkit === l.toolkit)), 'provider-authorizations-incomplete', true);
    need(own.filter(c => c.status === 'ACTIVE').every(c => configured.some(l => l.id === c.id)), 'unreviewed-active-provider-connection');
    const foreign = this.c.users.find(x => x !== u);
    for (const link of foreign.connections ?? []) {
      need(!own.some(c => c.id === link.id), 'foreign-connection-listed');
      const before = (await this.api(foreign).json('/api/apps/connections')).connections;
      const rejected = [];
      for (const [suffix, method] of [['/default', 'POST'], ['', 'DELETE']]) {
        const r = await api.request(`/api/apps/connections/${encodeURIComponent(link.id)}${suffix}`, method, undefined, [403, 404, 500]);
        rejected.push(r.status);
      }
      // Current public routes translate gateway ownership errors to generic 500.
      // A 500 alone is not denial evidence: prove owner state and a real read still work.
      need(isDeepStrictEqual((await this.api(foreign).json('/api/apps/connections')).connections, before), 'foreign-mutation-changed-owner-state');
      await this.connectedRead(foreign, link);
      this.report.cases.push({ name: 'foreign-connection-denied', user: u.alias, status: 'pass', httpStatuses: rejected, ownerStateUnchanged: true, ownerReadVerified: true });
    }
    const originalDefaults = own.filter(c => c.isDefault);
    need(configured.every(link => originalDefaults.some(c => c.toolkit === link.toolkit)), 'initial-default-required-for-restorable-test', true);
    try {
      for (const link of configured) {
        await api.request(`/api/apps/connections/${encodeURIComponent(link.id)}/default`, 'POST', {});
        need((await api.json('/api/apps/connections')).connections.some(c => c.id === link.id && c.isDefault), 'private-default-selection-not-proven');
        await this.record('private-provider-default-read', { user: u.alias, toolkit: link.toolkit, connectionHash: digest(link.id) }, () => this.connectedRead(u, link, true));
        await this.record('private-provider-explicit-read', { user: u.alias, toolkit: link.toolkit, connectionHash: digest(link.id) }, () => this.connectedRead(u, link));
      }
    } finally { for (const c of originalDefaults) await api.request(`/api/apps/connections/${encodeURIComponent(c.id)}/default`, 'POST', {}); }
  }
  async mcpAudit(u, nonce) {
    const a = u.mcp?.audit;
    need(a?.url && a?.tokenFile && a?.identity, 'independent-mcp-call-audit-required', true);
    const url = new URL(a.url);
    need(url.protocol === 'https:' && !url.username && !url.password && url.origin !== this.c.target.origin && !url.search && !url.hash, 'invalid-mcp-audit-origin');
    url.searchParams.set('probe', nonce);
    const token = await privateFile(a.tokenFile); need(token.length > 0 && !/[\r\n]/.test(token), 'invalid-audit-token');
    this.checkTime();
    const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(Math.min(10_000, this.deadline - Date.now())), headers: { authorization: `Bearer ${token}` } });
    need(r.ok && Number(r.headers.get('content-length') ?? 0) <= 8192, 'mcp-audit-unavailable');
    const text = await boundedText(r, 8192);
    let data; try { data = JSON.parse(text); } catch { throw new GateError('invalid-mcp-audit'); }
    need(data.identity === a.identity && data.probe === nonce && Number.isSafeInteger(data.acceptedCalls) && data.acceptedCalls >= 0, 'mcp-audit-mismatch');
    return data.acceptedCalls;
  }
  async mcp(u) {
    need(u.mcp?.serverId && u.mcp?.toolName && u.mcp?.expectedMarker, 'live-mcp-fixture-required', true);
    const api = this.api(u), foreign = this.api(this.c.users.find(x => x !== u)), id = encodeURIComponent(u.mcp.serverId);
    need(!(await foreign.json('/api/mcp/servers')).servers.some(s => s.id === u.mcp.serverId), 'foreign-mcp-listed');
    for (const [suffix, method, body] of [['/test', 'POST', {}], ['/oauth', 'POST', {}], ['', 'PATCH', { enabled: false }], ['', 'DELETE']]) await foreign.request(`/api/mcp/servers/${id}${suffix}`, method, body, [403, 404]);
    const server = (await api.json(`/api/mcp/servers/${id}/test`, 'POST')).server;
    need(!server.error && server.tools?.some(t => t.toolName === u.mcp.toolName), 'mcp-discovery-not-proven');
    need(u.mcp.nonceArgument && u.mcp.readOnlyReviewed === true, 'reviewed-mcp-probe-arguments-required', true);
    const nonce = randomUUID(), args = { ...u.mcp.arguments, [u.mcp.nonceArgument]: nonce };
    need(await this.mcpAudit(u, nonce) === 0, 'probe-already-used');
    const sent = await this.postTurn(u, `Call exactly ${u.mcp.toolName} once with ${JSON.stringify(args)}. This is the approved read-only qualification fixture. Report its unique test marker and use no other tools.`);
    const r = await this.observe(u, sent, { allowedTool: b => b.name === u.mcp.toolName && isDeepStrictEqual(b.args, args), approve: true });
    need(r.rows.some(r => r.body.name === u.mcp.toolName && r.body.status === 'done') && r.reply?.body.text.includes(u.mcp.expectedMarker), 'mcp-tool-execution-not-proven');
    need(await this.mcpAudit(u, nonce) === 1, 'mcp-provider-call-not-proven');
  }
  async postTurn(u, text) {
    this.checkTime(); await this.assertProvider(u); await this.consume();
    const sent = await this.api(u).json(`/api/bots/${u.botId}/messages`, 'POST', { text });
    need(Number.isInteger(sent.row?.seq), 'message-receipt-missing'); return sent.row;
  }
  async revokeCli(u, provider) {
    await this.select(u, provider); const api = this.api(u);
    await api.json('/api/cli/pair', 'DELETE');
    const status = await api.json('/api/cli');
    need(status.selected === provider && !status.connected, 'cli-disconnect-failed-open');
    const catalog = await api.json('/api/models');
    need(catalog.billing === 'plan' && catalog.models?.length === 0 && !!catalog.error, 'revoked-cli-catalog-failed-open');
    const before = await api.json('/api/usage?scope=me&range=today');
    await this.consume();
    const sent = await api.json(`/api/bots/${u.botId}/messages`, 'POST', { text: `Reply with qualification-${randomUUID()}.` });
    try {
      while (Date.now() < this.deadline) {
        const rows = (await api.json(`/api/bots/${u.botId}/rows`)).rows.filter(r => r.seq > sent.row.seq);
        need(!rows.some(r => r.body.role === 'assistant'), 'revoked-cli-still-generated');
        if (rows.some(r => r.body.type === 'notice' && r.body.tone === 'error')) {
          const after = await api.json('/api/usage?scope=me&range=today');
          need(after.totals.requests === before.totals.requests && after.totals.costUsd === before.totals.costUsd, 'revoked-cli-recorded-inference');
          return;
        }
        await pause(300);
      }
      throw new GateError('revocation-turn-not-observed');
    } finally { await api.request(`/api/bots/${u.botId}/interrupt`, 'POST').catch(() => {}); }
  }
  async revokeConnection(u, index) {
    const link = u.connections?.[index]; need(link, 'connection-index-required');
    const prior = (await this.api(u).json('/api/apps/connections')).connections.find(c => c.id === link.id);
    need(Number.isInteger(prior?.revision), 'tenant-connection-revision-required');
    await this.connectedRead(u, link);
    await this.api(u).request(`/api/apps/connections/${encodeURIComponent(link.id)}`, 'DELETE');
    const remaining = (await this.api(u).json('/api/apps/connections')).connections;
    need(!remaining.some(c => c.id === link.id && c.status === 'ACTIVE'), 'revoked-connection-still-active');
    const before = await this.providerWitness(link);
    const args = { connectionId: link.id, revision: prior.revision, tool_slug: link.toolSlug, arguments: link.arguments };
    const denied = await this.turn(u, `Qualification of a revoked test connection: call SWARM_APPS_EXECUTE exactly once with ${JSON.stringify(args)}. Expect the app to refuse it; report the refusal. Do not search, retry, change accounts or use another tool.`, { allowedTool: b => b.name === 'SWARM_APPS_EXECUTE' && isDeepStrictEqual(b.args, args) });
    need(denied.rows.some(r => r.body.name === 'SWARM_APPS_EXECUTE' && (['error', 'denied'].includes(r.body.status) || r.body.status === 'done' && r.body.summary === 'failed')), 'stale-provider-dispatch-not-refused');
    const after = await this.providerWitness(link);
    need(after.cursor === before.cursor && !after.records.some(r => r.sequence > before.cursor), 'revoked-dispatch-reached-provider');
    for (const sibling of u.connections.filter(c => c.id !== link.id)) await this.connectedRead(u, sibling);
    return { appDisconnectConfirmed: true, staleDispatchBlocked: true, providerOAuthGrantRevocation: 'not-tested-separate-issuer-step' };
  }
  async revokeMcp(u) {
    await this.mcp(u);
    const id = encodeURIComponent(u.mcp.serverId), api = this.api(u);
    const server = (await api.json('/api/mcp/servers')).servers.find(s => s.id === u.mcp.serverId);
    need(server?.requireApproval, 'mcp-approval-required-for-revocation-test', true);
    const nonce = randomUUID(), args = { ...u.mcp.arguments, [u.mcp.nonceArgument]: nonce };
    need(await this.mcpAudit(u, nonce) === 0, 'probe-already-used');
    const pending = await this.turn(u, `Call exactly ${u.mcp.toolName} once with ${JSON.stringify(args)} and then report the result. Use no other tools.`, { pending: true, allowedTool: b => b.name === u.mcp.toolName && isDeepStrictEqual(b.args, args) });
    need(pending.approval, 'mcp-call-did-not-pause-for-approval');
    try {
      await api.json(`/api/mcp/servers/${id}`, 'PATCH', { enabled: false });
      need((await api.json('/api/mcp/servers')).servers.find(s => s.id === u.mcp.serverId)?.enabled === false, 'mcp-disable-not-persisted');
      await api.request(`/api/approvals/${encodeURIComponent(pending.approval.body.approvalId)}`, 'POST', { decision: 'allow' });
      const final = await this.observe(u, pending.sent, { allowedTool: b => b.name === u.mcp.toolName && isDeepStrictEqual(b.args, args) });
      need(final.rows.some(r => r.body.name === u.mcp.toolName && ['error', 'denied'].includes(r.body.status)), 'stale-mcp-approval-not-refused');
      need(await this.mcpAudit(u, nonce) === 0, 'revoked-mcp-call-reached-provider');
      return { localDispatchRevocation: true, providerOAuthGrantRevocation: 'not-tested-separate-issuer-step' };
    } finally { await api.request(`/api/bots/${u.botId}/interrupt`, 'POST').catch(() => {}); }
  }
  async revokeSession(u) {
    need(u.observerSessionFile, 'separate-same-user-observer-session-required', true);
    const observer = new Api(this.c.target.origin, await privateFile(u.observerSessionFile));
    need((await observer.json('/api/auth/me')).user?.id === u.userId, 'observer-identity-mismatch');
    need(observer.cookie !== this.api(u).cookie, 'observer-session-must-differ');
    const sessions = await this.api(u).json('/api/auth/sessions');
    const current = sessions.sessions.find(s => s.current); need(current, 'current-session-not-found');
    await observer.request(`/api/auth/sessions/${encodeURIComponent(current.id)}`, 'DELETE');
    for (const route of ['/api/cli', '/api/models', `/api/bots/${u.botId}/rows`]) await this.api(u).request(route, 'GET', undefined, [401]);
  }
  async run(phase, alias, provider, index = 0) {
    need(PHASES.includes(phase), 'unknown-phase');
    const u = this.c.users.find(x => x.alias === alias); need(u || phase === 'preflight', 'test-user-required');
    await this.record('preflight', {}, () => this.preflight());
    if (phase === 'preflight') return;
    if (['models', 'connections', 'mcp', 'revoke-cli', 'revoke-connection', 'revoke-mcp'].includes(phase)) {
      need(['codex', 'claude'].includes(provider), 'subscription-provider-required');
      for (const subject of this.c.users) await this.select(subject, provider);
    }
    return this.record(phase, { ...(u ? { user: u.alias } : {}), ...(provider ? { provider } : {}) }, async () => {
      if (phase === 'login') return this.login(u, provider);
      if (phase === 'catalog') return this.quota(u, provider);
      if (phase === 'models') return this.models(u, provider);
      if (phase === 'oauth-start') return this.oauthStart(u, provider, index);
      if (phase === 'oauth-browser') return this.oauthBrowser(u, provider, index);
      if (phase === 'connections') return this.connections(u);
      if (phase === 'mcp') return this.mcp(u);
      if (phase === 'revoke-cli') return this.revokeCli(u, provider);
      if (phase === 'revoke-connection') return this.revokeConnection(u, index);
      if (phase === 'revoke-mcp') return this.revokeMcp(u);
      if (phase === 'revoke-session') return this.revokeSession(u);
    });
  }
}

export async function main(args = process.argv.slice(2)) {
  const opts = Object.fromEntries(args.reduce((all, arg, i) => arg.startsWith('--') ? [...all, [arg.slice(2), args[i + 1]?.startsWith('--') ? true : args[i + 1] ?? true]] : all, []));
  if (opts.help || !opts.config) { console.log('node scripts/qualify-providers.mjs --config /private/config.json --phase <' + PHASES.join('|') + '> --user a --provider codex --execute\nWithout --execute: validates configuration only; makes no network requests. See docs/provider-qualification.md.'); return; }
  const c = validateConfig(JSON.parse(await fs.readFile(opts.config, 'utf8')));
  need(PHASES.includes(opts.phase), 'phase-required');
  if (opts.execute !== true) { console.log('Configuration valid. No network calls or model turns executed.'); return; }
  await fs.mkdir(c.evidenceDir, { recursive: true, mode: 0o700 });
  const directory = await fs.lstat(c.evidenceDir); need(directory.isDirectory() && !directory.isSymbolicLink() && (directory.mode & 0o077) === 0, 'private-evidence-directory-required');
  const lock = path.join(c.evidenceDir, 'running.lock'); const handle = await fs.open(lock, 'wx', 0o600);
  let q;
  try {
    const configHash = digest(JSON.stringify(c)), budgetPath = path.join(c.evidenceDir, 'budget.json');
    let budget; try { budget = JSON.parse(await fs.readFile(budgetPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; budget = { configHash, turns: 0 }; }
    need(budget.configHash === configHash, 'configuration-changed-budget-needs-review');
    need(Number.isSafeInteger(budget.turns) && budget.turns >= 0, 'invalid-budget-journal');
    const save = async (file, data) => { const tmp = `${file}.new`; await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 }); await fs.rename(tmp, file); };
    const clients = {};
    for (const u of c.users) clients[u.alias] = new Api(c.target.origin, await privateFile(u.sessionFile));
    q = new Qualification(c, clients, {
      consume: async () => { need(budget.turns < c.budget.maxTurns, 'turn-budget-exhausted'); budget.turns++; await save(budgetPath, budget); },
      persist: report => save(path.join(c.evidenceDir, `${report.runId}.json`), report),
    });
    await q.run(opts.phase, opts.user, opts.provider, Number(opts.index ?? 0));
    console.log(`Observed phase passed: ${opts.phase}. This does not qualify the release or unrun phases.`);
  } catch (e) {
    console.error(e instanceof GateError ? e.code : 'qualification-failed-details-redacted'); process.exitCode = 1;
  } finally { await handle.close(); await fs.unlink(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(() => { console.error('qualification-setup-failed-details-redacted'); process.exitCode = 1; });

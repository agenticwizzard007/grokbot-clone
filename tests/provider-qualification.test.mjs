// Harness self-tests only: provider data is simulated and network is forbidden.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Api, GateError, Qualification, boundedText, liveFor, privateFile, validateConfig } from '../scripts/qualify-providers.mjs';

const realFetch = globalThis.fetch;
beforeEach(() => { globalThis.fetch = async () => { throw new Error('NETWORK FORBIDDEN IN SELF TESTS'); }; });
afterEach(() => { globalThis.fetch = realFetch; });
const sha = x => createHash('sha256').update(x).digest('hex');
function config() {
  return { version: 1, target: { kind: 'dedicated-staging', origin: 'https://qualification.example', approvedOrigin: 'https://qualification.example', appId: 'test-stage', imageDigest: `sha256:${'a'.repeat(64)}` }, approval: { reference: 'test-only', disposableAccounts: true, modelLoopRiskAcknowledged: true }, budget: { maxTurns: 10, maxMinutes: 1 }, evidenceDir: '/private/evidence', users: ['a', 'b'].map(alias => ({ alias, userId: `usr_${alias}`, botId: `bot_${alias}`, sessionFile: `/private/${alias}`, disposableBot: true, connections: [] })) };
}
const plan = { runtime: 'server', selected: 'codex', connected: true, providers: { codex: { installed: true, authenticated: true, subscription: true } } };
function runner(client = {}) { const c = config(); return new Qualification(c, { a: client, b: client }, { fixture: true }); }
const code = expected => e => e instanceof GateError && e.code === expected;
const link = { id: 'private-a', toolkit: 'notion', toolSlug: 'NOTION_FETCH_TEST', arguments: { page: 'test-page' }, expectedMarker: 'secret-sentinel-unique' };

test('configuration requires a dedicated reviewed HTTPS target, explicit budget and separate users', () => {
  assert.equal(validateConfig(config()).target.kind, 'dedicated-staging');
  for (const change of [c => c.target.origin = 'http://qualification.example', c => { c.target.origin = c.target.approvedOrigin = 'https://swarm-team.fly.dev'; }, c => c.target.approvedOrigin = 'https://other.example', c => c.budget.maxTurns = 0, c => c.users[1].userId = c.users[0].userId, c => c.approval.modelLoopRiskAcknowledged = false]) {
    const c = config(); change(c); assert.throws(() => validateConfig(c), GateError);
  }
});

test('private credentials reject public permissions and symlinks', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-qualification-'));
  try {
    const file = path.join(dir, 'session'); await fs.writeFile(file, 'swarm_session=private', { mode: 0o600 });
    assert.equal(await privateFile(file), 'swarm_session=private');
    await fs.symlink(file, path.join(dir, 'link'));
    await assert.rejects(privateFile(path.join(dir, 'link')), code('private-file-must-be-owner-only'));
    await fs.chmod(file, 0o644); await assert.rejects(privateFile(file), code('private-file-must-be-owner-only'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('HTTP client never follows redirects, limits response bodies and does not expose provider errors', async () => {
  let observed;
  const api = new Api('https://qualification.example', 'swarm_session=private', async (url, init) => { observed = init; return new Response(JSON.stringify({ ok: true })); });
  assert.deepEqual(await api.json('/api/cli'), { ok: true });
  assert.equal(observed.redirect, 'error'); assert.equal(observed.headers.cookie, 'swarm_session=private');
  await assert.rejects(api.request('//evil.example/api/x'), GateError);
  const failure = new Api('https://qualification.example', 'swarm_session=private', async () => new Response('secret provider token', { status: 502 }));
  await assert.rejects(failure.request('/api/cli'), e => e.message === 'unexpected-http-502' && !e.message.includes('secret'));
  let cancelled = false;
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedText(new Response(stream), 2000), code('response-too-large'));
  assert.equal(cancelled, true);
});

test('HTTP time budget prevents a new request after the deadline', async () => {
  let called = false;
  const api = new Api('https://qualification.example', 'swarm_session=private', async () => { called = true; return new Response('{}'); });
  api.deadline = Date.now() - 1;
  await assert.rejects(api.request('/api/cli', 'PUT', { provider: 'codex' }), code('run-time-budget-exhausted'));
  assert.equal(called, false);
});

test('live state uses the real array contract and requires the exact Bot entry', () => {
  assert.equal(liveFor({ live: [{ botId: 'bot_a', isRunning: true }] }, 'bot_a').isRunning, true);
  assert.throws(() => liveFor({ live: { bot_a: { isRunning: false } } }, 'bot_a'), code('bot-live-state-missing'));
  assert.throws(() => liveFor({ live: [{ botId: 'bot_b', isRunning: false }] }, 'bot_a'), code('bot-live-state-missing'));
});

test('preflight refuses an already running Bot before qualification writes', async () => {
  let writes = 0;
  const q = runner({ json: async route => route === '/api/health' ? { ok: true, role: 'platform' } : route === '/api/auth/me' ? { user: { id: 'usr_a' } } : { bots: [{ id: 'bot_a' }], live: [{ botId: 'bot_a', isRunning: true }] }, request: async () => { writes++; } });
  await assert.rejects(q.preflight(), code('idle-owned-test-bot-required')); assert.equal(writes, 0);
});

test('a final-looking assistant row cannot finish while the live Bot is running', async () => {
  let reads = 0;
  const q = runner({ json: async route => route.startsWith('/api/bots/bot_a/rows') ? { rows: [{ seq: 2, body: { role: 'assistant', streaming: false, text: 'done' } }] } : { live: [{ botId: 'bot_a', isRunning: ++reads === 1, awaiting: null }] }, request: async () => ({}) });
  const r = await q.observe(q.c.users[0], { seq: 1 });
  assert.equal(reads, 2); assert.equal(r.reply.body.text, 'done');
});

test('error notice takes precedence over a partial assistant reply and interrupts the test Bot', async () => {
  let interrupted = false;
  const q = runner({ json: async route => route.includes('/rows') ? { rows: [{ seq: 2, body: { role: 'assistant', text: 'partial' } }, { seq: 3, body: { type: 'notice', tone: 'error' } }] } : { live: [{ botId: 'bot_a', isRunning: false }] }, request: async route => { interrupted = route.endsWith('/interrupt'); } });
  await assert.rejects(q.observe(q.c.users[0], { seq: 1 }), code('model-turn-failed'));
  assert.equal(interrupted, true);
});

test('API mode or missing selection cannot submit a provider qualification turn', async () => {
  let submitted = 0, charged = 0;
  const q = runner({ json: async route => { if (route === '/api/cli') return { ...plan, selected: null }; submitted++; return {}; } });
  q.consume = async () => { charged++; };
  await assert.rejects(q.turn(q.c.users[0], 'test'), code('subscription-provider-required-before-turn'));
  q.provider = 'codex';
  await assert.rejects(q.turn(q.c.users[0], 'test'), code('plan-changed-before-turn'));
  assert.equal(submitted, 0); assert.equal(charged, 0);
});

test('unexpected and duplicate tool dispatches fail observation rather than becoming a pass', async () => {
  let interrupted = 0;
  const q = runner({ json: async () => ({ rows: [2, 3].map(seq => ({ seq, body: { type: 'tool-call', name: 'remember', status: 'done' } })) }), request: async () => { interrupted++; } });
  await assert.rejects(q.observe(q.c.users[0], { seq: 1 }, { allowedTool: () => true }), code('unexpected-additional-tool-call'));
  assert.equal(interrupted, 1);
});

test('approval is once-only and requires exact allowed tool arguments', async () => {
  let approved = 0;
  const rows = [{ seq: 2, body: { type: 'tool-call', name: 'mcp_test', status: 'awaiting-approval', args: { probe: 'a' } } }, { seq: 3, body: { card: 'approval', status: 'pending', approvalId: 'apr', args: { probe: 'DIFFERENT' } } }];
  const q = runner({ json: async () => ({ rows }), request: async route => { if (route.startsWith('/api/approvals')) approved++; } });
  await assert.rejects(q.observe(q.c.users[0], { seq: 1 }, { allowedTool: b => b.name === 'mcp_test', approve: true }), code('manual-approval-required'));
  assert.equal(approved, 0);
});

function readRunner(summary = 'ok', records) {
  const q = runner(); q.c.users[0].connections = [link];
  let n = 0;
  q.providerWitness = async () => ++n === 1 ? { cursor: 10, records: [] } : { cursor: 12, records: records ?? [{ kind: 'execute', sequence: 12, status: 'success', connectionHash: sha(link.id), toolSlug: link.toolSlug, argumentsHash: sha(JSON.stringify(link.arguments)) }] };
  q.turn = async () => ({ reply: { body: { text: link.expectedMarker } }, rows: [{ body: { name: 'SWARM_APPS_EXECUTE', status: 'done', summary, args: { revision: 3 } } }] });
  return q;
}

test('a failed SDK envelope cannot pass from a memorized marker', async () => {
  const q = readRunner('failed');
  await assert.rejects(q.connectedRead(q.c.users[0], link), code('private-account-read-not-proven'));
});

test('prose and done rows require a fresh independent provider execution witness', async () => {
  const q = readRunner('ok', []);
  await assert.rejects(q.connectedRead(q.c.users[0], link), code('fresh-provider-read-not-proven'));
  const good = readRunner(); await good.connectedRead(good.c.users[0], link);
});

test('implicit defaults remain incomplete without SEARCH output bound to EXECUTE revision', async () => {
  const q = readRunner();
  await assert.rejects(q.connectedRead(q.c.users[0], link, true), e => code('default-search-result-witness-required')(e) && e.incomplete);
  const execution = { kind: 'execute', sequence: 12, status: 'success', connectionHash: sha(link.id), toolSlug: link.toolSlug, argumentsHash: sha(JSON.stringify(link.arguments)) };
  for (const revision of [2, 3]) {
    const q2 = readRunner('ok', [{ kind: 'search', sequence: 11, explicitConnection: false, toolkit: link.toolkit, connectionHash: sha(link.id), revision }, execution]);
    if (revision === 2) await assert.rejects(q2.connectedRead(q2.c.users[0], link, true), code('default-search-result-witness-required'));
    else await q2.connectedRead(q2.c.users[0], link, true);
  }
});

test('unknown quota remains incomplete instead of zero usage', async () => {
  const q = runner(); q.catalog = async () => ({ plan: 'max', models: [], usage: { available: false, windows: [] } });
  await assert.rejects(q.quota(q.c.users[0], 'claude'), e => code('provider-quota-not-reported')(e) && e.incomplete);
});

test('receipts redact unexpected errors and retain incomplete status', async () => {
  const q = runner(); let saved;
  q.persist = async report => { saved = structuredClone(report); };
  await assert.rejects(q.record('secret-check', {}, async () => { throw new Error('secret-cookie-value'); }));
  assert.equal(saved.cases[0].code, 'unexpected-error-redacted'); assert.ok(!JSON.stringify(saved).includes('secret-cookie-value'));
  await assert.rejects(q.record('quota', {}, async () => { throw new GateError('quota-unavailable', true); }));
  assert.equal(saved.cases[1].status, 'incomplete'); assert.equal(saved.releaseQualified, false); assert.equal(saved.scope, 'simulated-harness-self-test');
});

test('OAuth start requires a terminal before creating an authorization attempt', async () => {
  let called = false;
  const q = runner({ json: async () => { called = true; } }); q.terminal = { isTTY: false };
  await assert.rejects(q.oauthStart(q.c.users[0], 'mcp', 0), code('interactive-terminal-required'));
  assert.equal(called, false);
});

test('same-provider overlapping account coverage cannot pass with one account per user', async () => {
  const q = runner(); q.c.users[0].connections = [link]; q.c.users[1].connections = [{ ...link, id: 'private-b' }];
  await assert.rejects(q.connections(q.c.users[0]), e => code('same-owner-overlapping-provider-accounts-required')(e) && e.incomplete);
});

test('OAuth callback checks foreign owner, same-owner other session, real success and replay in order', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qualification-oauth-'));
  try {
    const file = path.join(dir, 'observer'); await fs.writeFile(file, 'swarm_session=observer', { mode: 0o600 });
    const events = []; let ownerCalls = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(init.headers.cookie, 'swarm_session=observer'); assert.equal(init.redirect, 'error');
      if (new URL(url).pathname === '/api/auth/me') return Response.json({ user: { id: 'usr_a' } });
      events.push('observer'); return Response.json({ error: 'wrong session' }, { status: 400 });
    };
    const q = runner(); q.c.users[0].observerSessionFile = file;
    q.clients.a = { cookie: 'swarm_session=initiator', request: async (_url, _method, _body, accepted = [200]) => { events.push(++ownerCalls === 1 ? 'success' : 'replay'); assert.ok(accepted.includes(ownerCalls === 1 ? 200 : 400)); return { text: 'MCP connected' }; } };
    q.clients.b = { request: async (_url, _method, _body, accepted) => { events.push('foreign'); assert.ok(accepted.includes(400)); } };
    await q.verifyOAuthCallback(q.c.users[0], 'mcp', q.c.target.origin + '/api/mcp/servers/oauth/callback?state=ephemeral&code=private');
    assert.deepEqual(events, ['foreign', 'observer', 'success', 'replay']);
    await assert.rejects(q.verifyOAuthCallback(q.c.users[0], 'mcp', 'https://evil.example/api/mcp/servers/oauth/callback?state=private'), code('unexpected-oauth-callback'));
    assert.equal(events.length, 4);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('model matrix uses every catalog model/effort, fresh image challenge, incremental usage and restoration', async () => {
  let selected = { model: 'codex/original', effort: 'low', fast: true }, marker, imageMarker, memory, requests = 0;
  const counts = new Map(), patches = [], seen = [];
  const usage = () => ({ provider: 'codex-cli', byBot: [{ key: 'bot_a', requests, costUsd: 0 }], byModel: [...counts].map(([key, requests]) => ({ key, requests, costUsd: 0 })) });
  const q = runner({
    json: async (route, method, body) => {
      if (route === '/api/bots') return { bots: [{ id: 'bot_a', ...selected }] };
      if (route === '/api/bots/bot_a' && method === 'PATCH') { selected = { ...body }; patches.push(body); return { bot: selected }; }
      if (route.includes('/usage?')) return usage();
      if (route.endsWith('/memories')) return { memories: memory ? [memory] : [] };
      if (route === '/api/cli') return plan;
      throw new Error('unexpected fake route');
    }, request: async (route, method, body) => { if (route.startsWith('/api/memories/')) memory = undefined; else if (route === '/api/bots/bot_a') selected = body; else throw new Error('unexpected fake request'); },
  });
  q.catalog = async () => ({ models: [{ id: 'codex/vision', efforts: ['low', 'high'], vision: true }, { id: 'codex/text', efforts: [], vision: false }] });
  q.prepareImage = async () => { imageMarker = 'fresh-unseen-image-code'; return imageMarker; };
  q.turn = async (_u, prompt) => {
    seen.push({ model: selected.model, effort: selected.effort, prompt }); requests++; counts.set(selected.model, (counts.get(selected.model) ?? 0) + 1);
    if (prompt.startsWith('Use only remember')) {
      marker = prompt.match(/test memory: ([^.]+)/)[1]; memory = { id: 'mem', text: marker };
      return { reply: { body: { text: marker } }, rows: [{ body: { name: 'remember', status: 'done' } }] };
    }
    if (prompt.startsWith('Use computer_screenshot')) { assert.ok(!prompt.includes(imageMarker)); return { reply: { body: { text: imageMarker } }, rows: [{ body: { name: 'computer_screenshot', status: 'done' } }] }; }
    return { reply: { body: { text: prompt.match(/exactly ([^,]+)/)[1] } }, rows: [] };
  };
  await q.models(q.c.users[0], 'codex');
  assert.deepEqual(patches.map(p => [p.model, p.effort, p.fast]), [['codex/vision', 'low', false], ['codex/vision', 'high', false], ['codex/text', 'medium', false]]);
  assert.equal(seen.length, 5); assert.deepEqual(selected, { model: 'codex/original', effort: 'low', fast: true });
  assert.equal(q.report.cases.length, 4); assert.ok(q.report.cases.every(c => c.status === 'pass'));
});

test('Composio revocation requires the stale revision refused and no new provider dispatch', async () => {
  for (const leaked of [false, true]) {
    let removed = false, witness = 0;
    const q = runner({ json: async () => ({ connections: removed ? [] : [{ id: link.id, revision: 3 }] }), request: async () => { removed = true; } });
    q.c.users[0].connections = [link]; q.connectedRead = async () => {};
    q.providerWitness = async () => ({ cursor: ++witness === 1 || !leaked ? 5 : 6, records: leaked && witness > 1 ? [{ sequence: 6 }] : [] });
    q.turn = async (_u, prompt, opts) => {
      assert.ok(removed); assert.ok(prompt.includes('"revision":3'));
      assert.ok(opts.allowedTool({ name: 'SWARM_APPS_EXECUTE', args: { connectionId: link.id, revision: 3, tool_slug: link.toolSlug, arguments: link.arguments } }));
      return { rows: [{ body: { name: 'SWARM_APPS_EXECUTE', status: 'error' } }] };
    };
    if (leaked) await assert.rejects(q.revokeConnection(q.c.users[0], 0), code('revoked-dispatch-reached-provider'));
    else assert.equal((await q.revokeConnection(q.c.users[0], 0)).staleDispatchBlocked, true);
  }
});

test('MCP pending approval is invalidated before allow and checked against the independent audit', async () => {
  for (const leaked of [false, true]) {
    let enabled = true, allowed = false, audited = 0;
    const q = runner({
      json: async (_route, method) => { if (method === 'PATCH') { enabled = false; return { server: { enabled } }; } return { servers: [{ id: 'mcp-a', enabled, requireApproval: true }] }; },
      request: async route => { if (route.startsWith('/api/approvals')) { assert.equal(enabled, false); allowed = true; } },
    });
    q.c.users[0].mcp = { serverId: 'mcp-a', toolName: 'mcp_probe', nonceArgument: 'probe' };
    q.mcp = async () => {};
    q.mcpAudit = async () => ++audited === 1 || !leaked ? 0 : 1;
    q.turn = async () => ({ approval: { body: { approvalId: 'apr' } }, sent: { seq: 4 } });
    q.observe = async () => { assert.ok(allowed); return { rows: [{ body: { name: 'mcp_probe', status: 'denied' } }] }; };
    if (leaked) await assert.rejects(q.revokeMcp(q.c.users[0]), code('revoked-mcp-call-reached-provider'));
    else assert.equal((await q.revokeMcp(q.c.users[0])).localDispatchRevocation, true);
  }
});

test('CLI revocation never treats an API catalog as blocked subscription success', async () => {
  let sent = false;
  const q = runner({ json: async route => {
    if (route === '/api/cli/pair') return {};
    if (route === '/api/cli') return { selected: 'codex', connected: false };
    if (route === '/api/models') return { billing: 'api', models: [], error: 'offline' };
    sent = true; return {};
  } }); q.select = async () => {};
  await assert.rejects(q.revokeCli(q.c.users[0], 'codex'), code('revoked-cli-catalog-failed-open')); assert.equal(sent, false);
});

test('CLI revocation requires both an error turn and unchanged recorded inference', async () => {
  for (const charged of [false, true]) {
    let usageReads = 0;
    const q = runner({ json: async route => {
      if (route === '/api/cli/pair') return {};
      if (route === '/api/cli') return { selected: 'codex', connected: false };
      if (route === '/api/models') return { billing: 'plan', models: [], error: 'offline' };
      if (route.startsWith('/api/usage')) return { totals: { requests: ++usageReads === 1 || !charged ? 17 : 18, costUsd: 0 } };
      if (route.endsWith('/messages')) return { row: { seq: 10 } };
      return { rows: [{ seq: 11, body: { type: 'notice', tone: 'error' } }] };
    }, request: async () => {} }); q.select = async () => {};
    if (charged) await assert.rejects(q.revokeCli(q.c.users[0], 'codex'), code('revoked-cli-recorded-inference'));
    else await q.revokeCli(q.c.users[0], 'codex');
  }
});

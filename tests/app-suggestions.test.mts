import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { availableSuggestions, createSuggestionRanker, suggestionInput } from '../server/src/app-suggestions.js';
import { toolkitLogo } from '../web/src/lib/toolkitLogos.js';

const toolkit = (slug: string, name: string, description: string) => ({ slug, name, description, categories: ['Work'], managedAuth: true, noAuth: false, logo: `https://logos.composio.dev/api/${slug}` });
const catalogItems = [toolkit('github', 'GitHub', 'Repositories and pull requests'), toolkit('slack', 'Slack', 'Team messages'), toolkit('googlecalendar', 'Google Calendar', 'Events and schedules')];
const context = { description: 'track GitHub PRs and post to Slack', instructions: 'Summarize review status', purpose: 'Coordinate engineering' };
const choices = { suggestions: [{ slug: 'github', reason: 'Track GitHub pull requests.' }, { slug: 'slack', reason: 'Post updates to Slack.' }] };

test('catalog metadata wins over bundled logos and every logo URL is same-origin', () => {
  assert.equal(toolkitLogo(catalogItems[0]), '/api/toolkits/icon/github');
  assert.equal(toolkitLogo({ slug: 'github', name: 'GitHub' }), '/assets/toolkits/github.svg');
  assert.equal(toolkitLogo({ slug: 'otherapp', name: 'Other App' }), '/api/toolkits/icon/otherapp');
  assert.equal(toolkitLogo({ name: 'Unknown', logo: 'https://untrusted.example/logo.svg' }), undefined);
});

test('ranking uses Bot description, instructions, purpose and the full available catalog', async () => {
  const inputs: any[] = [];
  const rank = createSuggestionRanker(async input => {
    const data = JSON.parse(input); inputs.push(data);
    return data.bot.description.includes('calendar') ? { suggestions: [{ slug: 'googlecalendar', reason: 'Manage Google Calendar events.' }] } : choices;
  });
  assert.deepEqual(availableSuggestions(await rank('owner', 'model', context, catalogItems), catalogItems, new Set()).map(item => item.slug), ['github', 'slack']);
  const calendar = await rank('owner', 'model', { ...context, description: 'manage my calendar' }, catalogItems);
  assert.deepEqual(availableSuggestions(calendar, catalogItems, new Set()).map(item => item.name), ['Google Calendar']);
  assert.deepEqual(inputs[0].bot, context);
  assert.deepEqual(inputs[0].catalog.map((item: any) => item.slug).sort(), catalogItems.map(item => item.slug).sort());
  assert.equal(JSON.parse(suggestionInput(context, catalogItems)).catalog.find((item: any) => item.slug === 'googlecalendar').description, 'Events and schedules');
});

test('large catalogs fit a small context budget and retain named and semantic candidates from the last page', async () => {
  const large = [...Array.from({ length: 1723 }, (_, index) => toolkit(`app${index}`, `Other App ${index}`, 'Image editing and design tools. '.repeat(6))), ...catalogItems];
  const input = suggestionInput(context, large, 4096);
  assert.ok(Buffer.byteLength(input) <= 4096 - 2000);
  const names = JSON.parse(input).catalog.map((item: any) => item.slug);
  assert.ok(names.includes('github')); assert.ok(names.includes('slack'));
  const calendar = JSON.parse(suggestionInput({ description: 'manage my calendar', instructions: '', purpose: '' }, large, 4096));
  assert.equal(calendar.catalog[0].slug, 'googlecalendar');
  const long = suggestionInput({ ...context, instructions: 'Review work. '.repeat(1000), purpose: 'Coordinate work. '.repeat(1000) }, large, 4096);
  assert.ok(Buffer.byteLength(long) <= 4096 - 2000);
});

test('serialized escaped and multilingual Bot fields fit the budget with relevant candidates', () => {
  for (const text of [String.fromCharCode(1), '\\"', '日程管理🗓']) {
    const input = suggestionInput({ description: 'Manage my calendar', instructions: text.repeat(8000), purpose: text.repeat(4000) }, catalogItems, 4096);
    assert.ok(Buffer.byteLength(input) <= 4096 - 2000);
    assert.ok(JSON.parse(input).catalog.some((item: any) => item.slug === 'googlecalendar'));
  }
});

test('never returns unavailable, duplicate or connected toolkits, nor model-supplied identity', () => {
  const value = { suggestions: [{ slug: 'invented', reason: 'Unavailable' }, { slug: 'github', name: 'Fake name', logo: 'https://fake.example', reason: 'Review pull requests.' }, ...choices.suggestions, { slug: 'googlecalendar', reason: '' }, null] };
  assert.deepEqual(availableSuggestions(value, catalogItems, new Set(['slack'])), [{ ...catalogItems[0], reason: 'Review pull requests.' }]);
  assert.deepEqual(availableSuggestions(value, catalogItems.slice(2), new Set()), []);
  assert.throws(() => availableSuggestions({}, catalogItems, new Set()), /Invalid/);
});

test('cache shares identical requests, isolates accounts and accepts new edits while a slow result is pending', async () => {
  const pending: Array<(value: unknown) => void> = [];
  const rank = createSuggestionRanker(() => new Promise(resolve => pending.push(resolve)));
  const first = rank('owner', 'model', context, catalogItems);
  const same = rank('owner', 'model', context, catalogItems);
  const next = rank('owner', 'model', { ...context, description: 'calendar' }, catalogItems);
  const other = rank('another-account', 'model', context, catalogItems);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.length, 3);
  pending[1]({ suggestions: [{ slug: 'googlecalendar', reason: 'Manage events.' }] });
  assert.equal((await next as any).suggestions[0].slug, 'googlecalendar');
  pending[0](choices); pending[2]({ suggestions: [] });
  assert.deepEqual(await first, choices); assert.deepEqual(await same, choices); await other;
  await rank('owner', 'model', context, catalogItems);
  assert.equal(pending.length, 3);
});

test('empty context or catalog does not invoke a model; failures can be retried', async () => {
  let calls = 0;
  const rank = createSuggestionRanker(async () => { if (++calls === 1) throw new Error('offline'); return choices; });
  assert.deepEqual(await rank('owner', 'model', context, []), { suggestions: [] });
  assert.deepEqual(await rank('owner', 'model', { description: '', instructions: '', purpose: '' }, catalogItems), { suggestions: [] });
  assert.equal(calls, 0);
  await assert.rejects(rank('owner', 'model', context, catalogItems), /offline/);
  assert.deepEqual(await rank('owner', 'model', context, catalogItems), choices);
});

test('a hung ranking expires and the same context can be retried', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, failed = false;
  const rank = createSuggestionRanker(async () => ++calls === 1 ? new Promise(() => {}) : choices);
  const pending = rank('owner', 'model', context, catalogItems).catch(() => { failed = true; });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(12_000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed, true, 'a provider that never settles must not keep the cache pending');
  await pending;
  assert.deepEqual(await rank('owner', 'model', context, catalogItems), choices);
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-suggestions-'));
Object.assign(process.env, { SWARM_ROLE: 'standalone', DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'suggestions-fixture', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: 'fixture-project', DIRECT_API_KEY: 'fixture-key', LLM_PROVIDER: 'direct', OPENROUTER_API_KEY: '', INKBOX_TUNNEL: '0' });
const iconRequests: string[] = [];
let items = catalogItems;
mock.method(globalThis, 'fetch', async (input: any, init: any) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'registry.npmjs.org') return Response.json({ version: '0.28.0' });
  if (url.hostname === 'telemetry.composio.dev') return Response.json({});
  if (url.hostname === 'backend.composio.dev') return Response.json({ items: items.map(item => ({ slug: item.slug, name: item.name, meta: { logo: item.logo, description: item.description, categories: [] } })) });
  if (url.hostname === 'openrouter.ai') return Response.json({ data: [] });
  if (url.hostname === 'logos.composio.dev') {
    iconRequests.push(url.pathname);
    assert.equal(init.redirect, 'error'); assert.ok(init.dispatcher);
    if (url.pathname === '/html') return new Response('<html>not an image</html>', { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/large') return new Response(new Uint8Array(400_001), { headers: { 'content-type': 'image/png' } });
    if (url.pathname === '/redirect') return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>', { headers: { 'content-type': 'image/svg+xml' } });
  }
  throw new Error('Unexpected fixture network request');
});
const { db } = await import('../server/src/db.js');
const { setEnvOverride } = await import('../server/src/env.js');
const { composio } = await import('../server/src/composio.js');
const { createBot } = await import('../server/src/bots.js');
const { getSetup } = await import('../server/src/bot-setup.js');
const { llmClient } = await import('../server/src/lib/llm.js');
const { api } = await import('../server/src/routes.js');
const { toolkitIcon } = await import('../server/src/toolkit-icons.js');
const { Hono } = await import('hono');
const app = new Hono().route('/api', api);
for (const id of ['owner', 'another-account']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, 'Test account', Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES (session_hash(?),?,?,?)').run(id, id, Date.now(), Date.now() + 3600_000);
}
const bot = createBot('owner', { name: 'Review Bot', description: context.description, instructions: context.instructions });
let accounts: any[] = [];
mock.method(composio().connectedAccounts, 'list', async () => ({ items: accounts, nextCursor: null }));
const modelInputs: any[] = [];
let heldModel: { entered: () => void; wait: Promise<void> } | undefined;
let malformedModel = false;
mock.method(llmClient(30_000).responses, 'create', async (body: any) => {
  modelInputs.push(body);
  if (heldModel) { heldModel.entered(); await heldModel.wait; }
  if (malformedModel) return { output_text: 'not JSON' };
  const input = JSON.parse(body.input[1].content);
  const selected = input.bot.description.includes('calendar') ? { suggestions: [{ slug: 'googlecalendar', reason: 'Manage calendar events.' }, { slug: 'unavailable', reason: 'Never visible.' }] } : choices;
  return { output_text: JSON.stringify(selected), usage: { input_tokens: 10, output_tokens: 10, cost_in_usd_ticks: 0 } };
});
const suggest = (body: unknown = {}, owner = 'owner') => app.request(`/api/bots/${bot.id}/suggested-apps`, { method: 'POST', headers: { cookie: `swarm_session=${owner}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('authenticated suggestion route uses owned Bot context, accepts drafts, and filters unavailable or newly connected apps', async () => {
  assert.equal(getSetup(bot.id)!.onboarding.status, 'interviewing');
  const first = await suggest(); assert.equal(first.status, 200);
  assert.deepEqual((await first.json() as any).suggestions.map((item: any) => item.slug), ['github', 'slack']);
  assert.equal(JSON.parse(modelInputs[0].input[1].content).bot.instructions, context.instructions);
  assert.equal(JSON.parse(modelInputs[0].input[1].content).bot.description, context.description);
  assert.ok(JSON.parse(modelInputs[0].input[1].content).bot.purpose);
  assert.deepEqual(modelInputs[0].tools, []);
  accounts = [{ id: 'fixture-slack', toolkit: { slug: 'slack' }, status: 'ACTIVE' }];
  assert.deepEqual((await (await suggest()).json() as any).suggestions.map((item: any) => item.slug), ['github']);
  assert.equal(modelInputs.length, 1, 'connection changes filter cached rankings');
  const calendar = await suggest({ description: 'manage my calendar' });
  assert.deepEqual((await calendar.json() as any).suggestions.map((item: any) => item.name), ['Google Calendar']);
  assert.equal((await suggest({}, 'another-account')).status, 404);
  assert.equal((await suggest({}, 'missing-session')).status, 401);
  assert.equal((await suggest({ description: 'x'.repeat(301) })).status, 400);
  assert.equal((await suggest({ instructions: 'x'.repeat(8001) })).status, 400);
  accounts = [{ id: 'fixture-slack', toolkit: { slug: 'slack' }, status: 'ACTIVE', isDisabled: true }];
  assert.deepEqual((await (await suggest()).json() as any).suggestions.map((item: any) => item.slug), ['github', 'slack']);
});

test('logo route is catalog-bound, metadata-first, and returns sandboxed images for a self-only CSP', async () => {
  const request = (slug: string, owner = 'owner') => app.request(`/api/toolkits/icon/${slug}`, { headers: { cookie: `swarm_session=${owner}` } });
  assert.equal((await request('github', 'missing-session')).status, 401);
  assert.equal((await request('unavailable')).status, 404);
  assert.equal(iconRequests.length, 0);
  const response = await request('github');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.match(response.headers.get('content-security-policy')!, /sandbox/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(iconRequests, ['/api/github']);
  await request('github'); assert.equal(iconRequests.length, 1);
  assert.equal(await toolkitIcon('http://127.0.0.1/secret'), null);
  assert.equal(await toolkitIcon('https://169.254.169.254/secret'), null);
  assert.equal(await toolkitIcon('https://logos.composio.dev/html'), null);
  assert.equal(await toolkitIcon('https://logos.composio.dev/large'), null);
  assert.equal(await toolkitIcon('https://logos.composio.dev/redirect'), null);
});

test('malformed model output fails closed and a retry can recover without cached errors', async () => {
  malformedModel = true;
  const failed = await suggest({ description: 'A different review purpose' });
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /not JSON/);
  malformedModel = false;
  const retry = await suggest({ description: 'A different review purpose' });
  assert.equal(retry.status, 200);
  assert.deepEqual((await retry.json() as any).suggestions.map((item: any) => item.slug), ['github', 'slack']);
});

test('a stalled connection lookup times out the whole route and can be retried', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = Promise.withResolvers<void>();
  let aborted = false;
  const list = mock.method(composio().connectedAccounts, 'list', async (_body: unknown, options: any) => {
    options?.signal?.addEventListener('abort', () => { aborted = true; });
    entered.resolve();
    return new Promise<any>(() => {});
  });
  try {
    let response: Response | undefined;
    const pending = suggest().then(value => { response = value; });
    await entered.promise;
    t.mock.timers.tick(10_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(response?.status, 503);
    assert.equal(aborted, true);
    await pending;
  } finally { list.mock.restore(); }
  assert.equal((await suggest()).status, 200);
});

test('missing catalog configuration is an error, not a successful empty ranking', async () => {
  const previous = process.env.COMPOSIO_API_KEY;
  process.env.COMPOSIO_API_KEY = '';
  setEnvOverride('COMPOSIO_API_KEY', '');
  try { assert.equal((await suggest()).status, 503); }
  finally {
    process.env.COMPOSIO_API_KEY = previous;
    setEnvOverride('COMPOSIO_API_KEY', 'fixture-project');
    mock.method(composio().connectedAccounts, 'list', async () => ({ items: [], nextCursor: null }));
  }
});

test('a stalled catalog request times out without starting a model request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setEnvOverride('COMPOSIO_API_KEY', 'catalog-timeout-fixture');
  mock.method(composio().connectedAccounts, 'list', async () => ({ items: [], nextCursor: null }));
  const entered = Promise.withResolvers<void>();
  const originalFetch = globalThis.fetch;
  const fetch = mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'backend.composio.dev') { entered.resolve(); return new Promise<Response>(() => {}); }
    return originalFetch(input, init);
  });
  const before = modelInputs.length;
  try {
    let response: Response | undefined;
    const pending = suggest().then(value => { response = value; });
    await entered.promise;
    t.mock.timers.tick(10_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(response?.status, 503);
    assert.equal(modelInputs.length, before);
    await pending;
  } finally { fetch.mock.restore(); }
  assert.equal((await suggest()).status, 200);
});

test('catalog replacement during generation cannot return an app from the old project', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  heldModel = { entered: entered.resolve, wait: release.promise };
  const pending = suggest({ description: 'track GitHub PRs and post to Slack for this project' });
  await entered.promise;
  items = catalogItems.slice(2);
  setEnvOverride('COMPOSIO_API_KEY', 'replacement-fixture-project');
  mock.method(composio().connectedAccounts, 'list', async () => ({ items: [], nextCursor: null }));
  release.resolve();
  const response = await pending;
  heldModel = undefined;
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as any).suggestions, []);
});

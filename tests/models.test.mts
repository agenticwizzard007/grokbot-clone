// Composer model picker, effort levels (incl. Ultracode), Fast routing, favourites, icons, and a Bot's analytics.
//   node --import tsx --test --test-concurrency=1 tests/models.test.mts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-models-'));
const free = () => new Promise<number>((r) => { const s = http.createServer().listen(0, () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
const mockPort = await free();
const mock = spawn(process.execPath, [path.join(import.meta.dirname, 'mock-provider.mjs'), String(mockPort)], { stdio: 'ignore' });
for (let i = 0; i < 50; i++) { if (await fetch(`http://localhost:${mockPort}/_requests`).then(() => true, () => false)) break; await new Promise((r) => setTimeout(r, 100)); }

Object.assign(process.env, {
  DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'test-only-secret', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '',
  OPENROUTER_API_KEY: 'test', OPENROUTER_BASE_URL: `http://localhost:${mockPort}/api/v1`, DIRECT_API_KEY: 'test', DIRECT_BASE_URL: `http://localhost:${mockPort}/v1`,
  LLM_PROVIDER: 'openrouter', SERVER_URL: 'http://localhost:1', APP_URL: 'http://localhost:1', INKBOX_TUNNEL: '0',
});

const { db } = await import('../server/src/db.js');
const { initSubagents } = await import('../server/src/agent/subagents.js');
const { initRooms } = await import('../server/src/agent/rooms.js');
initSubagents(); initRooms();
const { enqueue } = await import('../server/src/agent/loop.js');
const { appendRow, appendHistory, listRows } = await import('../server/src/store.js');
const { createAccount } = await import('../server/src/accounts.js');
const { effortFor, withFast, providerFields, textOnlyInput } = await import('../server/src/lib/llm.js');
const { botAnalytics, toolMinutes, RATES } = await import('../server/src/analytics.js');
const { shortName, modelsApi } = await import('../server/src/routes-models.js');
const { api } = await import('../server/src/routes.js');
const { Hono } = await import('hono');

after(() => { mock.kill(); });

const owner = createAccount({ email: 'owner@example.com', name: 'Owner' }).id;
const other = createAccount({ email: 'other@example.com', name: 'Other' }).id;
const botOf = (userId: string) => (db.prepare('SELECT id FROM bots WHERE user_id=? ORDER BY created_at LIMIT 1').get(userId) as { id: string }).id;

const app = new Hono();
app.route('/api', api);
app.route('/api', modelsApi);
const session = (userId: string) => {
  const t = `t_${userId}`;
  const at = Date.now();
  db.prepare('INSERT OR REPLACE INTO auth_sessions(token,user_id,created_at,expires_at,last_seen_at,authenticated_at) VALUES (session_hash(?),?,?,?,?,?)').run(t, userId, at, at + 3_600_000, at, at);
  return `swarm_session=${t}`;
};
const call = async (userId: string, method: string, url: string, body?: unknown) => {
  const r = await app.request(url, { method, headers: { cookie: session(userId), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null };
};

test('effort snaps to what the model accepts; Ultracode asks for its top level', () => {
  const anthropic = ['max', 'xhigh', 'high', 'medium', 'low'];
  const gpt = ['xhigh', 'high', 'medium', 'low', 'none'];
  assert.equal(effortFor('high', anthropic), 'high');
  assert.equal(effortFor('ultracode', anthropic), 'max');
  assert.equal(effortFor('ultracode', gpt), 'xhigh');
  assert.equal(effortFor('max', gpt), 'xhigh', 'nearest supported level');
  assert.equal(effortFor('minimal', anthropic), 'low');
  assert.equal(effortFor('none', anthropic), 'low', "a model that can't switch reasoning off gets its lowest level");
  assert.equal(effortFor('ultracode', null), 'max', 'null = every gateway level');
  assert.equal(effortFor('high', []), undefined, 'no effort selection → send none');
  assert.deepEqual(providerFields({ effort: 'ultracode', reasoning: true, efforts: anthropic, cacheKey: 'k', safetyId: 's' }), { reasoning: { effort: 'max' } });
  assert.deepEqual(providerFields({ effort: 'high', reasoning: false, efforts: anthropic, cacheKey: 'k', safetyId: 's' }), {});
});

test('Fast routes to the :nitro variant, once', () => {
  assert.equal(withFast('anthropic/claude-opus-5.5', true), 'anthropic/claude-opus-5.5:nitro');
  assert.equal(withFast('anthropic/claude-opus-5.5', false), 'anthropic/claude-opus-5.5');
  assert.equal(withFast('openai/gpt-4.1:free', true), 'openai/gpt-4.1:free', 'never stacks suffixes');
});

test('short names drop the maker prefix', () => {
  assert.equal(shortName({ name: 'Anthropic: Claude Opus 5.5', author: 'anthropic' }), 'Opus 5.5');
  assert.equal(shortName({ name: 'OpenAI: GPT-5.5', author: 'openai' }), 'GPT-5.5');
  assert.equal(shortName({ name: 'Plain', author: 'x' }), 'Plain');
});

test('GET /api/models: catalog with effort levels and suggested favourites; favourites save per user', async () => {
  const r = await call(owner, 'GET', '/api/models');
  assert.equal(r.status, 200);
  assert.equal(r.body.provider, 'openrouter');
  assert.equal(r.body.canFast, true);
  const opus = r.body.models.find((m: any) => m.id === 'anthropic/claude-opus-5.5');
  assert.deepEqual(opus.efforts, ['max', 'xhigh', 'high', 'medium', 'low']);
  assert.equal(opus.defaultEffort, 'high');
  assert.equal(opus.short, 'Opus 5.5');
  assert.equal(r.body.models.find((m: any) => m.id === 'deepseek/deepseek-v4').efforts.length, 0, 'no reasoning object → no effort selection');
  assert.ok(!r.body.models.some((m: any) => m.id.endsWith(':batch')));
  assert.equal(r.body.suggested, true);
  assert.ok(r.body.favourites.includes('anthropic/claude-opus-5.5'));

  const saved = await call(owner, 'PUT', '/api/models/favourites', { ids: ['openai/gpt-4.1', 'openai/gpt-4.1', 'anthropic/claude-sonnet-5.5', 42] });
  assert.deepEqual(saved.body.favourites, ['openai/gpt-4.1', 'anthropic/claude-sonnet-5.5'], 'deduplicated, strings only');
  const again = await call(owner, 'GET', '/api/models');
  assert.deepEqual(again.body.favourites, ['openai/gpt-4.1', 'anthropic/claude-sonnet-5.5']);
  assert.equal(again.body.suggested, false);
  assert.equal((await call(other, 'GET', '/api/models')).body.suggested, true, "one user's favourites don't leak to another");
  assert.equal((await call(owner, 'PUT', '/api/models/favourites', { ids: 'nope' })).status, 400);
});

test('icons: unknown makers 404 without fetching anything', async () => {
  assert.equal((await call(owner, 'GET', '/api/models/icon/somebody-new')).status, 404);
});

test('PATCH /bots/:id validates effort and fast', async () => {
  const b = botOf(owner);
  assert.equal((await call(owner, 'PATCH', `/api/bots/${b}`, { effort: 'turbo' })).status, 400);
  assert.equal((await call(owner, 'PATCH', `/api/bots/${b}`, { fast: 'yes' })).status, 400);
  const ok = await call(owner, 'PATCH', `/api/bots/${b}`, { model: 'anthropic/claude-opus-5.5', effort: 'ultracode', fast: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.bot.effort, 'ultracode');
  assert.equal(ok.body.bot.fast, true);
});

test('a turn on Ultracode + Fast sends the :nitro model and the max effort, and tells the Bot to verify', async () => {
  const b = botOf(owner);
  const t0 = Date.now();
  appendRow(b, 'message', { type: 'message', role: 'user', text: 'mock: say all done' } as any);
  enqueue(b, { type: 'user', text: 'mock: say all done' } as any);
  let turn: any;
  for (let i = 0; i < 100 && !turn; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const reqs = ((await (await fetch(`http://localhost:${mockPort}/_requests`)).json()) as any[]).filter((r) => r.at >= t0);
    turn = reqs.find((r) => r.body?.model?.startsWith('anthropic/claude-opus-5.5'));
  }
  assert.ok(turn, 'the turn reached the model');
  assert.equal(turn.body.model, 'anthropic/claude-opus-5.5:nitro');
  assert.deepEqual(turn.body.reasoning, { effort: 'max' });
  assert.match(JSON.stringify(turn.body.input[0]), /Ultracode/);
});

test('analytics: messages per day and time saved from what the Bot did', () => {
  const b = botOf(other);
  const t = Date.now();
  const add = (kind: string, body: any) => db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(b, -5, Math.floor(Math.random() * 1e9), 1, kind, JSON.stringify(body), t);
  add('message', { type: 'message', role: 'user', text: 'research the venues' });
  add('message', { type: 'message', role: 'assistant', text: Array(400).fill('word').join(' ') }); // 400 words → 10 min
  add('message', { type: 'message', role: 'assistant', text: 'streaming…', streaming: true }); // not counted
  add('tool-call', { type: 'tool-call', name: 'open_browser', status: 'done', args: {} }); // 3 min
  add('tool-call', { type: 'tool-call', name: 'computer_click', status: 'done', args: {} }); // 0.5
  add('tool-call', { type: 'tool-call', name: 'shell', status: 'done', args: {} }); // 1
  add('tool-call', { type: 'tool-call', name: 'GMAIL_SEND_EMAIL', status: 'done', args: {} }); // 2
  add('tool-call', { type: 'tool-call', name: 'remember', status: 'done', args: {} }); // 0
  add('tool-call', { type: 'tool-call', name: 'open_browser', status: 'error', args: {} }); // failed → 0
  db.prepare("INSERT INTO usage_events(user_id,bot_id,kind,provider,model,tool_calls,created_at,cost_usd) VALUES (?,?,?,?,?,?,?,?)").run(other, b, 'chat', 'openrouter', 'm', 3, t, 0); // 3 searches → 6

  const a = botAnalytics(b, '7d');
  assert.equal(a.days.length, 7);
  assert.equal(a.totals.messages, 2);
  assert.equal(a.totals.minutesSaved, 10 + 3 + 0.5 + 1 + 2 + 6);
  assert.deepEqual(a.breakdown.map((x) => x.key), ['writing', 'research', 'apps', 'computer']);
  assert.equal(a.days[6].messages, 2, "today's bucket");
  assert.equal(botAnalytics(b, '90d').days.length, 90);
  assert.equal(toolMinutes('save_file', { content: Array(200).fill('w').join(' ') })?.min, 5, `${RATES.wordsPerMinute} words a minute`);
  assert.equal(toolMinutes('save_file', { content: 'short' })?.min, 2, 'at least 2 minutes for a file');
});

test("GET /bots/:id/analytics: own Bots only, ranges validated", async () => {
  const b = botOf(other);
  assert.equal((await call(owner, 'GET', `/api/bots/${b}/analytics`)).status, 404);
  const r = await call(other, 'GET', `/api/bots/${b}/analytics?range=30d`);
  assert.equal(r.status, 200);
  assert.equal(r.body.days.length, 30);
  assert.equal((await call(other, 'GET', `/api/bots/${b}/analytics?range=bogus`)).body.range, '7d');
});

test('image capability adaptation preserves current images and explicitly marks only older images',()=>{
  const image={type:'input_image',image_url:'data:image/png;base64,aGVsbG8='};
  const old=[{role:'user',content:[{type:'input_text',text:'Old screenshot'},image]},{role:'assistant',content:'Seen'},{role:'user',content:'Hi'}];
  const result=textOnlyInput(old);
  assert.equal(result.omitted,1); assert.match(JSON.stringify(result.input),/Earlier image omitted/);
  assert.doesNotMatch(JSON.stringify(result.input),/input_image/); assert.equal(old[0].content[1],image,'stored history is not mutated');
  assert.throws(()=>textOnlyInput([{role:'user',content:[image]}]),/cannot read this request/);
  assert.throws(()=>textOnlyInput([{role:'user',content:'Look now'},{type:'function_call_output',output:[image]}]),/cannot read this request/);
});
for(const model of ['deepseek/deepseek-v4','mock/vision-unavailable']) {
 test(`${model}: plain text after screenshot history completes without a raw image-input error`,async()=>{
  const user=createAccount({email:`${model.replaceAll('/','-')}@example.com`,name:'Image regression'}).id;
  const b=botOf(user);db.prepare('UPDATE bots SET model=?,fast=0 WHERE id=?').run(model,b);
  appendHistory(b,[{role:'user',content:[{type:'input_text',text:'Earlier screenshot'},{type:'input_image',image_url:'data:image/png;base64,aGVsbG8='}]}]);
  const t0=Date.now();enqueue(b,{type:'user',text:'mock: say Image history recovered'} as any);
  for(let i=0;i<100;i++) { if(listRows(b).some((r:any)=>r.body?.role==='assistant'&&!r.body.streaming))break;await new Promise(r=>setTimeout(r,50)); }
  const rows=listRows(b);
  assert.ok(rows.some((r:any)=>r.body?.text==='Image history recovered'));
  assert.ok(rows.some((r:any)=>/Earlier images were omitted/.test(r.body?.text??'')));
  const requests=(await (await fetch(`http://localhost:${mockPort}/_requests`)).json() as any[]).filter(r=>r.at>=t0&&r.body?.model===model);
  assert.equal(requests.length,model==='mock/vision-unavailable'?2:1);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).body.input),/input_image/);
  assert.match(JSON.stringify(requests.at(-1).body.input),/Earlier image omitted/);
 });
}

const { effortsFor, effortLabel, defaultEffortFor, effectiveEffort, isTopEffort, modelSelection } = await import('../web/src/lib/models.js');
const pickerModel = (id: string, efforts: string[] | null = null, defaultEffort: string | null = null) => ({
  id, author: id.split('/')[0], name: id, short: id, billing: 'api' as const,
  efforts, defaultEffort, reasoning: true, vision: true, context: 0,
});

const documentedModels: [string, string[], string][] = [
  ...['gpt-5', 'gpt-5-mini', 'gpt-5-nano'].map(id => [`openai/${id}`, ['minimal', 'low', 'medium', 'high'], 'medium'] as [string, string[], string]),
  ['openai/gpt-5.1', ['none', 'low', 'medium', 'high'], 'none'],
  ...['gpt-5.2', 'gpt-5.4'].map(id => [`openai/${id}`, ['none', 'low', 'medium', 'high', 'xhigh'], 'none'] as [string, string[], string]),
  ...['gpt-5.2-codex', 'gpt-5.3-codex'].map(id => [`openai/${id}`, ['low', 'medium', 'high', 'xhigh'], 'medium'] as [string, string[], string]),
  ['openai/gpt-5.5', ['none', 'low', 'medium', 'high', 'xhigh'], 'medium'],
  ['anthropic/claude-opus-5.5', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
  ['anthropic/claude-sonnet-5.5', ['low', 'medium', 'high', 'xhigh', 'max'], 'high'],
  ['anthropic/claude-haiku-5.5', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
  ...['5', '4.8', '4.7'].map(v => [`anthropic/claude-opus-${v}`, ['low', 'medium', 'high', 'xhigh', 'max'], 'high'] as [string, string[], string]),
  ['anthropic/claude-opus-4.6', ['low', 'medium', 'high', 'max'], 'high'],
  ...['argon', 'carbon'].map(v => [`google/gemini-4-${v}`, ['low', 'medium', 'high'], 'medium'] as [string, string[], string]),
  ['google/gemini-4-hydrogen', ['low', 'medium', 'high', 'xhigh'], 'high'],
  ['google/gemini-4-argon-cyber-permissive', ['low', 'medium', 'high'], 'high'],
  ['google/gemini-4-carbon-cyber-permissive', ['low', 'medium', 'high'], 'high'],
  ...['3.5', '3.6'].map(v => [`google/gemini-${v}-flash`, ['minimal', 'low', 'medium', 'high'], 'medium'] as [string, string[], string]),
  ['google/gemini-3.5-flash-lite', ['minimal', 'low', 'medium', 'high'], 'minimal'],
  ...['4.6', '4.7'].map(v => [`x-ai/grok-${v}`, ['low', 'medium', 'high', 'xhigh'], 'high'] as [string, string[], string]),
  ['x-ai/grok-4.5', ['low', 'medium', 'high'], 'high'],
  ['x-ai/grok-4.3', ['none', 'low', 'medium', 'high'], 'low'],
];

for (const [id, levels, fallback] of documentedModels) test(`${id}: documented names, default, top level and catalog limits`, () => {
  const model = pickerModel(id);
  const offered = effortsFor(model);
  assert.deepEqual(offered, [...levels].reverse());
  assert.deepEqual(offered.map(e => effortLabel(e, model)), [...levels].reverse().map(e => e[0].toUpperCase() + e.slice(1)));
  assert.equal(defaultEffortFor(model), fallback);
  assert.equal(effectiveEffort('ultracode', model), levels.at(-1));
  assert.equal(effortLabel('ultracode', model), effortLabel(offered[0], model));
  assert.equal(isTopEffort('ultracode', model), true);
  for (const level of offered) assert.equal(isTopEffort(level, model), level === offered[0]);
  assert.deepEqual(effortsFor({ ...model, efforts: [] }), [], 'an explicitly empty catalog never gains levels');
  assert.deepEqual(effortsFor({ ...model, efforts: ['low', 'medium', 'ultracode'] }), ['medium', 'low'], 'do not add documented levels the catalog omits');
  assert.equal(defaultEffortFor({ ...model, defaultEffort: 'low' }), 'low', 'catalog default wins');
  assert.equal(defaultEffortFor({ ...model, efforts: ['low'], defaultEffort: 'max' }), null, 'invalid metadata must not mark an unsupported default');
});

test('known models exclude undocumented levels; model variants and direct providers use catalog metadata', () => {
  assert.deepEqual(effortsFor(pickerModel('anthropic/claude-haiku-5.5', ['none', 'low', 'high', 'max'])), ['max', 'high', 'low']);
  assert.deepEqual(effortsFor(pickerModel('google/gemini-4-argon', ['minimal', 'low', 'medium', 'high', 'xhigh'])), ['high', 'medium', 'low']);
  for (const id of ['openai/gpt-6-astra', 'openai/gpt-6.1-sol', 'openai/gpt-5.5-pro', 'deepseek/custom', 'custom/gpt-5.5']) {
    const model = pickerModel(id, ['xhigh', 'low', 'medium', 'high'], 'high');
    assert.deepEqual(effortsFor(model), ['xhigh', 'high', 'medium', 'low']);
    assert.equal(defaultEffortFor(model), 'high');
    assert.equal(effortLabel('xhigh', model), 'Xhigh');
    assert.equal(effortLabel('ultracode', model), 'Xhigh');
    assert.equal(defaultEffortFor({ ...model, defaultEffort: null }), null);
  }
  for (const id of ['google/gemini-2.5-pro', 'deepseek/deepseek-v4']) {
    assert.deepEqual(effortsFor(pickerModel(id, [])), []);
    assert.deepEqual(effortsFor(pickerModel(id, null)), []);
    assert.equal(isTopEffort('ultracode', pickerModel(id, [])), false);
  }
  const literal = pickerModel('custom/model', ['low', 'ultracode'], 'low');
  assert.deepEqual(effortsFor(literal), ['ultracode', 'low']);
  assert.equal(effortLabel('ultracode', literal), 'Ultracode', 'only a literal catalog name may expose Ultracode');
});

test('cross-model mapping matches server snapping for every documented level and the saved top alias', () => {
  for (const [id, levels] of documentedModels) for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const) {
    const model = pickerModel(id, levels);
    assert.equal(effectiveEffort(effort, model), effortFor(effort, levels), `${id}: ${effort}`);
    assert.ok(levels.includes(effectiveEffort(effort, model)));
  }
  assert.equal(effectiveEffort('medium', pickerModel('custom/tied', ['low', 'high'])), 'low');
});

test('CLI resolved models use documented fallbacks and preserve catalog defaults', () => {
  const model = { ...pickerModel('claude/default'), author: 'anthropic', billing: 'plan' as const, resolvedModel: 'claude-opus-5-5' };
  const catalog = { provider: 'claude-cli' as const, billing: 'plan' as const, defaultModel: model.id, byId: new Map([[model.id, model]]) };
  assert.equal(modelSelection({ model: null, effort: 'ultracode' }, catalog).effort, 'medium');
  assert.equal(modelSelection({ model: 'claude/default', effort: 'ultracode' }, catalog).effort, 'max');
  assert.equal(modelSelection({ model: 'claude/removed', effort: 'high' }, catalog).effort, null);
  assert.equal(defaultEffortFor({ ...model, defaultEffort: 'high' }), 'high');
});


test('Astra uses verified catalog support and default without claiming an undocumented API fallback', () => {
  const model = pickerModel('openai/gpt-6.2-astra', ['max', 'xhigh', 'high', 'medium', 'low'], 'medium');
  assert.deepEqual(effortsFor(model), ['max', 'xhigh', 'high', 'medium', 'low']);
  assert.equal(defaultEffortFor(model), 'medium');
  assert.equal(effectiveEffort('none', model), 'low');
  assert.equal(effortLabel('ultracode', model), 'Max');
  assert.equal(defaultEffortFor({ ...model, defaultEffort: null }), null);
});

const { normalizeModelEfforts } = await import('../server/src/lib/model-efforts.js');
for (const [id, rawEfforts, saved, expected] of [
  ['openai/gpt-5', null, 'ultracode', 'high'],
  ['google/gemini-4-argon', null, 'ultracode', 'high'],
  ['openai/gpt-5.3-codex', ['none', 'low', 'medium', 'high', 'xhigh'], 'none', 'low'],
  ['anthropic/claude-haiku-5.5', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'none', 'low'],
] as const) test(`${id}: existing saved ${saved} displays and sends the same supported effort`, () => {
  const raw = pickerModel(id, rawEfforts ? [...rawEfforts] : null);
  const normalized = normalizeModelEfforts(raw);
  assert.equal(effectiveEffort(saved, raw), expected);
  assert.equal(effectiveEffort(saved, normalized), expected);
  assert.deepEqual(providerFields({ effort: saved, reasoning: true, efforts: normalized.efforts, cacheKey: 'k', safetyId: 's' }), { reasoning: { effort: expected } });
  assert.deepEqual(normalizeModelEfforts(normalized), normalized, 'normalization is idempotent');
});


for (const [resolvedModel, expected] of [['claude-sonnet-5-5', 'medium'], ['claude-opus-4-7', 'xhigh']] as const) {
  test(`${resolvedModel}: CLI fallback follows Claude Code while API fallback remains high`, () => {
    const raw = { ...pickerModel('claude/default', ['low', 'medium', 'high', 'xhigh', 'max']), author: 'anthropic', billing: 'plan' as const, resolvedModel };
    const normalized = normalizeModelEfforts(raw);
    assert.equal(normalized.defaultEffort, expected);
    assert.equal(defaultEffortFor(raw), expected);
    assert.equal(defaultEffortFor({ ...raw, billing: 'api' }), 'high');
    assert.equal(normalizeModelEfforts({ ...raw, defaultEffort: 'low' }).defaultEffort, 'low', 'account default takes precedence');
    const catalog = { provider: 'claude-cli' as const, billing: 'plan' as const, defaultModel: raw.id, byId: new Map([[raw.id, normalized]]) };
    for (const model of [null, 'api/previous']) assert.equal(modelSelection({ model, effort: 'ultracode' }, catalog).effort, expected);
  });
}

test('unverified CLI defaults stay unknown; a single available level is still the animated top', () => {
  const cli = { ...pickerModel('codex/gpt-5.4', ['none', 'low', 'medium', 'high', 'xhigh']), author: 'openai', billing: 'plan' as const };
  assert.equal(defaultEffortFor(cli), null);
  assert.equal(normalizeModelEfforts(cli).defaultEffort, null);
  assert.equal(defaultEffortFor({ ...cli, defaultEffort: 'high' }), 'high');
  const single = pickerModel('custom/model', ['medium', 'medium'], 'medium');
  assert.deepEqual(effortsFor(single), ['medium']);
  assert.equal(isTopEffort('medium', single), true);
  assert.equal(effortLabel('ultracode', single), 'Medium');
});

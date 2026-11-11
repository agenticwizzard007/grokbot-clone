import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-latency-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'test.db'), FILES_DIR: path.join(root, 'files'), SESSION_SECRET: 'isolated-latency-test', COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', DIRECT_API_KEY: 'test', OPENROUTER_API_KEY: '', COMPUTER_SETTLE_MS: '150' });
const { computers } = await import('../server/src/computers/index.js');
const { TOOLS } = await import('../server/src/agent/tools.js');
const { db } = await import('../server/src/db.js');
after(() => { mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('binary frames validate boundaries and do not accept invalid Bot IDs or non-JPEG data', async () => {
  const { decodeCompanionFrame } = await import('../server/src/computers/frames.js');
  const jpeg = Buffer.from([255, 216, 1, 2, 3, 255, 217]);
  const encode = (id: string) => Buffer.concat([Buffer.from('SWF1'), Buffer.from([id.length]), Buffer.from(id), jpeg]);
  assert.deepEqual(decodeCompanionFrame(encode('bot_123')), { botId: 'bot_123', jpeg });
  for (const data of [Buffer.alloc(0), encode('../bot'), encode(''), encode('x'.repeat(65)), encode('bot').subarray(0, -1), Buffer.from('{"event":"frame"}')]) assert.equal(decodeCompanionFrame(data), null);
});

test('snapshot deduplication retains all unique observations, metadata and original storage', async () => {
  const { deduplicateBrowserSnapshots } = await import('../server/src/agent/history.js');
  const snapshot = (s: string) => `### Snapshot\n\`\`\`yaml\n${s}\n\`\`\``;
  const pair = (id: string, body: string, name = 'browser_snapshot') => [
    { type: 'function_call', call_id: id, name },
    { type: 'function_call_output', call_id: id, output: `### Page\n- Page URL: https://example.com\n${snapshot(body)}` },
  ];
  const items = [...pair('first', 'unchanged'), ...pair('different', 'important unique evidence'), ...pair('second', 'unchanged'), ...pair('shell', 'unchanged', 'shell')];
  const original = JSON.stringify(items);
  const out = deduplicateBrowserSnapshots(items);
  assert.match(out[1].output, /full contents are in browser result second/);
  assert.match(out[1].output, /Page URL: https:\/\/example.com/);
  assert.match(out[3].output, /important unique evidence/);
  assert.equal(out[5].output, items[5].output);
  assert.equal(out[7].output, items[7].output);
  assert.equal(JSON.stringify(items), original);
});

test('streamed text flushes while the provider is paused, and prompt timestamps follow the reusable prefix', async () => {
  const { createBot } = await import('../server/src/bots.js');
  const { llmClient } = await import('../server/src/lib/llm.js');
  const { enqueue, runInBotQueue } = await import('../server/src/agent/loop.js');
  const { listRows } = await import('../server/src/store.js');
  const { systemPrompt } = await import('../server/src/agent/prompt.js');
  const { initSubagents } = await import('../server/src/agent/subagents.js');
  const { initRooms } = await import('../server/src/agent/rooms.js');
  initSubagents(); initRooms();
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('stream-test', 'stream@example.com', 'Stream', Date.now());
  const bot = createBot('stream-test', { name: 'Fast', isPrimary: true });
  const prompt = await systemPrompt('stream-test', bot.id);
  assert.match(prompt, /Current time: [^\n]+$/);
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const create = mock.method(llmClient(360_000).responses, 'create', async () => (async function* () {
    yield { type: 'response.output_text.delta', delta: 'First ' };
    yield { type: 'response.output_text.delta', delta: 'second' };
    await paused;
    yield { type: 'response.output_item.done', item: { type: 'message', content: [] } };
    yield { type: 'response.completed', response: { output: [] } };
  })());
  try {
    enqueue(bot.id, { type: 'user', text: 'stream test' });
    const end = Date.now() + 1000;
    let text = '';
    while (Date.now() < end) {
      text = (listRows(bot.id).find(r => r.body.type === 'message')?.body as any)?.text ?? '';
      if (text === 'First second') break;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(text, 'First second', 'second delta must appear before the provider sends more events');
  } finally {
    release();
    await runInBotQueue(bot.id, async () => {});
    create.mock.restore();
  }
  const messages = listRows(bot.id).filter(r => r.body.type === 'message');
  assert.equal(messages.length, 1);
  assert.equal((messages[0].body as any).streaming, false);
});

test('screenshots are immediate; each action captures the same screen after completion', async () => {
  const events: string[] = [];
  const screen = {
    screenshot: async () => { events.push('screenshot'); return { width: 10, height: 10, mime: 'image/jpeg', image: 'fresh-image' }; },
    click: async () => { events.push('click'); },
    drag: async () => { events.push('drag'); },
    type: async () => { events.push('type'); },
    key: async () => { events.push('key'); },
    scroll: async () => { events.push('scroll'); },
    openUrl: async () => { events.push('open'); },
  };
  const acquire = mock.method(computers, 'screen', async () => screen);
  const ctx = { userId: 'test', botId: 'test', depth: 0, enqueueBotMessage() {} };
  const screenshot = TOOLS.find(t => t.name === 'computer_screenshot')!;
  const start = performance.now();
  const result = await screenshot.impl({}, ctx);
  const readMs = performance.now() - start;
  assert.ok(readMs < 500, `read-only screenshot added ${readMs}ms of delay`);
  assert.equal(result.output[1].image_url, 'data:image/jpeg;base64,fresh-image');
  assert.deepEqual(events, ['screenshot']);
  events.length = 0;
  const actions = [
    ['computer_click', { x: 1, y: 1 }, 'click'],
    ['computer_type', { text: 'hello' }, 'type'],
    ['computer_key', { keys: 'Return' }, 'key'],
    ['computer_scroll', { x: 1, y: 1, direction: 'down' }, 'scroll'],
    ['computer_drag', { start_x: 0, start_y: 0, end_x: 1, end_y: 1 }, 'drag'],
    ['open_browser', { url: 'https://example.com' }, 'open'],
  ] as const;
  const actionStart = performance.now();
  for (const [name, args, action] of actions) {
    const calls = acquire.mock.callCount();
    const result = await TOOLS.find(t => t.name === name)!.impl(args, ctx);
    assert.equal(acquire.mock.callCount(), calls + 1, 'must not reacquire a potentially different screen');
    assert.deepEqual(events.splice(0), [action, 'screenshot']);
    assert.equal(result.output[1].image_url, 'data:image/jpeg;base64,fresh-image');
  }
  console.log(JSON.stringify({ screenshotMs: +readMs.toFixed(1), sixActionMs: Math.round(performance.now() - actionStart) }));
  acquire.mock.restore();
});

test('model catalog shares cold loads, serves stale data during refresh, and backs off outages', async () => {
  const { openrouterModels } = await import('../server/src/lib/llm.js');
  const realNow = Date.now();
  let now = realNow, calls = 0, release!: () => void;
  const clock = mock.method(Date, 'now', () => now);
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (calls === 1) throw new Error('offline');
    if (calls === 3) await new Promise<void>(r => { release = r; });
    return Response.json({ data: [{ id: 'test/model', name: 'Test', supported_parameters: ['tools'], architecture: { input_modalities: ['text'] } }] });
  });
  try {
    const first = await Promise.allSettled([openrouterModels(), openrouterModels()]);
    assert.ok(first.every(r => r.status === 'rejected'));
    assert.equal(calls, 1);
    await assert.rejects(openrouterModels(), /temporarily unavailable/);
    assert.equal(calls, 1);
    now += 31_000;
    const models = await openrouterModels();
    assert.equal(calls, 2);
    now += 3600_001;
    const stale = await openrouterModels();
    assert.deepEqual(stale, models);
    assert.equal(calls, 3);
    await openrouterModels();
    assert.equal(calls, 3);
    release();
    await new Promise(r => setImmediate(r));
  } finally { fetchMock.mock.restore(); clock.mock.restore(); }
});

test('app operations publish the running action before completion, queue subsequent calls and ask without catalog I/O', async () => {
  const { composio } = await import('../server/src/composio.js');
  const { createBot } = await import('../server/src/bots.js');
  const { enqueue, runInBotQueue, resolveApproval } = await import('../server/src/agent/loop.js');
  const { listRows, getLive } = await import('../server/src/store.js');
  const { llmClient } = await import('../server/src/lib/llm.js');
  process.env.COMPOSIO_API_KEY = 'latency-test-only';
  const sdk = composio();
  const accounts = mock.method(sdk.connectedAccounts, 'list', async () => ({ items: [{ id: 'account', toolkit: { slug: 'notion' }, status: 'ACTIVE' }] }));
  const metadata = mock.method(sdk.tools, 'getRawComposioToolBySlug', async () => ({ slug: 'NOTION_FETCH_DATABASE', toolkit: { slug: 'notion' }, version: '1' }));
  let release!: () => void, entered!: () => void;
  const paused = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { entered = r; });
  const execute = mock.method(sdk.tools, 'execute', async () => { entered(); await paused; return { successful: true, data: {} }; });
  const requests: string[] = [];
  const network = mock.method(globalThis, 'fetch', async (url: any) => { requests.push(String(url)); throw new Error('Unexpected network request'); });
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('app-progress', 'progress@example.com', 'Progress', Date.now());
  const bot = createBot('app-progress', { name: 'Progress', isPrimary: true });
  let round = 0;
  const create = mock.method(llmClient(360_000).responses, 'create', async () => (async function* () {
    const output = round++ ? [] : ['NOTION_FETCH_DATABASE', 'NOTION_CREATE_PAGE'].map((tool_slug, index) => ({
      type: 'function_call', call_id: `progress-${index}`, name: 'SWARM_APPS_EXECUTE',
      arguments: JSON.stringify({ connectionId: 'account', revision: 1, tool_slug, arguments: {} }),
    }));
    yield { type: 'response.completed', response: { output } };
  })());
  try {
    enqueue(bot.id, { type: 'user', text: 'Read the database and create a page' });
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('Tool never started')), 2000).unref())]);
    const calls = listRows(bot.id).filter(r => r.body.type === 'tool-call').map(r => r.body as any);
    assert.deepEqual(calls.map(c => c.status), ['running', 'queued']);
    assert.deepEqual(calls.map(c => c.label), ['Notion: Fetch database', 'Notion: Create page']);
    assert.equal(getLive(bot.id).activity?.detail, 'Notion: Fetch database');
    assert.ok(calls[0].startedAt);
    assert.equal(calls[1].startedAt, undefined);
    release();
    await runInBotQueue(bot.id, async () => {});
    const rows = listRows(bot.id);
    const done = rows.find(r => r.body.type === 'tool-call')!.body as any;
    assert.equal(done.status, 'done');
    assert.ok(done.completedAt >= done.startedAt);
    const approval = rows.find(r => r.body.type === 'card' && r.body.card === 'approval')!.body as any;
    assert.equal(approval.toolkitName, 'Notion');
    assert.deepEqual(requests.filter(url => new URL(url).hostname !== 'telemetry.composio.dev'), [], 'labels and approval cards must not fetch the whole app catalog');
    assert.equal(execute.mock.callCount(), 1, 'the write must still wait for approval');
    resolveApproval('app-progress', approval.approvalId, 'deny');
    await runInBotQueue(bot.id, async () => {});
    assert.equal(execute.mock.callCount(), 1);
  } finally {
    release(); await runInBotQueue(bot.id, async () => {});
    for (const m of [create, network, execute, metadata, accounts]) m.mock.restore();
    process.env.COMPOSIO_API_KEY = '';
  }
});

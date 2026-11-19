// node --import tsx --test --test-concurrency=1 tests/native-review-subscription.test.mts
// Real subscription adapter + authenticated local bridge protocol. No model
// executor mocks, installed CLIs, paid inference or external business actions.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, test } from 'node:test';
import { WebSocket } from 'ws';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-review-subscription-'));
const paidRequests: string[] = [];
// Both API routes have credentials, so a mistaken fallback is observable here.
const server = createServer((req, res) => {
  paidRequests.push(`${req.method} ${req.url}`);
  res.writeHead(503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Paid API inference is forbidden in this test' } }));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const address = server.address(); assert.ok(address && typeof address !== 'string');
const base = `http://127.0.0.1:${address.port}`;
Object.assign(process.env, {
  NODE_ENV: 'test', SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1',
  DB_PATH: path.join(temp, 'app.db'), FILES_DIR: path.join(temp, 'files'),
  SESSION_SECRET: 'native-review-subscription-only', SERVER_URL: base, APP_URL: base,
  COMPUTER_PROVIDER: 'local', COMPOSIO_API_KEY: '', ADMIN_EMAILS: '', ADMIN_PHONES: '', INKBOX_TUNNEL: '0',
  DIRECT_API_KEY: 'configured-direct-test-key', DIRECT_BASE_URL: `${base}/direct`, DIRECT_MODEL: 'api-model',
  OPENROUTER_API_KEY: 'configured-openrouter-test-key', OPENROUTER_BASE_URL: `${base}/openrouter`,
  OPENROUTER_MODEL: 'api/default', LLM_PROVIDER: 'openrouter', XAI_API_KEY: '',
});
const { db } = await import('../server/src/db.js');
const { createCliPairing, selectCli, selectedCli } = await import('../server/src/cli/store.js');
const { attachCliSocket, disconnectCli, refreshCli } = await import('../server/src/cli/bridge.js');
const { cliResponsesClient } = await import('../server/src/cli/responses.js');
const { withNativeTools, nativeToolHandler } = await import('../server/src/cli/native-tools.js');
const { withUsage } = await import('../server/src/usage-context.js');
const { llmClient, llmProvider } = await import('../server/src/lib/llm.js');
const { appendRow } = await import('../server/src/store.js');
const { LEARNING_TOOLS } = await import('../server/src/agent/learning-tools.js');
const { listMemories } = await import('../server/src/knowledge/memory.js');
const { withManagement } = await import('../server/src/knowledge/access.js');
attachCliSocket(server);

type Provider = 'claude' | 'codex';
type Rpc = { id: string; method: string; params?: any };
const HOLD = Symbol('await Swarm cancellation');
const bridges = new Set<ReviewBridge>();
let sequence = 0;
const envelope = (text: string, calls: { name: string; arguments: string }[] = []) => ({
  text: JSON.stringify({ text, tool_calls: calls }), model: 'review-model',
  usage: { input_tokens: 40, output_tokens: 12 },
});

class ReviewBridge {
  ws = new WebSocket(base.replace('http:', 'ws:') + '/api/cli-bridge');
  welcome = false;
  requests: Rpc[] = [];
  generate: (rpc: Rpc) => any = () => envelope('Review finished.');
  closed = new Promise<void>(resolve => this.ws.once('close', () => resolve()));
  constructor(readonly userId: string) {
    bridges.add(this); this.ws.on('error', () => {});
    this.ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'welcome') { this.welcome = true; return; }
      this.requests.push(message);
      if (message.method === 'status') this.reply(message.id, {
        claude: { installed: true, authenticated: true, subscription: true },
        codex: { installed: true, authenticated: true, subscription: true },
      });
      if (message.method === 'catalog') this.reply(message.id, {
        models: [{ id: `${message.params.provider}/review-model`, name: 'Selected review model', efforts: ['low', 'high'], defaultEffort: 'high', vision: false }],
        defaultModel: `${message.params.provider}/review-model`, plan: 'mock subscription',
        usage: { available: false, checkedAt: Date.now(), windows: [] },
      });
      if (message.method === 'generate') {
        try {
          const reply = this.generate(message);
          if (reply !== HOLD) this.reply(message.id, reply);
        } catch (error) { this.ws.send(JSON.stringify({ id: message.id, error: (error as Error).message })); }
      }
    });
  }
  reply(id: string, result: unknown) { this.ws.send(JSON.stringify({ id, result })); }
  get generations() { return this.requests.filter(request => request.method === 'generate'); }
  async connect() {
    const token = createCliPairing(this.userId);
    await once(this.ws, 'open');
    this.ws.send(JSON.stringify({ type: 'hello', version: 1, token, nativeMcp: true, noGenerationDeadline: true, device: 'Review fixture computer' }));
    const deadline = Date.now() + 2000;
    while (!this.welcome && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(this.welcome, true, 'bridge must authenticate');
    await refreshCli(this.userId);
  }
}

afterEach(async () => {
  for (const bridge of bridges) {
    disconnectCli(bridge.userId);
    if (bridge.ws.readyState !== WebSocket.CLOSED) bridge.ws.terminate();
  }
  await Promise.all([...bridges].map(bridge => bridge.closed)); bridges.clear();
  assert.deepEqual(paidRequests, [], 'selected subscription review must never fall back to direct or OpenRouter APIs');
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close(); fs.rmSync(temp, { recursive: true, force: true });
});

async function fixture(provider: Provider) {
  const userId = `review-${provider}-${++sequence}`, botId = `bot-${userId}`, at = Date.now();
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, provider, at);
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(botId, userId, provider, at, at);
  const source = appendRow(botId, 'message', { type: 'message', role: 'user', text: 'I prefer daily reports with named owners and original source links.' });
  const bridge = new ReviewBridge(userId); await bridge.connect(); selectCli(userId, provider);
  const args = { action: 'add', expected_revision: 0, text: 'Prefers daily reports with named owners and original source links.', target: 'user',
    evidence: [{ botId, generation: source.generation, seq: source.seq }] };
  const tool = LEARNING_TOOLS.find(tool => tool.name === 'manage_memory')!;
  assert.ok(tool);
  const body = {
    model: `${provider}/review-model`, reasoning: { effort: 'high' },
    input: [{ role: 'user', content: 'Review the sourced durable preference using the allowed management tools.' }],
    tools: [{ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters }],
    store: false, parallel_tool_calls: false, swarm_management_review: true,
  };
  return { userId, botId, bridge, args, tool, body };
}

for (const provider of ['claude', 'codex'] as const) {
  test(`${provider}: production reviewer keeps its five-minute deadline after an unbounded foreground request`, { timeout: 10000 }, async () => {
    const f = await fixture(provider);
    const { acceptJob, beginJob, finishJob } = await import('../server/src/agent/jobs.js');
    const { onLearningTurn, runLearningReview } = await import('../server/src/agent/learning.js');
    const { learningSettings, patchLearningSettings } = await import('../server/src/knowledge/settings.js');
    await withUsage({ userId: f.userId, botId: f.botId, kind: 'chat' }, () =>
      llmClient(360_000, { subscriptionTimeoutMs: 0 }).responses.create({ ...f.body, swarm_management_review: false } as any));
    assert.equal(f.bridge.generations[0].params.timeoutMs, 0);

    const current = learningSettings(f.userId, f.botId);
    patchLearningSettings(f.userId, { botId: f.botId, expectedRevision: current.revision, settings: { memoryTurnInterval: 1 } });
    const parent = acceptJob(f.botId, { type: 'user', text: 'Complete the sourced task.' });
    assert.equal(beginJob(parent.id), true); finishJob(parent.id, true);
    const { generation } = db.prepare('SELECT generation FROM bots WHERE id=?').get(f.botId) as { generation: number };
    const review = onLearningTurn({ userId: f.userId, botId: f.botId, jobId: parent.id,
      triggerType: 'user', depth: 0, generation, model: f.body.model, provider: `${provider}-cli`,
      finalText: 'The sourced task is complete.', iterations: 1, status: 'completed',
      messagesSnapshot: f.body.input, contextWindow: 100000 });
    assert.ok(review, 'the completed parent should create a real detached review');
    // Keep the production executor intact: inspect the request it actually sends.
    const result = await runLearningReview(review.id);
    assert.equal(result?.status, 'completed', result?.error ?? 'review did not complete');
    assert.equal(f.bridge.generations.length, 2);
    const request = f.bridge.generations[1];
    assert.equal(request.params.timeoutMs, 300_000);
    assert.equal(request.params.provider, provider);
    assert.equal(Object.hasOwn(request.params, 'nativeTools'), false);
    assert.ok(request.params.actionNames.includes('manage_memory'));
    assert.deepEqual(paidRequests, []);
  });

  test(`${provider}: management envelope returns calls to Swarm and continues on the same selected route in exactly two requests`, { timeout: 10000 }, async () => {
    const f = await fixture(provider); let nativeCallbacks = 0, dispatched = 0;
    const client = cliResponsesClient(f.userId, provider, 2000);
    f.bridge.generate = rpc => f.bridge.generations.length === 1
      ? envelope('', [{ name: 'manage_memory', arguments: JSON.stringify(f.args) }])
      : envelope('Recorded the sourced preference through Swarm.');
    await withUsage({ userId: f.userId, botId: f.botId, kind: 'background_review' }, () =>
      withNativeTools(f.userId, async () => {
        nativeCallbacks++; throw new Error('Review actions must return to the Swarm management dispatcher');
      }, async () => {
        assert.equal(typeof nativeToolHandler(f.userId), 'function', 'native tool scope must really be active');
        assert.equal(llmProvider(), `${provider}-cli`);
        const first = await client.responses.create(f.body);
        assert.equal(f.bridge.generations.length, 1, 'adapter must not run its own management loop');
        assert.equal(first.billing, 'subscription'); assert.equal(first.provider, `${provider}-cli`); assert.equal(first.model, f.body.model);
        assert.equal(first.output.length, 1);
        const call = first.output[0];
        assert.equal(call.type, 'function_call'); assert.equal(call.name, 'manage_memory'); assert.match(call.call_id, /^cli_/);
        assert.deepEqual(JSON.parse(call.arguments), f.args);
        assert.equal(nativeCallbacks, 0); assert.equal(dispatched, 0);
        assert.deepEqual(listMemories(f.userId, f.botId), [], 'CLI transport must not execute the management operation');
        // This is the Swarm-owned dispatch boundary, using the real management
        // tool and source/revision checks, after the Responses item is returned.
        dispatched++;
        const result = await withManagement({ userId: f.userId, botId: f.botId, actor: 'background_review', unattended: true, reads: new Map() }, () =>
          f.tool.impl(JSON.parse(call.arguments), { userId: f.userId, botId: f.botId, depth: 0,
            enqueueBotMessage: () => { throw new Error('Business actions are forbidden in management review'); } }));
        assert.ok(!result.isError, String(result.output));
        const memory = listMemories(f.userId, f.botId)[0];
        assert.equal(memory.text, f.args.text); assert.equal(memory.scope, 'private');
        const managementResult = { type: 'function_call_output', call_id: call.call_id, output: result.output };
        // The normal selected-client router must retain this subscription route
        // when Swarm explicitly submits the next review iteration.
        const second = await llmClient(2000).responses.create({ ...f.body, input: [...f.body.input, ...first.output, managementResult] } as any);
        assert.equal(second.output_text, 'Recorded the sourced preference through Swarm.');
        assert.equal(second.provider, first.provider); assert.equal(second.model, first.model); assert.equal(second.billing, 'subscription');
        assert.deepEqual(second.output.map((item: any) => item.type), ['message']);
        assert.equal(nativeCallbacks, 0); assert.equal(dispatched, 1);
        assert.equal(listMemories(f.userId, f.botId).length, 1);
        const turns = f.bridge.generations;
        assert.equal(turns.length, 2, 'one returned call plus one Swarm-supplied result require exactly two CLI generations');
        for (const turn of turns) {
          assert.equal(Object.hasOwn(turn.params, 'nativeTools'), false, 'review must send no native MCP manifest despite withNativeTools');
          assert.equal(turn.params.provider, provider); assert.equal(turn.params.model, 'review-model'); assert.equal(turn.params.effort, 'high');
          assert.deepEqual(turn.params.actionNames, ['manage_memory']);
          assert.deepEqual(turn.params.schema.properties.tool_calls.items.properties.name.enum, ['manage_memory']);
          assert.match(turn.params.prompt, /Do not use native CLI tools/);
        }
        const conversation = JSON.parse(turns[1].params.prompt.split('Conversation:\n')[1]);
        assert.deepEqual(conversation.at(-2), call);
        assert.deepEqual(conversation.at(-1), managementResult, 'second request must contain the exact correlated Swarm result');
        assert.equal(JSON.parse(conversation.at(-1).output).memory.id, memory.id);
      }));
  });

  test(`${provider}: a bridge cannot invoke native callbacks during management review`, { timeout: 10000 }, async () => {
    const f = await fixture(provider); let dispatched = 0;
    f.bridge.generate = rpc => {
      f.bridge.ws.send(JSON.stringify({ id: rpc.id, type: 'tool_call', call: { id: 'forbidden-native-call', name: 'manage_memory', arguments: f.args } }));
      return HOLD;
    };
    await withNativeTools(f.userId, async () => { dispatched++; return { output: 'Must not execute' }; }, async () => {
      await assert.rejects(cliResponsesClient(f.userId, provider, 2000).responses.create(f.body), /Native CLI tool callback is unavailable/);
    });
    assert.equal(f.bridge.generations.length, 1);
    assert.equal(Object.hasOwn(f.bridge.generations[0].params, 'nativeTools'), false);
    assert.equal(dispatched, 0); assert.deepEqual(listMemories(f.userId, f.botId), []);
  });

  test(`${provider}: invalid route and offline review fail without changing the selected subscription or using paid APIs`, { timeout: 10000 }, async () => {
    const f = await fixture(provider); let dispatched = 0;
    await withUsage({ userId: f.userId, botId: f.botId, kind: 'background_review' }, () =>
      withNativeTools(f.userId, async () => { dispatched++; return { output: 'Must not execute' }; }, async () => {
        const client = llmClient(2000);
        await assert.rejects(client.responses.create({ ...f.body, model: `${provider === 'claude' ? 'codex' : 'claude'}/review-model` } as any), /not part of the selected subscription.*No API fallback/);
        await assert.rejects(client.responses.create({ ...f.body, model: `${provider}/not-in-account-catalog` } as any), /no longer offered.*No API fallback/);
        assert.equal(f.bridge.generations.length, 0);
        disconnectCli(f.userId); await f.bridge.closed;
        await assert.rejects(cliResponsesClient(f.userId, provider, 2000).responses.create(f.body), /offline.*No API fallback/);
        await assert.rejects(llmClient(2000).responses.create(f.body as any), /offline.*No API fallback/);
        assert.equal(llmProvider(), `${provider}-cli`); assert.equal(selectedCli(f.userId), provider);
      }));
    assert.equal(f.bridge.generations.length, 0); assert.equal(dispatched, 0);
    assert.deepEqual(listMemories(f.userId, f.botId), []); assert.deepEqual(paidRequests, []);
  });
}

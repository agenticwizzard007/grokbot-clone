import assert from 'node:assert/strict';
import { test } from 'node:test';
import OpenAI from 'openai';
import { boundedResponseCreate, modelOutputLimit, ApiCreditsError, affordableOutputLimit, isCreditError, providerBilling } from '../server/src/lib/model-request-policy.js';

function client(fetch: typeof globalThis.fetch, provider = 'openrouter', info: any = undefined) {
  const sdk = new OpenAI({ apiKey: 'fixture-only', baseURL: 'http://localhost/fixture', fetch });
  return boundedResponseCreate(sdk.responses.create.bind(sdk.responses), async () => info, provider, 'https://api.openai.com/v1');
}
const exhausted = (message = 'Insufficient credits') => Response.json({ error: { message, code: 402 } }, { status: 402 });
const output = () => Response.json({ id: 'fixture', output: [], output_text: 'Normal reply.' });

test('model defaults, provider capability caps, explicit budgets and server/model overrides', t => {
  for (const key of ['SWARM_MAX_OUTPUT_TOKENS', 'SWARM_MODEL_MAX_OUTPUT_TOKENS']) {
    const saved = process.env[key]; delete process.env[key];
    t.after(() => { if (saved === undefined) delete process.env[key]; else process.env[key] = saved; });
  }
  assert.equal(modelOutputLimit('openai/gpt-4.1'), 8192);
  assert.equal(modelOutputLimit('openai/o3'), 16384);
  assert.equal(modelOutputLimit('anthropic/claude-sonnet-4'), 16384);
  assert.equal(modelOutputLimit('google/gemini', { reasoning: true }), 16384);
  assert.equal(modelOutputLimit('small-model', { maxOutputTokens: 1024 }), 1024);
  assert.equal(modelOutputLimit('model', undefined, 1200), 1200);
  assert.equal(modelOutputLimit('model', undefined, 65536), 8192);
  process.env.SWARM_MAX_OUTPUT_TOKENS = '4096';
  process.env.SWARM_MODEL_MAX_OUTPUT_TOKENS = '{"model":2048}';
  assert.equal(modelOutputLimit('other'), 4096);
  assert.equal(modelOutputLimit('model:nitro'), 2048);
  assert.equal(modelOutputLimit('model', { maxOutputTokens: 1000 }, 900), 900);
  process.env.SWARM_MODEL_MAX_OUTPUT_TOKENS = 'invalid';
  process.env.SWARM_MAX_OUTPUT_TOKENS = '-1';
  assert.equal(modelOutputLimit('model'), 8192);
});

test('HTTP 402 affordable amount retries exactly once below N and succeeds', async () => {
  const bodies: any[] = [];
  const create = client(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? exhausted('You requested up to 8192 tokens, but can only afford 2,000.') : output();
  });
  const result = await create({ model: 'openai/gpt-4.1', input: 'Hi', stream: false });
  assert.equal(result.output_text, 'Normal reply.');
  assert.deepEqual(bodies.map(b => b.max_output_tokens), [8192, 1800]);
});

for (const status of [400, 402, 429]) test(`provider ${status}: exhaustion is structured and never retried without a useful affordable amount`, async () => {
  let calls = 0;
  const create = client(async () => { calls++; return Response.json({ error: { message: status === 400 ? 'Your credit balance is too low' : 'Insufficient credits', code: 'insufficient_quota' } }, { status }); });
  await assert.rejects(create({ model: 'model', input: 'Hi' }), (error: any) => {
    assert.ok(error instanceof ApiCreditsError);
    assert.equal(error.message, 'Out of API credits');
    assert.equal(error.credits.billingUrl, 'https://openrouter.ai/settings/credits');
    assert.match(error.credits.details, /credits|balance/); return true;
  });
  assert.equal(calls, 1);
});

test('a failed affordable retry never makes a third HTTP request', async () => {
  let calls = 0;
  const create = client(async () => { calls++; return exhausted('can only afford 2000'); });
  await assert.rejects(create({ model: 'model' }), ApiCreditsError);
  assert.equal(calls, 2);
  assert.equal(affordableOutputLimit(new Error('can only afford 200'), 8192), undefined);
  assert.equal(affordableOutputLimit(new Error('can only afford 0'), 8192), undefined);
  assert.equal(affordableOutputLimit(new Error('can only afford 57498'), 8192), 8191);
  assert.equal(isCreditError(new Error('Rate limit reached')), false);
});

for (const provider of ['openrouter', 'direct']) for (const phase of ['initial', 'retry']) test(`${provider}: Stop aborts the SDK HTTP fetch during ${phase}`, async () => {
  let calls = 0;
  let observed: AbortSignal | undefined;
  const ready = Promise.withResolvers<void>();
  const ctrl = new AbortController();
  const create = client(async (_url, init) => {
    calls++;
    if (phase === 'retry' && calls === 1) return exhausted('can only afford 2000');
    observed = init!.signal!;
    ready.resolve();
    return new Promise((_resolve, reject) => observed!.addEventListener('abort', () => reject(observed!.reason), { once: true }));
  }, provider);
  const pending = create({ model: 'model' }, { signal: ctrl.signal });
  const rejection = assert.rejects(pending);
  await ready.promise; ctrl.abort(new Error('Stopped fixture'));
  await rejection;
  assert.equal(observed!.aborted, true);
  assert.equal(calls, phase === 'retry' ? 2 : 1);
});

const sse = (events: any[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
for (const partial of [false, true]) test(`SSE credit error ${partial ? 'after output is never replayed' : 'before output retries once'}`, async () => {
  const caps: number[] = [];
  const create = client(async (_url, init) => {
    caps.push(JSON.parse(String(init!.body)).max_output_tokens);
    if (caps.length > 1) return sse([{ type: 'response.completed', response: { output: [] } }]);
    return sse([
      ...(partial ? [{ type: 'response.output_text.delta', delta: 'Partial' }] : []),
      { type: 'response.failed', response: { error: { code: 402, message: 'can only afford 2000' } } },
    ]);
  });
  const consume = async () => { for await (const _event of await create({ model: 'model', stream: true })) { /* consume */ } };
  if (partial) await assert.rejects(consume(), ApiCreditsError); else await consume();
  assert.deepEqual(caps, partial ? [8192] : [8192, 1800]);
});

test('known billing pages follow the paying provider, not the model maker', () => {
  assert.equal(providerBilling('openrouter', 'https://api.anthropic.com').provider, 'OpenRouter');
  for (const host of ['api.openai.com', 'api.anthropic.com', 'api.x.ai', 'generativelanguage.googleapis.com', 'api.deepseek.com', 'api.groq.com', 'api.mistral.ai']) assert.ok(providerBilling('direct', `https://${host}`).billingUrl);
  assert.equal(providerBilling('direct', 'http://localhost').billingUrl, undefined);
});

test('image/MCP compatibility fallbacks retain the reduced cap and cannot retry credits again', async () => {
  const caps: number[] = [];
  const create = client(async (_url, init) => {
    caps.push(JSON.parse(String(init!.body)).max_output_tokens);
    return caps.length === 2 ? Response.json({ error: { message: 'Invalid MCP schema' } }, { status: 400 }) : exhausted('can only afford 2000');
  });
  const body = { model: 'model', tools: [] };
  await assert.rejects(create(body), /Invalid MCP schema/);
  await assert.rejects(create(body), ApiCreditsError);
  assert.deepEqual(caps, [8192, 1800, 1800]);
});

test('credit retry never starts after cancellation during the first error', async () => {
  let calls = 0;
  const controller = new AbortController();
  const create = boundedResponseCreate(async () => {
    calls++; controller.abort(new Error('Stop before retry'));
    throw Object.assign(new Error('can only afford 2000'), { status: 402 });
  }, async () => undefined, 'openrouter', 'http://localhost');
  await assert.rejects(create({ model: 'model' }, { signal: controller.signal }), /Stop before retry/);
  assert.equal(calls, 1);
});

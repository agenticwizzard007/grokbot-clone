import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelDisplayName } from '../web/src/lib/modelDisplay.ts';

const cases = [
  ['claude-fable-5-2', 'Claude Fable 5.2'],
  ['claude_fable_5_2', 'Claude Fable 5.2'],
  ['Claude Fable 5 2', 'Claude Fable 5.2'],
  ['claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5'],
  ['claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet 20241022'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5'],
  ['claude/fable-5-2', 'Fable 5.2'],
  ['anthropic/claude-fable-5-2', 'Claude Fable 5.2'],
  ['gpt-5-2', 'GPT 5.2'], ['gpt_5_2_mini', 'GPT 5.2 Mini'],
  ['openai/gpt-5-2-chat', 'GPT 5.2 Chat'],
  ['gpt-4-turbo-2024-11-20', 'GPT 4 Turbo 2024-11-20'],
  ['gpt-4o-2024-11-20', 'GPT 4o 2024-11-20'],
  ['gpt-5-2-20241120', 'GPT 5.2 20241120'],
  ['gpt-5-2-2024-11-20', 'GPT 5.2 2024-11-20'],
  ['gpt_5_2_2024_11_20', 'GPT 5.2 2024-11-20'],
  ['gpt 5 2 2024 11 20', 'GPT 5.2 2024-11-20'],
  ['model-count-12-34', 'Model Count 12 34'],
  ['gemini-2-5-pro-exp-03-25', 'Gemini 2.5 Pro Exp 03 25'],
  ['qwen3-235b-a22b', 'Qwen3 235b A22b'],
  ['mistral-large-2411', 'Mistral Large 2411'],
  ['mistralai/mistral-medium-3-1', 'Mistral Medium 3.1'],
  ['openai/gpt-oss-120b', 'GPT Oss 120b'],
  ['cohere/command-r-plus-08-2024', 'Command R Plus 08 2024'],
  ['google/gemma-3-27b-it', 'Gemma 3 27b It'],
  ['o3-mini', 'O3 Mini'], ['4-turbo', '4 Turbo'],
  ['gemini-2-5-pro', 'Gemini 2.5 Pro'], ['google/gemini-2_5-flash', 'Gemini 2.5 Flash'],
  ['gemini-2.5-flash-preview-05-20', 'Gemini 2.5 Flash Preview 05 20'],
  ['grok-4-7', 'Grok 4.7'], ['x-ai/grok-4.7', 'Grok 4.7'],
  ['meta-llama/llama-3-1-70b', 'LLAMA 3.1 70b'],
  ['llama-3.1-8b-instruct', 'LLAMA 3.1 8b Instruct'],
  ['llama-3-70b', 'LLAMA 3 70b'],
  ['mistralai/mixtral-8x7b-instruct', 'Mixtral 8x7b Instruct'],
  ['mistral-7b-instruct-v0-3', 'Mistral 7b Instruct V0.3'],
  ['mistral-small-24b-instruct-2501', 'Mistral Small 24b Instruct 2501'],
  ['qwen/qwen-2-5-72b-instruct', 'Qwen 2.5 72b Instruct'],
  ['qwen2-5-coder-32b', 'Qwen2.5 Coder 32b'],
  ['deepseek/deepseek-v3-1', 'Deepseek V3.1'],
  ['deepseek-r1-0528', 'Deepseek R1 0528'],
  ['z-ai/glm-4-5', 'GLM 4.5'], ['api-model-12-34-128k', 'API Model 12.34 128k'],
  ['model-128k', 'Model 128k'], ['model-8x7b', 'Model 8x7b'],
  ['model-70b', 'Model 70b'], ['model-2024-11-20', 'Model 2024-11-20'],
  ['model-20241120', 'Model 20241120'], ['', 'Model'],
] as const;
for (const [id, expected] of cases) test(`model display normalizes ${id || 'empty input'}`, () => {
  assert.equal(modelDisplayName(id), expected);
  assert.equal(modelDisplayName(id, id), expected);
  assert.equal(modelDisplayName(modelDisplayName(id)), expected, 'formatting is idempotent');
});
for (const [catalog, expected] of [
  ['Claude Fable 5 2', 'Claude Fable 5.2'], ['Claude Fable 5-2', 'Claude Fable 5.2'],
  ['Claude Fable 5_2 Preview', 'Claude Fable 5.2 Preview'],
  ['claude-fable-5-2', 'Claude Fable 5.2'],
  ['Anthropic: Claude Fable 5 2', 'Anthropic: Claude Fable 5.2'],
  ['Gemini 2 5 Pro', 'Gemini 2.5 Pro'], ['GPT 5 2', 'GPT 5.2'],
  ['GPT-5.5', 'GPT-5.5'], ['Llama 3 1 70b', 'Llama 3.1 70b'],
  ['DeepSeek V3 1', 'DeepSeek V3.1'], ['Codex · ChatGPT plan', 'Codex · ChatGPT plan'],
  ['CLI default', 'CLI default'], ['API model 128k', 'API model 128k'],
] as const) test(`catalog display normalizes ${catalog}`, () => {
  assert.equal(modelDisplayName('vendor/default', catalog), expected);
});

test('cached catalog labels normalize versions without changing plan wording', async t => {
  const { lastModelLabel } = await import('../web/src/lib/modelMemory.ts');
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let label = 'Claude Fable 5 2';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => JSON.stringify({ model: null, label }) } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'localStorage', original); else Reflect.deleteProperty(globalThis, 'localStorage'); });
  assert.equal(lastModelLabel('account', { id: 'bot', model: null }), 'Claude Fable 5.2');
  label = 'Codex · ChatGPT plan';
  assert.equal(lastModelLabel('account', { id: 'bot', model: null }), label);
});

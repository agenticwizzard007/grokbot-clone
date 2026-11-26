import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerBrand } from '../web/src/lib/providerBrand.js';

test('provider marks resolve plan routes, model authors and remembered model labels', () => {
  for (const value of ['anthropic', 'claude-cli', 'claude/opus', 'Claude Max', 'Opus 4.6', 'Sonnet 4.6']) assert.equal(providerBrand(value), 'claude', value);
  for (const value of ['openai', 'codex-cli', 'codex/default', 'GPT 5.5', 'Codex · ChatGPT plan', 'ChatGPT plan']) assert.equal(providerBrand(value), 'openai', value);
  for (const [value, expected] of Object.entries({ 'x-ai/grok-4': 'xai', 'xAI voice': 'xai', 'Grok 4': 'xai', openrouter: 'openrouter', 'google/gemini-3-pro': 'gemini', 'meta-llama/llama-4': 'meta', 'mistralai/mistral-small': 'mistral', 'moonshotai/kimi-k2': 'moonshot', 'deepseek/deepseek-v3': 'deepseek', 'qwen/qwen3': 'qwen', 'cohere/command-r': 'cohere', 'DeepSeek V3': 'deepseek', 'Qwen3 235B': 'qwen', 'Kimi K2': 'moonshot', 'Mistral Small': 'mistral', 'Llama 4': 'meta', 'Command R': 'cohere' })) assert.equal(providerBrand(value), expected, value);
});

test('unknown and custom connections do not claim another provider brand', () => {
  for (const value of [null, undefined, '', 'direct', 'custom/model', 'Provider default', 'Loading model', 'Models unavailable']) assert.equal(providerBrand(value), null);
});

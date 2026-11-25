import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composerModelLabel } from '../web/src/lib/composerModelLabel.ts';

test('Codex composer label names the model route and plan once', () => {
  for (const label of ['Codex CLI default', 'CLI default', 'Codex']) {
    assert.equal(composerModelLabel(label, 'codex-cli', true), 'Codex · ChatGPT plan');
  }
});

test('composer label preserves API models and unknown or unavailable connections', () => {
  for (const [label, provider, plan] of [
    ['GPT-5.5', 'openrouter', false], ['Opus', 'claude-cli', true],
    ['Models unavailable', 'codex-cli', false], ['Choose model', null, false],
  ] as const) assert.equal(composerModelLabel(label, provider, plan), label);
});

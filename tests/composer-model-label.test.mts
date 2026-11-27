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

test('compact Claude labels retain a short model name and complete effort', async () => {
  const { composerLabelSteps, fittingComposerLabel } = await import('../web/src/lib/composerModelLabel.ts');
  const steps = composerLabelSteps('Opus 4.6', 'claude-cli', true, 'max', 'Medium', true);
  assert.deepEqual(steps.map(s => s.name), ['Opus 4.6', 'Opus']);
  assert.equal(steps[0].billing, 'Plan');
  assert.ok(steps.slice(1).every(s => s.effort === 'Medium' && s.billing === ''));
  const widths = [300, 200, 150, 100, 50];
  for (let index = 0; index < steps.length; index++) {
    assert.equal(fittingComposerLabel(steps, widths[index], step => widths[steps.indexOf(step)]), steps[index]);
  }
});

test('compact Codex cannot restore the long billing label after choosing Codex', async () => {
  const { composerLabelSteps, fittingComposerLabel } = await import('../web/src/lib/composerModelLabel.ts');
  const steps = composerLabelSteps('CLI default', 'codex-cli', true, null, 'Medium', true);
  const fit = fittingComposerLabel(steps, 100, step => step.compact ? 90 : 200);
  assert.equal(fit.name, 'Codex'); assert.equal(fit.effort, 'Medium'); assert.equal(fit.billing, '');
});

test('API compact labels preserve complete model names and unknown endpoints keep neutral text', async () => {
  const { composerLabelSteps } = await import('../web/src/lib/composerModelLabel.ts');
  const api = composerLabelSteps('Grok 4', 'openrouter', false, null, 'Medium', true);
  assert.equal(api[0].name, 'Grok 4'); assert.equal(api[1].name, 'Grok');
  for (const effort of ['', 'Medium']) {
    const custom = composerLabelSteps('A very long custom model', 'direct', false, null, effort, false);
    assert.equal(custom.at(-1)?.name, 'Model');
    assert.ok(custom.every(s => !/[\u2026]/.test(s.name)));
  }
});


test('phone model names identify the model family without hiding it', async () => {
  const { compactModelName } = await import('../web/src/lib/composerModelLabel.ts');
  for (const [full, short] of [['Claude Sonnet 4.5', 'Sonnet'], ['Opus 5.5', 'Opus'], ['Codex GPT 5.5', 'Codex'], ['Kimi K2 Thinking', 'Kimi K2']]) {
    assert.equal(compactModelName(full, null), short);
  }
});

test('compact plan names retain Codex while API names keep their model version', async () => {
  const { compactModelName } = await import('../web/src/lib/composerModelLabel.ts');
  assert.equal(compactModelName('GPT-6.1 Sol', 'codex-cli'), 'Codex');
  assert.equal(compactModelName('GPT-5.5', 'openrouter'), 'GPT-5.5');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { botSlug, routeBot, linkedWork, workHash } from '../web/src/lib/userRoutes.ts';
import { modelDisplayName } from '../web/src/lib/modelDisplay.ts';

test('Bot routes distinguish duplicate names and survive reorder, rename and copied links', () => {
  const first = { id: 'bot_route_fixture_a', name: 'Review Bot' };
  const second = { id: 'bot_route_fixture_b', name: 'Review Bot' };
  const slug = botSlug(first);
  assert.match(slug, /^review-bot~/);
  assert.ok(!slug.includes('bot_'));
  assert.ok(!slug.includes(first.id));
  assert.notEqual(slug, botSlug(second));
  assert.equal(routeBot(slug, [second, first]), first);
  const renamed = { ...first, name: 'Renamed Bot' };
  assert.equal(routeBot(slug, [renamed]), renamed);
  assert.equal(routeBot(first.id, [first]), first, 'legacy IDs remain resolvable');
  assert.equal(routeBot(slug, [second]), undefined, 'another account cannot resolve the link');
  assert.match(botSlug({ ...first, name: '🤖' }), /^bot~/);
  assert.ok(!botSlug({ ...first, name: first.id }).includes(first.id));
});

test('Goals and Reports routes round trip with distinct URLs and optional Bot scope', () => {
  assert.notEqual(workHash({ tab: 'Goals' }), workHash({ tab: 'Reports' }));
  for (const tab of ['Goals', 'Reports'] as const) {
    assert.deepEqual(linkedWork(workHash({ tab })), { tab });
    const scoped = { tab, botSlug: botSlug({ id: 'bot_scope_fixture', name: 'Review Bot' }) };
    const hash = workHash(scoped);
    assert.ok(!hash.includes('bot_'));
    assert.deepEqual(linkedWork(hash), scoped);
  }
  assert.equal(linkedWork('#bot/%ZZ/goals'), null);
  assert.equal(linkedWork('#unknown'), null);
});

test('model labels prefer the catalog and humanize provider IDs while it is unavailable', () => {
  assert.equal(modelDisplayName('x-ai/grok-4.7'), 'Grok 4.7');
  assert.equal(modelDisplayName('x-ai/grok-4.7', 'Grok 4.7 Preview'), 'Grok 4.7 Preview');
  assert.equal(modelDisplayName('x-ai/grok-4.7', 'x-ai/grok-4.7'), 'Grok 4.7');
  assert.equal(modelDisplayName('openai/gpt-5.5'), 'GPT 5.5');
});

for (const [id, catalogName, expected] of [
  ['claude-opus-5-5', null, 'Claude Opus 5.5'],
  ['claude-sonnet-5-5', 'claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-haiku-4-5', '', 'Claude Haiku 4.5'],
  ['claude-opus-5-5-20251001', null, 'Claude Opus 5.5'],
  ['claude-sonnet-5-5-20251001', null, 'Claude Sonnet 5.5'],
  ['claude-haiku-4-5-20251001', null, 'Claude Haiku 4.5'],
  ['claude-opus-4-20250514', null, 'Claude Opus 4'],
  ['anthropic/claude-haiku-4-5-20251001', null, 'Claude Haiku 4.5'],
  ['claude/opus-4-6', null, 'Opus 4.6'],
  ['claude/default', 'claude-opus-5-5', 'Claude Opus 5.5'],
  ['claude-opus-5-5', 'Opus 5.5 Preview', 'Opus 5.5 Preview'],
  ['openai/gpt-5.5', 'GPT-5.5', 'GPT-5.5'],
  ['openai/gpt-5.5', null, 'GPT 5.5'],
  ['x-ai/grok-4.7', null, 'Grok 4.7'],
  ['meta-llama/llama-3.3-70b', null, 'LLAMA 3.3 70b'],
] as const) test(`model display: ${id} with ${catalogName ?? 'no catalog name'}`, () => {
  assert.equal(modelDisplayName(id, catalogName), expected);
});

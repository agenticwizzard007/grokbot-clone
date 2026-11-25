import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsCache } from '../web/src/lib/settingsReads.ts';
import { createSuggestionCache, suggestionCacheKey, type Suggestions } from '../web/src/lib/suggestionCache.ts';
import { SUGGESTION_FILTER_VERSION } from '../server/src/suggestion-policy.ts';

test('old saved suggestion snapshots and old server responses are never displayed', async () => {
  const storage = createSettingsCache<Suggestions>();
  storage.scope('account');
  const old = { suggestions: [{ slug: 'bluefox_email', name: 'BlueFox Email', categories: [], noAuth: false, reason: 'Email summaries' }] };
  await storage.refresh('bot-draft', async () => old);
  const cache = createSuggestionCache(storage);
  assert.equal(cache.peek('bot-draft'), undefined, 'unversioned keys are invalidated');
  await storage.refresh(suggestionCacheKey('bot-draft'), async () => ({ ...old, filterVersion: 'purpose-1' }));
  assert.equal(cache.peek('bot-draft'), undefined, 'old filter snapshots cannot be used during a refresh or error');
  await assert.rejects(cache.refresh('bot-draft', async () => old), /Reload the page/);
  assert.equal(cache.peek('bot-draft'), undefined);
  const current = { suggestions: [], filterVersion: SUGGESTION_FILTER_VERSION };
  await cache.refresh('bot-draft', async () => current);
  assert.deepEqual(cache.peek('bot-draft'), current);
  cache.scope('another-account');
  assert.equal(cache.peek('bot-draft'), undefined);
});

test('last suggestions survive draft changes and reload per Bot, version and account', async t => {
  const data = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  t.after(() => original ? Object.defineProperty(globalThis, 'sessionStorage', original) : Reflect.deleteProperty(globalThis, 'sessionStorage'));
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) } });
  const first = { suggestions: [], hasContext: true, filterVersion: SUGGESTION_FILTER_VERSION };
  const cache = createSuggestionCache(); cache.scope('owner');
  await cache.refresh('first draft', async () => first, 'bot-a');
  assert.deepEqual(cache.last('bot-a'), first); assert.equal(cache.last('bot-b'), undefined);
  const reloaded = createSuggestionCache(); reloaded.scope('owner');
  assert.deepEqual(reloaded.last('bot-a'), first);
  assert.equal(reloaded.peek('changed draft'), undefined);
  let finish!: (value: Suggestions) => void;
  const old = cache.refresh('slow draft', () => new Promise(resolve => { finish = resolve; }), 'bot-a');
  const latest = { ...first, hasContext: false };
  await cache.refresh('new draft', async () => latest, 'bot-a');
  finish(first); await old; assert.deepEqual(cache.last('bot-a'), latest);
  cache.scope('other'); assert.equal(cache.last('bot-a'), undefined);
  const cleared = createSuggestionCache(); cleared.scope('owner'); assert.equal(cleared.last('bot-a'), undefined);
  data.set(`swarm.suggestions:${SUGGESTION_FILTER_VERSION}:owner`, JSON.stringify([['bot-a', { ...first, filterVersion: 'old' }]]));
  const outdated = createSuggestionCache(); outdated.scope('owner'); assert.equal(outdated.last('bot-a'), undefined);
});

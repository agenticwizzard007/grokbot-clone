import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createSettingsCache } from '../web/src/lib/settingsReads.ts';
import { createSuggestionCache, suggestionCacheKey, SUGGESTION_STORAGE_KEY, SUGGESTION_STORAGE_VERSION, type Suggestions } from '../web/src/lib/suggestionCache.ts';
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
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => original ? Object.defineProperty(globalThis, 'localStorage', original) : Reflect.deleteProperty(globalThis, 'localStorage'));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) } });
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
  data.set(SUGGESTION_STORAGE_KEY, JSON.stringify({ version: SUGGESTION_STORAGE_VERSION, filterVersion: SUGGESTION_FILTER_VERSION, account: 'owner', bots: [['bot-a', { ...first, filterVersion: 'old' }]] }));
  const outdated = createSuggestionCache(); outdated.scope('owner'); assert.equal(outdated.last('bot-a'), undefined);
});

function localSnapshot(t: TestContext) {
  const data = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => original ? Object.defineProperty(globalThis, 'localStorage', original) : Reflect.deleteProperty(globalThis, 'localStorage'));
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key),
  } });
  return data;
}
const suggestion: Suggestions = { filterVersion: SUGGESTION_FILTER_VERSION, hasContext: true, suggestions: [{
  slug: 'slack', name: 'Slack', managedAuth: true, noAuth: false, categories: [], reason: 'Private draft text',
  logo: 'https://example.test/private-token', description: 'Private message text',
}] };

test('cold suggestions persist only bounded catalog identity, never draft text or provider URLs', async t => {
  const data = localSnapshot(t);
  const cache = createSuggestionCache(); cache.scope('owner');
  for (let index = 0; index < 90; index++) await cache.refresh(`Private instructions ${index}`, async () => suggestion, `bot-${index}`);
  const raw = data.get(SUGGESTION_STORAGE_KEY)!;
  assert.ok(raw.length <= 32_000);
  assert.doesNotMatch(raw, /Private|private-token|https:/);
  assert.equal(JSON.parse(raw).bots.length, 20);
  const reload = createSuggestionCache(); reload.scope('owner');
  assert.equal(reload.last('bot-0'), undefined);
  assert.equal(reload.last('bot-89')?.suggestions[0].slug, 'slack');
  assert.equal(reload.last('bot-89')?.suggestions[0].reason, 'Slack was suggested for this Bot.');
});

test('cold suggestions ignore schema changes, filter changes, another account and malformed snapshots', async t => {
  const data = localSnapshot(t);
  const saved = { version: SUGGESTION_STORAGE_VERSION, filterVersion: SUGGESTION_FILTER_VERSION, account: 'owner', bots: [['bot', suggestion]] };
  for (const value of [{ ...saved, version: 0 }, { ...saved, filterVersion: 'old' }, { ...saved, account: 'other' }, { ...saved, bots: null }]) {
    data.set(SUGGESTION_STORAGE_KEY, JSON.stringify(value));
    const cache = createSuggestionCache(); cache.scope('owner');
    assert.equal(cache.last('bot'), undefined);
    assert.equal(data.has(SUGGESTION_STORAGE_KEY), false);
  }
  for (const value of ['{', JSON.stringify({ ...saved, bots: [null, {}, ['bot', {}]] }), 'x'.repeat(32_001)]) {
    data.set(SUGGESTION_STORAGE_KEY, value);
    const cache = createSuggestionCache(); cache.scope('owner'); assert.equal(cache.last('bot'), undefined);
  }
});

test('sign-out and account switching erase snapshots and reject late responses', async t => {
  const data = localSnapshot(t);
  const cache = createSuggestionCache(); cache.scope('owner');
  await cache.refresh('draft', async () => suggestion, 'bot');
  let finish!: (value: Suggestions) => void;
  const pending = cache.refresh('pending', () => new Promise(resolve => { finish = resolve; }), 'bot');
  cache.scope(undefined);
  assert.equal(data.has(SUGGESTION_STORAGE_KEY), false);
  finish(suggestion); await pending;
  assert.equal(cache.last('bot'), undefined); assert.equal(data.has(SUGGESTION_STORAGE_KEY), false);
  cache.scope('owner'); await cache.refresh('draft', async () => suggestion, 'bot');
  cache.scope('other'); assert.equal(cache.last('bot'), undefined);
  assert.equal(data.has(SUGGESTION_STORAGE_KEY), false);
});

test('blocked local storage keeps in-memory suggestions usable', async t => {
  localSnapshot(t);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  const cache = createSuggestionCache(); cache.scope('owner');
  await cache.refresh('draft', async () => suggestion, 'bot');
  assert.deepEqual(cache.last('bot'), suggestion);
});

test('a confirmed signed-out cold load clears the previous session snapshot', t => {
  const data = localSnapshot(t);
  data.set(SUGGESTION_STORAGE_KEY, JSON.stringify({ version: SUGGESTION_STORAGE_VERSION, filterVersion: SUGGESTION_FILTER_VERSION, account: 'owner', bots: [['bot', suggestion]] }));
  const cache = createSuggestionCache();
  cache.scope(undefined);
  assert.equal(data.has(SUGGESTION_STORAGE_KEY), false);
});

test('R9 server snapshots seed synchronously before render, refresh replaces them and deletion clears them', async t => {
  const data = localSnapshot(t);
  const cache = createSuggestionCache(); cache.scope('owner');
  const saved = { ...suggestion, version: 1, computedAt: 100 };
  cache.seed('bot', saved);
  assert.equal(cache.last('bot')?.suggestions[0].slug, 'slack');
  assert.doesNotMatch(data.get(SUGGESTION_STORAGE_KEY)!, /Private|private-token/);
  await cache.refresh('connected', async () => ({ ...suggestion, suggestions: [] }), 'bot');
  cache.seed('bot', saved);
  assert.deepEqual(cache.last('bot')?.suggestions, [], 'repeated roster events cannot overwrite a newer local refresh');
  cache.seed('bot', { ...saved, computedAt: 101 });
  assert.equal(cache.last('bot')?.suggestions.length, 1);
  await cache.refresh('new connection', async () => ({ ...suggestion, computedAt: 300, suggestions: [] }), 'bot');
  cache.seed('bot', { ...saved, computedAt: 200 });
  assert.deepEqual(cache.last('bot')?.suggestions, [], 'a delayed Bot payload cannot replace a later refresh');
  cache.remove('bot');
  assert.equal(cache.last('bot'), undefined);
  assert.equal(data.has(SUGGESTION_STORAGE_KEY), false);
  cache.scope('other');
  cache.seed('bot', { ...saved, version: 0 });
  assert.equal(cache.last('bot'), undefined);
});

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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MetadataCache } from '../server/src/lib/metadata-cache.js';
import { readDeadline } from '../web/src/lib/readDeadline.js';
import { toolkitLogo } from '../web/src/lib/toolkitLogos.js';
import { retryImport } from '../web/src/lib/retryImport.js';

const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
test('slow read-only upstream is aborted and leaves loading at its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal;
  const request = readDeadline(s => { signal = s; return new Promise(() => {}); });
  const check = assert.rejects(request, /unavailable/i);
  t.mock.timers.tick(4000); await check;
  assert.equal(signal!.aborted, true);
});
test('metadata TTL shares cold reads, serves stale data during refresh, and isolates accounts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cache = new MetadataCache<string>(1000);
  let count = 0;
  const load = async () => { count++; return 'cached'; };
  assert.deepEqual(await Promise.all([cache.read('alice', load), cache.read('alice', load)]), ['cached', 'cached']);
  assert.equal(count, 1);
  t.mock.timers.tick(1001);
  let signal: AbortSignal;
  assert.equal(await cache.read('alice', s => { signal = s; return new Promise(() => {}); }), 'cached');
  t.mock.timers.tick(3500); await settle();
  assert.equal(signal!.aborted, true);
  assert.equal(await cache.read('alice', load), 'cached');
  assert.equal(await cache.read('bob', async () => 'other account'), 'other account');
});
test('metadata cold timeout cannot be overwritten by a late response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cache = new MetadataCache<string>();
  let finish: (v: string) => void;
  const request = cache.read('one', () => new Promise(resolve => { finish = resolve; }));
  const check = assert.rejects(request, /unavailable/);
  t.mock.timers.tick(3500); await check;
  finish!('late'); await settle();
  await assert.rejects(cache.read('one', async () => 'fresh'), /unavailable/);
  t.mock.timers.tick(5000);
  assert.equal(await cache.read('one', async () => 'fresh'), 'fresh');
});
test('chunk failure retries the local module URL once without a document reload', async () => {
  const origin = 'http://localhost:5198';
  const seen: string[] = [];
  const result = await retryImport(async () => { throw new TypeError(`Failed to fetch dynamically imported module: ${origin}/assets/TasksView-abc.js`); }, async url => { seen.push(url); return 'loaded'; }, origin);
  assert.equal(result, 'loaded'); assert.equal(seen.length, 1);
  assert.equal(new URL(seen[0]).pathname, '/assets/TasksView-abc.js');
  assert.ok(new URL(seen[0]).searchParams.has('retry'));
});
test('chunk recovery rejects foreign URLs and expires stalled imports', async t => {
  const origin = 'http://localhost:5198';
  await assert.rejects(retryImport(async () => { throw new Error('https://foreign.test/evil.js'); }, async () => { assert.fail('foreign URL'); }, origin), /foreign/);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const request = retryImport(() => new Promise(() => {}), async () => {}, origin);
  const check = assert.rejects(request, /unavailable/i);
  t.mock.timers.tick(4500); await check;
});

test('Google Tasks uses the shared letter avatar instead of checkbox-like metadata artwork', () => {
  for (const slug of ['googletasks', 'google_tasks']) assert.equal(toolkitLogo({ slug, name: 'Google Tasks', logo: 'https://logos.composio.dev/api/googletasks' }), undefined);
  assert.equal(toolkitLogo({ slug: 'gmail', name: 'Gmail' }), '/assets/toolkits/gmail.svg');
});

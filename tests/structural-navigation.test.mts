import assert from 'node:assert/strict';
import test from 'node:test';
import { APP_SECTIONS, BOT_TABS, parentScreen, parentLabel, parseScreen, resolveScreen, screenHash, ScreenHistory } from '../web/src/lib/navigation.ts';
import { browserHistory } from './fixtures/browser-history.mts';

const bots = [{ id: 'fixture', name: 'Fixture Bot' }];
const routes: [string, string | null, string][] = [
  ...['#bots', '#settings', '#settings/', '#tasks', '#team', '#goals', '#reports', '#search', '#apps/connect'].map(hash => [hash, null, ''] as [string, null, string]),
  ['#bot/fixture', '#bots', 'Back to Bots'],
  ['#new-bot', '#bots', 'Back to Bots'], ['#new-bot/group', '#new-bot', 'Back to create a Bot'],
  ...APP_SECTIONS.flatMap(section => [`#settings/${section}`, `#${section}`].map(hash => [hash, '#settings', 'Back to Settings'] as [string, string, string])),
  ['#whatsapp', '#settings', 'Back to Settings'],
  ['#bot/fixture/settings', '#bot/fixture', 'Back to Fixture Bot chat'],
  ...BOT_TABS.map(tab => [`#bot/fixture/settings/${tab}`, '#bot/fixture', 'Back to Fixture Bot chat'] as [string, string, string]),
  ...['activity', 'tasks', 'files', 'setup'].map(tab => [`#bot/fixture/details/${tab}`, '#bot/fixture', 'Back to Fixture Bot chat'] as [string, string, string]),
  ['#bot/fixture/details', '#bot/fixture', 'Back to Fixture Bot chat'],
  ['#bot/fixture/details/files/reports', '#bot/fixture/details/files', 'Back to files'],
  ...['responsibilities', 'harness', 'files', 'history'].map(tab => [`#bot/fixture/details/setup/${tab}`, '#bot/fixture/details/setup', 'Back to setup'] as [string, string, string]),
  ...['Tasks', 'Team', 'Goals', 'Reports'].map(tab => [`#bot/fixture/${tab.toLowerCase()}`, `#${tab.toLowerCase()}`, `Back to ${tab}`] as [string, string, string]),
];
for (const [hash, target, label] of routes) test(`structural parent: ${hash}`, () => {
  const screen = parseScreen(hash)!;
  const parent = parentScreen(screen);
  assert.equal(parent && screenHash(parent), target);
  assert.equal(parentLabel(screen, bots), label);
});

for (const origin of ['#settings', '#team', '#bots']) test(`structural Back uses only the immediate parent from ${origin}`, () => {
  const f = browserHistory(origin);
  const history = new ScreenHistory(f.window, () => 'account', () => {});
  f.window.addEventListener('popstate', history.restore);
  history.initialize({ kind: 'bots' });
  history.navigate({ kind: 'settings', section: 'usage' });
  const before = f.entries.length;
  history.backTo(parentScreen(history.screen!)!);
  assert.equal(f.location.hash, '#settings');
  assert.equal(f.entries.length, origin === '#settings' ? before : before + 1);
  if (origin === '#settings') {
    f.history.go(1); assert.equal(f.location.hash, '#settings/usage', 'Forward restores the child');
  } else {
    f.history.go(-1); assert.equal(f.location.hash, '#settings/usage', 'parent navigation retains the deep link');
    f.history.go(-1); assert.equal(f.location.hash, origin);
    f.history.go(1); f.history.go(1); assert.equal(f.location.hash, '#settings');
  }
});

test('structural Back does not skip unrelated entries to an older parent', () => {
  const f = browserHistory('#settings');
  const history = new ScreenHistory(f.window, () => 'account', () => {});
  history.initialize({ kind: 'bots' });
  history.navigate({ kind: 'work', route: { tab: 'Team' } });
  history.navigate({ kind: 'settings', section: 'computer' });
  history.backTo({ kind: 'settings' });
  assert.equal(f.entries.length, 4);
  assert.equal(f.location.hash, '#settings');
});

test('structural Back recognizes an immediate renamed or legacy Bot parent', () => {
  const f = browserHistory('#bot/fixture');
  const history = new ScreenHistory(f.window, () => 'account', () => {});
  f.window.addEventListener('popstate', history.restore);
  history.initialize({ kind: 'bots' });
  const resolve = (screen: Parameters<typeof resolveScreen>[0]) => resolveScreen(screen, bots, true);
  const child = resolve(parseScreen('#bot/fixture/settings/memories')!)!;
  history.navigate(child);
  history.backTo(parentScreen(child)!, resolve);
  assert.equal(f.location.hash, '#bot/fixture');
  f.history.go(1); assert.equal(f.location.hash, screenHash(child));
});

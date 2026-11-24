import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_SECTIONS, BOT_TABS, parseScreen, screenHash, resolveScreen, parentScreen, ScreenHistory, type Screen } from '../web/src/lib/navigation.ts';

const chat: Screen = { kind: 'chat', bot: 'quinn' };
const screens: Screen[] = [
  { kind: 'bots' }, chat, { kind: 'settings' },
  ...APP_SECTIONS.map(section => ({ kind: 'settings', section } as Screen)),
  ...BOT_TABS.map(tab => ({ kind: 'bot-settings', bot: 'quinn', tab } as Screen)),
  ...(['Tasks', 'Team', 'Goals', 'Reports'] as const).flatMap(tab => [{ kind: 'work', route: { tab } }, { kind: 'work', route: { tab, botSlug: 'Quinn / encoded' } }] as Screen[]),
  ...(['activity', 'tasks', 'library', 'configuration'] as const).map(tab => ({ kind: 'details', bot: 'quinn', tab } as Screen)),
  ...(['responsibilities', 'harness', 'files', 'history'] as const).map(setup => ({ kind: 'details', bot: 'quinn', tab: 'configuration', setup } as Screen)),
  { kind: 'details', bot: 'quinn', tab: 'library', reports: true },
  { kind: 'create' }, { kind: 'group' }, { kind: 'search' }, { kind: 'apps' },
];
for (const screen of screens) test(`hash round trip: ${screenHash(screen)}`, () => assert.deepEqual(parseScreen(screenHash(screen)), screen));
test('legacy links, malformed routes and auth fragments', () => {
  assert.deepEqual(parseScreen('#whatsapp'), { kind: 'settings', section: 'messaging' });
  assert.deepEqual(parseScreen('#bot/quinn/settings'), { kind: 'bot-settings', bot: 'quinn', tab: 'general' });
  for (const hash of ['general', '#bot/id/details/toString', '', '#access_token=secret', '#bot/%ZZ', '#settings/missing', '#bot/id/details/nope', '#bot/id/settings/nope', '#bot/id/details/activity/history']) assert.equal(parseScreen(hash), null, hash);
});

function fixture(hash = '#bots') {
  const location = { pathname: '/', search: '?fixture=1', hash };
  const entries = [{ hash, state: null as any }];
  let index = 0, pushes = 0, replaces = 0, account = 'a';
  const applied: Screen[] = [];
  let history: ScreenHistory;
  let guard: ((screen: Screen, proceed: () => void) => boolean) | undefined;
  const browser = { location, history: {
    get state() { return entries[index].state; },
    pushState(state: any, _title: string, url: any) { pushes++; entries.splice(++index); location.hash = new URL(url, 'http://local').hash; entries.push({ state, hash: location.hash }); },
    replaceState(state: any, _title: string, url: any) { replaces++; location.hash = new URL(url, 'http://local').hash; entries[index] = { state, hash: location.hash }; },
    go(delta: number) { assert.ok(index + delta >= 0 && index + delta < entries.length, 'never traverses outside the app'); index += delta; location.hash = entries[index].hash; history.restore(); },
  } };
  const reload = () => { history = new ScreenHistory(browser, () => account, screen => applied.push(screen), (screen, next) => guard ? guard(screen, next) : (next(), true)); history.initialize({ kind: 'bots' }); };
  reload();
  return { get history() { return history; }, browser, reload, applied, entries, get pushes() { return pushes; }, get replaces() { return replaces; }, account(value: string) { account = value; }, guard(value: typeof guard) { guard = value; } };
}
test('screen changes push, repeated selections do not, normalization replaces', () => {
  const f = fixture('');
  assert.equal(f.replaces, 1);
  f.history.navigate(chat);
  for (const section of ['general', 'account', 'messaging', 'usage'] as const) f.history.navigate({ kind: 'settings', section });
  assert.equal(f.pushes, 5);
  f.history.navigate({ kind: 'settings', section: 'usage' });
  assert.equal(f.pushes, 5);
  assert.equal(f.replaces, 1);
  for (const hash of ['#settings/messaging', '#settings/account', '#settings/general', '#bot/quinn']) { f.browser.history.go(-1); assert.equal(f.browser.location.hash, hash); }
  f.browser.history.go(1);
  assert.equal(f.browser.location.hash, '#settings/general');
});
test('reload keeps the route, origin and Forward; closing skips only the current surface', () => {
  const f = fixture();
  f.history.navigate(chat);
  f.history.navigate({ kind: 'settings', section: 'general' });
  f.history.navigate({ kind: 'settings', section: 'usage' });
  f.reload();
  assert.equal(f.browser.location.hash, '#settings/usage');
  f.history.back({ kind: 'bots' }, screen => screen.kind !== 'settings');
  assert.equal(f.browser.location.hash, '#bot/quinn');
  f.browser.history.go(1);
  assert.equal(f.browser.location.hash, '#settings/general');
});
test('search close pops its entry without leaving a no-op Back', () => {
  const f = fixture(); f.history.navigate(chat); f.history.navigate({ kind: 'search' });
  f.history.back(chat);
  assert.equal(f.browser.location.hash, '#bot/quinn');
  f.browser.history.go(-1);
  assert.equal(f.browser.location.hash, '#bots');
});
test('direct deep links and another account use a parent without leaving the app', () => {
  const f = fixture('#new-bot/group');
  f.history.back(parentScreen(f.history.screen!));
  assert.equal(f.browser.location.hash, '#new-bot');
  assert.equal(f.pushes, 0);
  f.history.navigate(chat);
  f.account('b'); f.reload();
  assert.deepEqual(f.history.trail, []);
  f.history.back({ kind: 'bots' });
  assert.equal(f.browser.location.hash, '#bots');
});
test('draft guard undoes a browser traversal and preserves Forward on Keep editing', () => {
  const f = fixture(); f.history.navigate(chat); f.history.navigate({ kind: 'bot-settings', bot: 'quinn', tab: 'general' });
  let pending: (() => void) | undefined;
  f.guard((_screen, next) => { pending = next; return false; });
  f.browser.history.go(-1);
  assert.equal(f.browser.location.hash, '#bot/quinn/settings/general');
  f.guard(undefined); pending!();
  assert.equal(f.browser.location.hash, '#bot/quinn');
  f.browser.history.go(1);
  assert.equal(f.browser.location.hash, '#bot/quinn/settings/general');
});

test('unknown/deleted Bot links fall back only after the account roster resolves', () => {
  for (const screen of [{ kind: 'chat', bot: 'gone' }, { kind: 'details', bot: 'gone', tab: 'activity' }, { kind: 'bot-settings', bot: 'gone', tab: 'general' }] as Screen[]) {
    assert.equal(resolveScreen(screen, [], false), null);
    assert.deepEqual(resolveScreen(screen, [], true), { kind: 'bots' });
  }
  const bots = [{ id: 'quinn', name: 'Quinn' }];
  const canonical = resolveScreen(chat, bots, true)!;
  assert.match(screenHash(canonical), /^#bot\/quinn~/);
  assert.deepEqual(resolveScreen(canonical, bots, true), canonical);
  assert.deepEqual(resolveScreen(canonical, [{id:'other-account-bot',name:'Quinn'}], true), { kind: 'bots' });
  const renamed = resolveScreen(canonical, [{id:'quinn',name:'Renamed'}], true)!;
  assert.match(screenHash(renamed), /^#bot\/renamed~/);
});

test('legacy scoped work links normalize without dropping their tab', () => {
  const route = resolveScreen({kind:'work',route:{tab:'Goals',botSlug:'quinn'}}, [{id:'quinn',name:'Quinn'}], true)!;
  assert.match(screenHash(route), /^#bot\/quinn~[^/]+\/goals$/);
});

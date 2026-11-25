import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_SECTIONS, BOT_TABS, backTarget, backLabel, outsideSurface, parseScreen, screenHash, resolveScreen, parentScreen, ScreenHistory, type Screen } from '../web/src/lib/navigation.ts';

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

for (const surface of [
  { kind: 'settings', section: 'account' }, { kind: 'work', route: { tab: 'Tasks' } },
  { kind: 'create' }, { kind: 'bot-settings', bot: 'quinn', tab: 'general' },
] as Screen[]) test(`reload Back label and destination share the persisted trail: ${surface.kind}`, () => {
  const f = fixture();
  f.history.navigate(chat);
  f.history.navigate({ kind: 'details', bot: 'quinn', tab: 'activity' });
  f.history.navigate(surface);
  f.reload();
  const matches = (other: Screen) => outsideSurface(surface, other);
  const target = backTarget(f.history.trail, { kind: 'bots' }, matches);
  assert.equal(backLabel(target.screen), 'Back to details');
  f.history.back({ kind: 'bots' }, matches);
  assert.equal(f.browser.location.hash, screenHash(target.screen));
});

test('reload fallback label ignores a copied trail for a different hash or account', () => {
  const f = fixture();
  f.history.navigate({ kind: 'details', bot: 'quinn', tab: 'activity' });
  f.history.navigate({ kind: 'create' });
  // Address-bar/redirect changes can carry another entry's state into reload.
  f.browser.location.hash = '#settings/account';
  assert.deepEqual(f.history.trail, []);
  f.reload();
  const target = backTarget(f.history.trail, { kind: 'bots' });
  assert.equal(backLabel(target.screen), 'Back to Bots');
  f.history.back(target.screen);
  assert.equal(f.browser.location.hash, '#bots');
  f.history.navigate({ kind: 'create' }); f.account('b'); f.reload();
  assert.equal(backLabel(backTarget(f.history.trail, chat).screen), 'Back to chat');
  f.history.back(chat);
  assert.equal(f.browser.location.hash, '#bot/quinn');
});

test('phone parent list navigation preserves sections without duplicate list entries, including reload', () => {
  const f = fixture(); f.history.navigate(chat); f.history.navigate({ kind: 'settings' });
  f.history.navigate({ kind: 'settings', section: 'account' });
  for (const section of ['messaging', 'general'] as const) {
    f.history.navigate({ kind: 'settings' });
    assert.equal(f.browser.location.hash, '#settings');
    f.browser.history.go(-1);
    assert.match(f.browser.location.hash, /^#settings\//, 'parent navigation pushes rather than pops');
    f.browser.history.go(1); f.reload();
    f.history.navigate({ kind: 'settings', section });
  }
  const hashes = ['#bots', '#bot/quinn', '#settings', '#settings/account', '#settings/messaging', '#settings/general'];
  assert.deepEqual(f.entries.map(entry => entry.hash), hashes);
  for (const hash of hashes.slice(0, -1).reverse()) { f.browser.history.go(-1); assert.equal(f.browser.location.hash, hash); }
  for (const hash of hashes.slice(1)) { f.browser.history.go(1); assert.equal(f.browser.location.hash, hash); }
});

test('phone direct section parent stays in-app and its next section preserves the deep link', () => {
  const f = fixture('#settings/account');
  f.history.navigate({ kind: 'settings' }); f.reload();
  f.history.navigate({ kind: 'settings', section: 'messaging' });
  assert.deepEqual(f.entries.map(entry => entry.hash), ['#settings/account', '#settings/messaging']);
  f.browser.history.go(-1);
  f.history.back({ kind: 'bots' }, screen => screen.kind !== 'settings');
  assert.equal(f.browser.location.hash, '#bots');
});

// Exercise the store used by all visible Back controls, not only the router.
test('all surface labels refresh from restored history and resolve deleted Bot destinations', async () => {
  const { browserHistory } = await import('./fixtures/browser-history.mts');
  const f = browserHistory('#bots');
  const storage = { getItem: () => null, setItem() {}, removeItem() {}, length: 0, key: () => null };
  Object.assign(globalThis, { window: f.window, history: f.history, localStorage: storage, sessionStorage: storage,
    document: { documentElement: { dataset: {}, style: {} }, visibilityState: 'visible' } });
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'Linux' }, configurable: true });
  const { useStore } = await import('../web/src/store.ts');
  const { useConfigUI, navigation, returnLabel, backFromWork } = await import('../web/src/configStore.ts');
  const bot = { id: 'quinn', name: 'Quinn' } as any;
  useStore.setState({ user: { id: 'a' } as any, bots: [bot], botsLoaded: true, selectedBotId: bot.id, mobile: false });
  const resolvedChat = resolveScreen(chat, [bot], true)!;
  const details: Screen = { kind: 'details', bot: 'quinn', tab: 'activity' };
  for (const surface of [{ kind: 'create' }, { kind: 'settings', section: 'account' },
    { kind: 'work', route: { tab: 'Tasks' } }, { kind: 'bot-settings', bot: 'quinn', tab: 'general' }] as Screen[]) {
    f.reset(screenHash(surface));
    const seed = (trail: string[]) => f.history.replaceState({ swarmNavigation: { account: 'a', hash: f.location.hash, trail } }, '', f.location.hash);
    seed([screenHash(details)]); navigation.initialize({ kind: 'bots' });
    assert.equal(useConfigUI.getState().backLabel, 'Back to details');
    // A still-mounted surface must react to a different restored origin too.
    seed([screenHash(resolvedChat)]); navigation.initialize({ kind: 'bots' });
    assert.equal(useConfigUI.getState().backLabel, 'Back to chat');
    seed(['#bot/deleted/details/activity']); navigation.initialize({ kind: 'bots' });
    assert.equal(returnLabel(), 'Back to Bots');
    assert.equal(useConfigUI.getState().backLabel, 'Back to Bots');
    seed([]); navigation.initialize({ kind: 'bots' });
    assert.equal(useConfigUI.getState().backLabel, surface.kind === 'bot-settings' ? 'Back to chat' : 'Back to Bots');
    if (surface.kind === 'settings') useConfigUI.getState().closeAppSettings();
    else if (surface.kind === 'work') backFromWork();
    else if (surface.kind === 'bot-settings') useConfigUI.getState().closeBotSettings();
    else useStore.getState().setModal(null);
    assert.equal(f.location.hash, surface.kind === 'bot-settings' ? screenHash(resolvedChat) : '#bots');
  }
  useStore.setState({ mobile: true }); f.reset('#new-bot'); navigation.initialize({ kind: 'bots' });
  assert.equal(useConfigUI.getState().backLabel, 'Back to Bots');
  useStore.getState().setModal(null);
  assert.equal(f.location.hash, '#bots');
  // A pending Bot link is not a deleted Bot. Keep the work shell while the
  // roster is held, including when a newer Settings action cancels that link.
  useStore.setState({ bots: [], botsLoaded: false, mobile: false });
  f.reset('#bot/quinn/tasks'); navigation.initialize({ kind: 'bots' });
  useConfigUI.getState().openAppSettings('general');
  navigation.navigate({ kind: 'bot-settings', bot: 'quinn', tab: 'skills' });
  useConfigUI.getState().openAppSettings('general');
  assert.equal(useConfigUI.getState().view, 'tasks', 'unresolved origins retain their loading surface');
  assert.equal(f.location.hash, '#settings/general');
});

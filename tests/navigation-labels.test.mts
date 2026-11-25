import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_SECTIONS, SETTINGS_LABELS, backLabel, parseScreen, screenHash, screenTitle, type Screen } from '../web/src/lib/navigation.ts';
import { browserHistory } from './fixtures/browser-history.mts';

const f = browserHistory('#bots');
const storage = { getItem: () => null, setItem() {}, removeItem() {}, length: 0, key: () => null };
Object.assign(globalThis, { window: f.window, history: f.history, localStorage: storage, sessionStorage: storage,
  document: { title: '', documentElement: { dataset: {}, style: {} }, visibilityState: 'visible' } });
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'Linux' }, configurable: true });
const { useStore } = await import('../web/src/store.ts');
const { useConfigUI, navigation, backFromSurface, backFromWork, returnLabel } = await import('../web/src/configStore.ts');
const bots = [{ id: 'fixture', name: 'Fixture Bot', kind: 'agent' }, { id: 'room', name: 'Fixture group', kind: 'room' }] as any;
useStore.setState({ user: { id: 'account' } as any, bots, botsLoaded: true, selectedBotId: 'fixture', mobile: false,
  loadRows: async () => {}, loadRoutines: async () => {} });
const go = (hash: string) => navigation.navigate(parseScreen(hash)!);
function reset(hash = '#bots', mobile = false) {
  f.reset(hash); navigation.reset(); useStore.setState({ mobile }); navigation.initialize({ kind: 'bots' });
}
const label = (expected: string) => {
  assert.equal(returnLabel(), expected);
  assert.equal(useConfigUI.getState().backLabel, expected);
};

for (const mobile of [false, true]) {
  test(`Settings then Tasks returns to the real Settings screen, phone=${mobile}`, () => {
    reset('#settings/permissions', mobile); go('#tasks'); label('Back to Settings');
    backFromWork(); assert.equal(f.location.hash, '#settings/permissions');
    label('Back to Bots');
  });
  test(`Tasks then Settings replaces an older group form origin, phone=${mobile}`, () => {
    reset('#new-bot/group', mobile); go('#settings/account'); go('#tasks');
    useConfigUI.getState().openAppSettings();
    label('Back to Tasks'); go('#settings/apps'); label('Back to Tasks');
    navigation.initialize({ kind: 'bots' }); label('Back to Tasks');
    useConfigUI.getState().closeAppSettings(); assert.equal(f.location.hash, '#tasks');
  });
  test(`direct entry and reload ignore selected chat and copied history, phone=${mobile}`, () => {
    for (const hash of ['#tasks', '#team', '#goals', '#reports', '#new-bot', '#settings/account']) {
      reset('#settings/general', mobile);
      // Address-bar entry carries stale state for another route.
      f.location.hash = hash; navigation.initialize({ kind: 'bots' });
      label('Back to Bots'); navigation.initialize({ kind: 'bots' }); label('Back to Bots');
      if (hash.startsWith('#settings')) useConfigUI.getState().closeAppSettings();
      else if (hash === '#new-bot') useStore.getState().setModal(null);
      else backFromWork();
      assert.equal(f.location.hash, '#bots');
    }
  });
}

test('group chat origin is used only for an actual room conversation', () => {
  for (const [origin, expected] of [['#bot/room', 'Back to group chat'], ['#bot/fixture', 'Back to chat'], ['#new-bot/group', 'Back to new group chat'], ['#tasks', 'Back to Tasks']]) {
    reset(origin); const destination = f.location.hash;
    go('#settings/general'); label(expected);
    navigation.initialize({ kind: 'bots' }); label(expected);
    useConfigUI.getState().closeAppSettings(); assert.equal(f.location.hash, destination);
  }
});

test('work Back labels name the previous tab instead of skipping all work screens', () => {
  reset(); go('#tasks');
  for (const tab of ['Team', 'Goals', 'Reports']) {
    const previous = f.location.hash;
    go(`#${tab.toLowerCase()}`);
    label(`Back to ${parseScreen(previous)!.kind === 'work' ? (parseScreen(previous) as Extract<Screen, {kind:'work'}>).route.tab : 'Bots'}`);
  }
  for (const tab of ['Goals', 'Team', 'Tasks']) {
    label(`Back to ${tab}`); backFromWork(); assert.equal(f.location.hash, `#${tab.toLowerCase()}`);
  }
});

test('search direct entry, restored overlay and close share a route and title', () => {
  reset('#search'); assert.equal(useStore.getState().modal, 'search'); assert.equal(document.title, 'Search · Swarm');
  useStore.getState().setModal(null); assert.equal(f.location.hash, '#bots'); assert.equal(document.title, 'Bots · Swarm');
  for (const origin of ['#tasks', '#settings/apps', '#new-bot', '#bot/fixture']) {
    reset(origin); const destination = f.location.hash;
    go('#search'); navigation.initialize({ kind: 'bots' });
    assert.equal(useStore.getState().modal, 'search'); assert.equal(document.title, 'Search · Swarm');
    useStore.getState().setModal(null); assert.equal(f.location.hash, destination);
    assert.equal(document.title, screenTitle(parseScreen(destination)!, bots, true));
  }
});

test('every route title is named and section titles update synchronously', () => {
  reset('#reports');
  for (const section of APP_SECTIONS) {
    go(`#settings/${section}`);
    assert.equal(document.title, `Settings · ${SETTINGS_LABELS[section]} · Swarm`);
  }
  for (const [hash, title] of [['#bots', 'Bots'], ['#bot/fixture', 'Fixture Bot'], ['#new-bot', 'Create a Bot'], ['#new-bot/group', 'New group chat'], ['#search', 'Search'], ['#apps/connect', 'Connect apps'], ['#tasks', 'Tasks'], ['#team', 'Team'], ['#goals', 'Goals'], ['#reports', 'Reports']]) {
    go(hash); assert.equal(document.title, `${title} · Swarm`);
  }
  assert.equal(backLabel({kind:'group'}), 'Back to new group chat');
});

test('Bots reached as a top-level destination returns to its real previous screen', () => {
  reset('#reports'); go('#bots'); label('Back to Reports');
  navigation.initialize({ kind: 'bots' }); label('Back to Reports');
  backFromSurface(); assert.equal(f.location.hash, '#reports');
});

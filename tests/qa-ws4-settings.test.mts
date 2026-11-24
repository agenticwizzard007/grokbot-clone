// WS4 QA fixes: settings hash sync, details default preference, goal status labels and small settings helpers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserHistory } from './fixtures/browser-history.mts';

// Minimal browser globals so the web stores load under node (no DOM, no network).
const storage = new Map<string, string>();
const memoryStorage = {
  getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
  setItem: (k: string, v: string) => { storage.set(k, String(v)); },
  removeItem: (k: string) => { storage.delete(k); },
  clear: () => storage.clear(),
  key: (i: number) => [...storage.keys()][i] ?? null,
  get length() { return storage.size; },
};
const fixture = browserHistory('#settings/keys');
const { location, history, urls, window } = fixture;
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'Linux x86_64' }, configurable: true });
Object.assign(globalThis, {
  history,
  window,
  document: { documentElement: { dataset: {}, style: {} }, visibilityState: 'visible' },
});
globalThis.fetch = (async () => Response.json({ generation: 1, rows: [], routines: [] })) as typeof fetch;

const { useConfigUI, openConversation, botSettingsHash, navigation } = await import('../web/src/configStore.ts');
const { useStore } = await import('../web/src/store.ts');
const { readDetailsDefault, writeDetailsDefault, detailsDefaultKey } = await import('../web/src/lib/detailsDefault.ts');
const logic = await import('../web/src/components/config/settingsLogic.ts');

test('a hash deep link opens its section on load', () => {
  assert.equal(useConfigUI.getState().appSettings, 'keys');
});

test('picking a settings section updates the hash; reload would reopen it; closing clears it', () => {
  useConfigUI.getState().openAppSettings('permissions');
  assert.equal(location.hash, '#settings/permissions');
  assert.equal(useConfigUI.getState().appSettings, 'permissions');
  useConfigUI.getState().openAppSettings('computer');
  assert.equal(location.hash, '#settings/computer');
  const writes = urls.length;
  useConfigUI.getState().openAppSettings('computer');
  assert.equal(urls.length, writes, 'no redundant history writes for the same section');
  useConfigUI.getState().closeAppSettings();
  assert.equal(location.hash, '#bots');
  assert.equal(useConfigUI.getState().appSettings, null);
});

test('R4: opening Settings without a section names General in the hash', () => {
  useConfigUI.getState().openAppSettings();
  assert.equal(location.hash, '#settings/general');
  assert.equal(useConfigUI.getState().appSettings, 'general');
  assert.equal(useConfigUI.getState().appSettingsHome, false);
  useConfigUI.getState().closeAppSettings();
});

test('details default is stored per account and drives detailsOpen on bot switch', () => {
  const user = (id: string) => ({ id, email: `${id}@example.test`, name: id, avatarUrl: null });
  assert.equal(readDetailsDefault('account-a'), false);
  writeDetailsDefault('account-a', true);
  assert.equal(storage.get(detailsDefaultKey('account-a')), '1');
  assert.equal(readDetailsDefault('account-b'), false, 'another account is unaffected');
  useStore.setState({ user: user('account-a'), mobile: false, bots: [1,2,3,4].map(n => ({id:`bot-${n}`,name:`Bot ${n}`})) as never, botsLoaded: true, transcripts: {}, detailsOpen: false });
  useStore.getState().selectBot('bot-1');
  assert.equal(useStore.getState().detailsOpen, true);
  // Closing the panel from a chat never writes the preference.
  useStore.getState().set({ detailsOpen: false });
  assert.equal(readDetailsDefault('account-a'), true);
  useStore.getState().selectBot('bot-2');
  assert.equal(useStore.getState().detailsOpen, true);
  writeDetailsDefault('account-a', false);
  useStore.getState().selectBot('bot-3');
  assert.equal(useStore.getState().detailsOpen, false);
  // Phones never open details automatically.
  writeDetailsDefault('account-a', true);
  useStore.setState({ mobile: true });
  useStore.getState().selectBot('bot-4');
  assert.equal(useStore.getState().detailsOpen, false);
  useStore.setState({ user: null, mobile: false, selectedBotId: null, detailsOpen: false });
});

test('goal status label is consistent and delete is only offered for finished goals', () => {
  assert.equal(logic.goalStatusLabel({ status: 'active', turnsUsed: 0 }), 'Not started');
  assert.equal(logic.goalStatusLabel({ status: 'active', turnsUsed: 2 }), 'In progress');
  assert.equal(logic.goalStatusLabel({ status: 'cancelled', turnsUsed: 2 }), 'Stopped');
  assert.equal(logic.goalStatusLabel({ status: 'completed', turnsUsed: 2 }), 'Completed');
  assert.equal(logic.goalStatusLabel({ status: 'paused', turnsUsed: 0 }), 'Paused');
  assert.equal(logic.goalDeletable({ status: 'cancelled', turnsUsed: 0 }), true);
  assert.equal(logic.goalDeletable({ status: 'completed', turnsUsed: 0 }), true);
  assert.equal(logic.goalDeletable({ status: 'active', turnsUsed: 0 }), false);
});

test('Mac detection: macOS browsers yes, iPhone and Linux no', () => {
  assert.equal(logic.isMacPlatform({ platform: 'MacIntel', userAgent: '' }), true);
  assert.equal(logic.isMacPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), true);
  assert.equal(logic.isMacPlatform({ platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' }), false);
  assert.equal(logic.isMacPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), false);
  assert.equal(logic.isMacPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }), false);
});

test('hide suggestion is scoped to the account', () => {
  assert.notEqual(logic.hideSuggestedKey('account-a'), logic.hideSuggestedKey('account-b'));
  assert.equal(logic.hideSuggestedKey('account-a'), 'swarm.account-a.hideSuggested');
});

test('needs-you items are scoped per Bot, deduplicated and oldest first', () => {
  const item = (id: string, botId: string, createdAt: number, type: 'approval' | 'question' | 'setup_review' | 'connect' = 'approval') => ({ id, type, botId, botName: botId, title: id, createdAt, seq: null });
  const items = [item('b', 'coordinator', 20), item('a', 'worker', 10, 'setup_review'), item('b', 'coordinator', 20), item('c', 'coordinator', 5, 'question')];
  assert.deepEqual(logic.scopeNeedsYou(items).map(i => i.id), ['c', 'a', 'b']);
  assert.deepEqual(logic.scopeNeedsYou(items, 'coordinator').map(i => i.id), ['c', 'b']);
  assert.deepEqual(logic.scopeNeedsYou(null), []);
  assert.equal(logic.needsYouChip('setup_review'), 'Setup review');
});

test('time zone options always include UTC and the saved zone', () => {
  const zones = logic.timeZoneOptions('Asia/Dubai');
  assert.ok(zones.includes('UTC'));
  assert.ok(zones.includes('Asia/Dubai'));
  assert.ok(logic.timeZoneOptions('Mars/Base').includes('Mars/Base'));
});

// Settings tabs now share the same history model on every viewport.
test('Bot settings tabs push and app Settings returns to its origin', () => {
  useStore.setState({ bots: [{ id: 'coordinator', name: 'Coordinator Bot' }, { id: 'worker', name: 'Worker Bot' }] as never, botsLoaded: true });
  fixture.reset('#bots'); navigation.initialize({ kind: 'bots' });
  const pushes = history.pushes;
  for (const tab of ['general', 'skills', 'routines'] as const) {
    useConfigUI.getState().openBotSettings('coordinator', tab);
    assert.equal(location.hash, botSettingsHash('coordinator', tab));
  }
  useConfigUI.getState().openAppSettings('general');
  assert.equal(location.hash, '#settings/general'); assert.equal(useConfigUI.getState().botSettings, null);
  useConfigUI.getState().closeAppSettings();
  assert.equal(location.hash, botSettingsHash('coordinator', 'routines'));
  useConfigUI.getState().closeBotSettings();
  assert.equal(location.hash, '#bots'); assert.equal(useConfigUI.getState().botSettings, null);
  assert.equal(history.pushes, pushes + 4);
});

test('R4: either settings entry point closes the other surface and updates the hash', () => {
  const ui = () => useConfigUI.getState();
  for (const section of [undefined, 'subscriptions'] as const) {
    ui().openAppSettings(section, 'codex');
    ui().openBotSettings('coordinator', 'skills');
    assert.equal(ui().appSettings, null);
    assert.equal(ui().appSettingsHome, false);
    assert.equal(ui().subscriptionProvider, null);
    assert.deepEqual(ui().botSettings, { botId: 'coordinator', tab: 'skills' });
    assert.equal(location.hash, botSettingsHash('coordinator', 'skills'));
    ui().openAppSettings(section, 'codex');
    assert.equal(ui().botSettings, null);
    assert.equal(ui().appSettings, section ?? 'general');
    assert.equal(location.hash, `#settings/${section ?? 'general'}`);
  }
  ui().closeAppSettings();
});

test('R4: switching to app Settings protects Bot drafts and keeps the visible route', () => {
  const ui = () => useConfigUI.getState();
  ui().openBotSettings('coordinator');
  ui().setBotSettingsDraft('general', 'General');
  ui().openAppSettings();
  assert.equal(ui().appSettings, null);
  assert.equal(location.hash, botSettingsHash('coordinator', 'general'));
  assert.ok(ui().botSettingsLeave);
  ui().resolveLeaveBotSettings(false);
  assert.equal(ui().botSettingsDirty, true);
  assert.equal(ui().appSettings, null);
  // A section link changes the hash before requesting navigation.
  fixture.link('#settings/usage');
  assert.equal(location.hash, botSettingsHash('coordinator', 'general'));
  ui().resolveLeaveBotSettings(true);
  assert.equal(ui().botSettings, null);
  assert.deepEqual(ui().botSettingsDrafts, {});
  assert.equal(ui().botSettingsDirty, false);
  assert.equal(ui().appSettings, 'usage');
  assert.equal(location.hash, '#settings/usage');
  ui().closeAppSettings();
});

test('a Bot settings link reopens that tab on reload', () => {
  fixture.reset('#bot/worker/settings/memories'); navigation.reset();
  navigation.initialize({ kind: 'bots' });
  assert.deepEqual(useConfigUI.getState().botSettings, { botId: 'worker', tab: 'memories' });
  fixture.reset('#bot/worker/settings/bogus'); navigation.reset();
  navigation.initialize({ kind: 'bots' });
  assert.equal(useConfigUI.getState().botSettings, null, 'unknown tabs fall back safely');
});

// R2F-004: unsaved Bot settings drafts guard every way out.
test('leaving Bot settings with a draft waits for Discard; Cancel keeps the page', () => {
  const ui = () => useConfigUI.getState();
  useStore.setState({ user: { id: 'account-a', email: 'account-a@example.test', name: 'account-a', avatarUrl: null } as never, mobile: false, bots: [{id:'coordinator',name:'Coordinator Bot'},{id:'worker',name:'Worker Bot'}] as never, botsLoaded: true, transcripts: {} });
  ui().openBotSettings('coordinator');
  // Nothing changed: no question.
  ui().closeBotSettings();
  assert.equal(ui().botSettings, null);
  assert.equal(ui().botSettingsLeave, null);

  ui().openBotSettings('coordinator');
  ui().setBotSettingsDraft('general', 'General');
  assert.equal(ui().botSettingsDirty, true);
  ui().closeBotSettings();
  assert.deepEqual(ui().botSettings, { botId: 'coordinator', tab: 'general' }, 'close waits for an answer');
  assert.ok(ui().botSettingsLeave);
  ui().resolveLeaveBotSettings(false);
  assert.equal(ui().botSettingsLeave, null);
  assert.equal(ui().botSettingsDirty, true, 'Cancel keeps the draft');

  // Sidebar Bot rows, search results and Tasks cards all use openConversation.
  openConversation('worker');
  assert.notEqual(useStore.getState().selectedBotId, 'worker', 'no navigation before Discard');
  assert.ok(ui().botSettingsLeave);
  ui().resolveLeaveBotSettings(true);
  assert.equal(ui().botSettings, null);
  assert.equal(ui().botSettingsDirty, false);
  assert.equal(useStore.getState().selectedBotId, 'worker');

  // Another Bot's settings would drop the draft; tabs of the same Bot keep it.
  ui().openBotSettings('coordinator');
  ui().setBotSettingsDraft('skill:1', 'Skills');
  ui().openBotSettings('coordinator', 'memories');
  assert.ok(ui().botSettingsLeave, 'tab-local drafts ask before changing tabs');
  ui().resolveLeaveBotSettings(true);
  ui().setBotSettingsDraft('general', 'General');
  assert.equal(ui().botSettings?.tab, 'memories');
  ui().openBotSettings('worker');
  assert.equal(ui().botSettings?.botId, 'coordinator');
  ui().resolveLeaveBotSettings(true);
  assert.deepEqual(ui().botSettings, { botId: 'worker', tab: 'general' });
  ui().discardBotSettings();
  useStore.setState({ user: null, selectedBotId: null, detailsOpen: false });
  location.hash = '';
});

test('R2F-027: network failures read "Check your connection."', () => {
  assert.equal(logic.loadErrorText(new TypeError('Failed to fetch')), 'Check your connection.');
  assert.equal(logic.loadErrorText(new TypeError('NetworkError when attempting to fetch resource.')), 'Check your connection.');
  assert.equal(logic.loadErrorText(new TypeError('Load failed')), 'Check your connection.');
  assert.equal(logic.loadErrorText(new Error('Sign in again to continue.')), 'Sign in again to continue.');
});

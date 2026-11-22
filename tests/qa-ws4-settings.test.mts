// WS4 QA fixes: settings hash sync, details default preference, goal status labels and small settings helpers.
import assert from 'node:assert/strict';
import { test } from 'node:test';

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
const location = { hash: '#settings/keys', pathname: '/', search: '' };
const urls: string[] = [];
const history = {
  state: null as unknown,
  replaceState(state: unknown, _title: string, url: string) {
    this.state = state;
    urls.push(url);
    const [beforeHash, hash = ''] = url.split('#');
    location.hash = hash ? `#${hash}` : '';
    location.pathname = beforeHash.split('?')[0] || '/';
  },
  pushes: 0,
  pushState() { this.pushes += 1; },
};
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'Linux x86_64' }, configurable: true });
Object.assign(globalThis, {
  history,
  window: { location, history, addEventListener() {}, dispatchEvent() { return true; } },
  document: { documentElement: { dataset: {}, style: {} }, visibilityState: 'visible' },
});
globalThis.fetch = (async () => Response.json({ generation: 1, rows: [], routines: [] })) as typeof fetch;

const { useConfigUI, openConversation } = await import('../web/src/configStore.ts');
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
  assert.equal(location.hash, '');
  assert.equal(useConfigUI.getState().appSettings, null);
});

test('opening Settings without a section does not invent a hash', () => {
  useConfigUI.getState().openAppSettings();
  assert.equal(location.hash, '');
  assert.equal(useConfigUI.getState().appSettings, 'general');
  assert.equal(useConfigUI.getState().appSettingsHome, true);
  useConfigUI.getState().closeAppSettings();
});

test('details default is stored per account and drives detailsOpen on bot switch', () => {
  const user = (id: string) => ({ id, email: `${id}@example.test`, name: id, avatarUrl: null });
  assert.equal(readDetailsDefault('alice'), false);
  writeDetailsDefault('alice', true);
  assert.equal(storage.get(detailsDefaultKey('alice')), '1');
  assert.equal(readDetailsDefault('bob'), false, 'another account is unaffected');
  useStore.setState({ user: user('alice'), mobile: false, bots: [], transcripts: {}, detailsOpen: false });
  useStore.getState().selectBot('bot-1');
  assert.equal(useStore.getState().detailsOpen, true);
  // Closing the panel from a chat never writes the preference.
  useStore.getState().set({ detailsOpen: false });
  assert.equal(readDetailsDefault('alice'), true);
  useStore.getState().selectBot('bot-2');
  assert.equal(useStore.getState().detailsOpen, true);
  writeDetailsDefault('alice', false);
  useStore.getState().selectBot('bot-3');
  assert.equal(useStore.getState().detailsOpen, false);
  // Phones never open details automatically.
  writeDetailsDefault('alice', true);
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
  assert.notEqual(logic.hideSuggestedKey('alice'), logic.hideSuggestedKey('bob'));
  assert.equal(logic.hideSuggestedKey('alice'), 'swarm.alice.hideSuggested');
});

test('needs-you items are scoped per Bot, deduplicated and oldest first', () => {
  const item = (id: string, botId: string, createdAt: number, type: 'approval' | 'question' | 'setup_review' | 'connect' = 'approval') => ({ id, type, botId, botName: botId, title: id, createdAt, seq: null });
  const items = [item('b', 'quinn', 20), item('a', 'nia', 10, 'setup_review'), item('b', 'quinn', 20), item('c', 'quinn', 5, 'question')];
  assert.deepEqual(logic.scopeNeedsYou(items).map(i => i.id), ['c', 'a', 'b']);
  assert.deepEqual(logic.scopeNeedsYou(items, 'quinn').map(i => i.id), ['c', 'b']);
  assert.deepEqual(logic.scopeNeedsYou(null), []);
  assert.equal(logic.needsYouChip('setup_review'), 'Setup review');
});

test('time zone options always include UTC and the saved zone', () => {
  const zones = logic.timeZoneOptions('Asia/Dubai');
  assert.ok(zones.includes('UTC'));
  assert.ok(zones.includes('Asia/Dubai'));
  assert.ok(logic.timeZoneOptions('Mars/Base').includes('Mars/Base'));
});

// R2F-028: Bot settings deep links (PD-R2-07 option A, hash sync only).
test('Bot settings tabs are linkable with replaceState and one history entry per visit', () => {
  const pushes = history.pushes;
  useConfigUI.getState().openBotSettings('quinn');
  assert.equal(location.hash, '#bot/quinn/settings/general');
  useConfigUI.getState().openBotSettings('quinn', 'skills');
  assert.equal(location.hash, '#bot/quinn/settings/skills');
  useConfigUI.getState().openBotSettings('quinn', 'routines');
  assert.equal(location.hash, '#bot/quinn/settings/routines');
  // Settings opened on top names its section; closing it names the Bot settings page again.
  useConfigUI.getState().openAppSettings('general');
  assert.equal(location.hash, '#settings/general', 'General is linkable');
  useConfigUI.getState().closeAppSettings();
  assert.equal(location.hash, '#bot/quinn/settings/routines');
  useConfigUI.getState().closeBotSettings();
  assert.equal(location.hash, '');
  assert.equal(useConfigUI.getState().botSettings, null);
  assert.equal(history.pushes, pushes, 'tab and section changes never add history entries');
});

test('a Bot settings link reopens that tab on reload', async () => {
  location.hash = '#bot/nia/settings/memories';
  const fresh = await import('../web/src/configStore.ts?reload=bot-settings');
  assert.deepEqual(fresh.useConfigUI.getState().botSettings, { botId: 'nia', tab: 'memories' });
  location.hash = '#bot/nia/settings/bogus';
  const invalid = await import('../web/src/configStore.ts?reload=bot-settings-invalid');
  assert.equal(invalid.useConfigUI.getState().botSettings, null, 'unknown tabs are ignored');
  location.hash = '';
});

// R2F-004: unsaved Bot settings drafts guard every way out.
test('leaving Bot settings with a draft waits for Discard; Cancel keeps the page', () => {
  const ui = () => useConfigUI.getState();
  useStore.setState({ user: { id: 'alice', email: 'alice@example.test', name: 'alice', avatarUrl: null } as never, mobile: false, bots: [], transcripts: {} });
  ui().openBotSettings('quinn');
  // Nothing changed: no question.
  ui().closeBotSettings();
  assert.equal(ui().botSettings, null);
  assert.equal(ui().botSettingsLeave, null);

  ui().openBotSettings('quinn');
  ui().setBotSettingsDraft('general', 'General');
  assert.equal(ui().botSettingsDirty, true);
  ui().closeBotSettings();
  assert.deepEqual(ui().botSettings, { botId: 'quinn', tab: 'general' }, 'close waits for an answer');
  assert.ok(ui().botSettingsLeave);
  ui().resolveLeaveBotSettings(false);
  assert.equal(ui().botSettingsLeave, null);
  assert.equal(ui().botSettingsDirty, true, 'Cancel keeps the draft');

  // Sidebar Bot rows, search results and Tasks cards all use openConversation.
  openConversation('nia');
  assert.notEqual(useStore.getState().selectedBotId, 'nia', 'no navigation before Discard');
  assert.ok(ui().botSettingsLeave);
  ui().resolveLeaveBotSettings(true);
  assert.equal(ui().botSettings, null);
  assert.equal(ui().botSettingsDirty, false);
  assert.equal(useStore.getState().selectedBotId, 'nia');

  // Another Bot's settings would drop the draft; tabs of the same Bot keep it.
  ui().openBotSettings('quinn');
  ui().setBotSettingsDraft('skill:1', 'Skills');
  ui().openBotSettings('quinn', 'memories');
  assert.equal(ui().botSettings?.tab, 'memories');
  ui().openBotSettings('nia');
  assert.equal(ui().botSettings?.botId, 'quinn');
  ui().resolveLeaveBotSettings(true);
  assert.deepEqual(ui().botSettings, { botId: 'nia', tab: 'general' });
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

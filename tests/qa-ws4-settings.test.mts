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
  pushState() { /* not used here */ },
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

const { useConfigUI } = await import('../web/src/configStore.ts');
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

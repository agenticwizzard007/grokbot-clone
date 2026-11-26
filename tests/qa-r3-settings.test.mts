// R3 settings regressions. No server, database or external requests.
// Gate: node --import tsx --test tests/qa-r3-settings.test.mts
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { browserHistory } from './fixtures/browser-history.mts';
import type { ComputerState } from '../server/src/types.ts';

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
  key: (index: number) => [...values.keys()][index] ?? null,
  get length() { return values.size; },
};
const fixture = browserHistory('#settings');
const { location, history, entries, window } = fixture;
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: storage, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { platform: 'Linux x86_64', userAgent: 'node' }, configurable: true });
Object.assign(globalThis, {
  history,
  window,
  document: { title: 'Swarm', documentElement: { dataset: {}, style: {} } },
});
const { useStore } = await import('../web/src/store.ts');
const { useConfigUI, botSettingsHash, hasSettingsLink, navigation } = await import('../web/src/configStore.ts');
const { computerStatusText, computerReadiness, computerStatusLine } = await import('../web/src/components/config/computerStatus.tsx');
const { setupResourceText } = await import('../web/src/components/config/setupResources.ts');
const user = { id: 'settings-account', email: 'settings@example.test', name: 'Account', avatarUrl: null };
const computer = (status: ComputerState['status'], provider: ComputerState['provider'] = 'cloudvm'): ComputerState => ({ status, provider, screens: [], orgoId: null, error: null });
const ui = () => useConfigUI.getState();
const initialSettings = ui().appSettings;

beforeEach(() => {
  fixture.reset('#bots'); navigation.reset();
  useConfigUI.setState({ botSettings: null, botSettingsDrafts: {}, botSettingsDirty: false, botSettingsLeave: null, appSettings: null, view: 'chat' });
  useStore.setState({ bots: [{ id: 'settings-bot', name: 'Coordinator Bot' }] as never, user, mobile: false, mobilePane: 'list', selectedBotId: 'settings-bot', detailsOpen: false, computer: null, botsLoaded: true });
  navigation.initialize({ kind: 'bots' });
});

test('R3-091: phone settings and each tab push, close returns to the list', () => {
  useStore.setState({ mobile: true });
  ui().openBotSettings('settings-bot');
  assert.equal(useStore.getState().mobilePane, 'chat');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].hash, '#bots');
  ui().openBotSettings('settings-bot', 'learning');
  assert.equal(entries.length, 3);
  assert.equal(location.hash, botSettingsHash('settings-bot', 'learning'));
  assert.ok(!location.hash.includes('settings-bot'));
  ui().closeBotSettings();
  assert.equal(ui().botSettings, null);
  assert.equal(useStore.getState().mobilePane, 'list');
  assert.equal(location.hash, '#bots');
  assert.equal(history.index, 0);
  history.go(1);
  assert.equal(location.hash, botSettingsHash('settings-bot', 'general'));
});

test('R3-091: a reloaded direct settings link uses a safe chat parent', () => {
  useStore.setState({ mobile: true });
  fixture.reset('#bot/settings-bot/settings/memories');
  navigation.initialize({ kind: 'bots' });
  ui().closeBotSettings();
  assert.match(location.hash, /^#bot\/coordinator-bot~/);
  assert.ok(!location.hash.includes('/settings'));
  assert.equal(entries.length, 1, 'direct entry never traverses outside the app');
  assert.equal(useStore.getState().mobilePane, 'chat');
});

test('R3-091: draft cancellation stays in settings and Discard returns to the list', () => {
  useStore.setState({ mobile: true });
  ui().openBotSettings('settings-bot'); ui().setBotSettingsDraft('general', 'General');
  ui().closeBotSettings();
  assert.ok(ui().botSettingsLeave);
  assert.equal(useStore.getState().mobilePane, 'chat');
  ui().resolveLeaveBotSettings(false);
  assert.ok(ui().botSettings); assert.equal(ui().botSettingsDirty, true);
  ui().closeBotSettings(); ui().resolveLeaveBotSettings(true);
  assert.equal(ui().botSettings, null); assert.equal(ui().botSettingsDirty, false);
  assert.equal(ui().view, 'bots'); assert.equal(useStore.getState().mobilePane, 'list');
  assert.equal(useStore.getState().detailsOpen, false);
});

test('R3-091: desktop close restores the current chat and details', () => {
  useStore.getState().selectBot('settings-bot');
  useStore.getState().set({ detailsOpen: true });
  ui().setDetailsTab('configuration');
  const pushes = history.pushes;
  ui().setDetailsTab('configuration', 'responsibilities');
  assert.equal(history.pushes, pushes, 'reselecting the default Setup tab does not push');
  const origin = location.hash;
  ui().openBotSettings('settings-bot'); ui().closeBotSettings();
  assert.equal(location.hash, origin);
  assert.equal(useStore.getState().mobilePane, 'chat');
  assert.equal(useStore.getState().detailsOpen, true);
});

test('R3-091: Forward to an existing settings entry does not push again', () => {
  useStore.setState({ mobile: true });
  ui().openBotSettings('settings-bot');
  history.back(); const pushes = history.pushes; history.go(1);
  assert.equal(history.pushes, pushes); assert.equal(entries.length, 2);
  assert.equal(useStore.getState().mobilePane, 'chat');
  assert.equal(location.hash, botSettingsHash('settings-bot', 'general'));
});

test('R3-044: every shared status surface uses the same live readiness words', () => {
  const expected: Record<ComputerState['status'], string> = {
    absent: 'Asleep', stopped: 'Asleep', suspended: 'Asleep', running: 'Awake',
    creating: 'Starting the computer', starting: 'Starting the computer', resuming: 'Starting the computer',
    suspending: 'Going to sleep…', error: 'Unreachable',
  };
  for (const [status, label] of Object.entries(expected)) {
    const cloud = computer(status as ComputerState['status']);
    assert.equal(computerStatusText(cloud), label);
    assert.equal(computerReadiness(cloud), label);
    assert.equal(computerStatusLine(cloud), `Computer: ${label}`);
    const local = computer(status as ComputerState['status'], 'local');
    assert.equal(computerReadiness(local), status === 'running' ? 'Connected' : 'Not connected');
    assert.equal(computerStatusLine(local), `Computer: ${computerStatusText(local)}`);
  }
  assert.equal(computerStatusLine(null), 'Computer: Checking status…');
});

test('R3-044: a delayed Awake snapshot cannot overwrite a newer Asleep live event', async () => {
  let release!: (response: Response) => void;
  const original = globalThis.fetch;
  globalThis.fetch = () => new Promise<Response>(resolve => { release = resolve; });
  try {
    const pending = useStore.getState().loadComputer();
    const asleep = computer('suspended');
    useStore.getState().handleEvent({ type: 'computer', state: asleep });
    release(Response.json({ computer: computer('running') }));
    await pending;
    assert.equal(useStore.getState().computer, asleep);
    assert.equal(computerStatusLine(useStore.getState().computer), 'Computer: Asleep');
  } finally { globalThis.fetch = original; }
});

test('R3-044: only the latest computer read for the same account may publish', async () => {
  const releases: ((response: Response) => void)[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = () => new Promise<Response>(resolve => { releases.push(resolve); });
  try {
    const older = useStore.getState().loadComputer();
    const newer = useStore.getState().loadComputer();
    releases[1](Response.json({ computer: computer('suspended') })); await newer;
    releases[0](Response.json({ computer: computer('running') })); await older;
    assert.equal(useStore.getState().computer?.status, 'suspended');
    const departing = useStore.getState().loadComputer();
    useStore.setState({ user: { ...user, id: 'other-account' }, computer: null });
    releases[2](Response.json({ computer: computer('running') })); await departing;
    assert.equal(useStore.getState().computer, null);
  } finally { globalThis.fetch = original; }
});

test('R3-041: resources preserve display names and access limits without connection metadata jargon', () => {
  assert.equal(setupResourceText("User's private Slack account connected account, toolkit slack, revision 1, status EXPIRED"), "User's private Slack account needs to be reconnected");
  assert.equal(setupResourceText('toolkit googlecalendar, revision 3, status ACTIVE'), 'Google Calendar connected');
  assert.equal(setupResourceText('Files at https://example.test/notes, read only'), 'Files at https://example.test/notes, read only');
  assert.equal(setupResourceText('Slack account'), 'Slack account');
  assert.equal(setupResourceText('toolkit slack, revision 4, status FUTURE_CODE'), 'Slack, Check connection');
  assert.doesNotMatch(setupResourceText('Slack (toolkit slack, revision 2, status REVOKED)'), /toolkit|revision|REVOKED/);
});


test('bare settings deep link opens General on fresh load and existing section links still resolve', () => {
  assert.equal(initialSettings, 'general');
  for (const hash of ['#settings', '#settings/', '#settings/general', '#settings/apps', '#settings/account', '#settings/messaging', '#settings/keys', '#settings/api-keys', '#settings/unknown', '#whatsapp']) {
    location.hash = hash; assert.equal(hasSettingsLink(), true, hash);
  }
  fixture.link('#settings');
  const pushes = history.pushes;
  ui().openAppSettings('general');
  assert.equal(history.pushes, pushes, 'bare desktop Settings already shows General');
  assert.equal(location.hash, '#settings/general');
});

test('account cleanup clears Details directly without navigating through private history', () => {
  useStore.getState().selectBot('settings-bot');
  useStore.getState().set({ detailsOpen: true });
  const pushes = history.pushes;
  useStore.getState().set({ user: null, selectedBotId: null, detailsOpen: false, modal: null });
  assert.equal(useStore.getState().detailsOpen, false);
  assert.equal(useStore.getState().modal, null);
  assert.equal(history.pushes, pushes);
});

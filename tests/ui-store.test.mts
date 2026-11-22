import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Bot } from '../shared/types.js';
import { useStore } from '../web/src/store.js';
import { displayExchangeText, INTERNAL_ID_PATTERN, stripInternalIds } from '../web/src/lib/stripInternalIds.js';

test('R2F-002: visible text never shows connected-account, request, approval or Bot ids', () => {
  const botName = (id: string) => (id === 'bot_Nia0123456ab' ? 'Nia' : undefined);
  const cases: [string, string][] = [
    ['Slack account ca_KIxihCKrE-D2xyz and Gmail account ca_pESfPrEqcgnN', 'Slack account and Gmail account'],
    ['Post with ca_KIxihCKrE-D2 today', 'Post with the connected account today'],
    ['Follow up on request req_11ev-EvIvCvn.', 'Follow up on request.'],
    ['Waiting on apr_Zk3mQ9xLp2 now', 'Waiting on an approval now'],
    ['Gmail (ca_pESfPrEqcgnN) inbox', 'Gmail inbox'],
    ['Ask bot_Nia0123456ab for sources', 'Ask Nia for sources'],
    ['Ask bot_Unknown12345 for sources', 'Ask a Bot for sources'],
    ['careful_thing and cards stay as written', 'careful_thing and cards stay as written'],
  ];
  for (const [input, expected] of cases) {
    const output = stripInternalIds(input, { botName });
    assert.equal(output, expected);
    assert.doesNotMatch(output, INTERNAL_ID_PATTERN);
  }
  const shown = displayExchangeText('[Internal result for request req_11evEvIvCvnX; execution finished; acceptance still requires evidence]\nHere is the summary.');
  assert.deepEqual(shown, { text: 'Here is the summary.', result: true });
  assert.deepEqual(displayExchangeText('Plain request text'), { text: 'Plain request text', result: false });
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; useStore.setState({ user: null, bots: [], live: {}, selectedBotId: null }); });

test('a roster refresh from a departed account cannot publish bots or change selection', async () => {
  const user = (id: string) => ({ id, email: `${id}@example.test`, name: id, avatarUrl: null });
  const bobBot = { id: 'bob-bot', generation: 1 } as Bot;
  useStore.setState({ user: user('alice') });
  let release!: () => void;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
    return Response.json({ bots: [{ id: 'alice-bot', generation: 1 }], live: [] });
  };
  const pending = useStore.getState().loadBots();
  useStore.setState({ user: user('bob'), bots: [bobBot], selectedBotId: bobBot.id });
  release();
  await pending;
  assert.deepEqual(useStore.getState().bots, [bobBot]);
  assert.equal(useStore.getState().selectedBotId, bobBot.id);
  assert.equal(calls, 1, 'a dropped roster cannot trigger transcript/routine reads');
  useStore.setState({ user: null });
  await useStore.getState().loadBots();
  assert.equal(calls, 1, 'signed-out refresh does not dispatch');
});

test('R2F-015: the chat restored after a reload opens details when "Open Bot details with each chat" is on', async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { localStorage: g.localStorage, location: g.location, history: g.history };
  const storage = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, String(v)); }, removeItem: (k: string) => { storage.delete(k); }, key: () => null, length: 0, clear: () => storage.clear() };
  g.location = { search: '', pathname: '/', hash: '' };
  g.history = { state: null, pushState() {}, replaceState() {}, back() {} };
  const user = { id: 'restore-user', email: 'restore@example.test', name: 'Restore', avatarUrl: null };
  const bot = { id: 'restored-bot', generation: 1, unread: 0 } as Bot;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/api/bots')) return Response.json({ bots: [bot], live: [] });
    if (url.endsWith('/rows')) return Response.json({ generation: 1, rows: [] });
    if (url.endsWith('/routines')) return Response.json({ routines: [] });
    return Response.json({});
  };
  try {
    const load = async (detailsDefault: '1' | '0', mobile = false) => {
      storage.set(`swarm.${user.id}.detailsDefault`, detailsDefault);
      useStore.setState({ user, bots: [], botsLoaded: false, transcripts: {}, selectedBotId: bot.id, detailsOpen: false, mobile, mobilePane: 'list' });
      await useStore.getState().loadBots();
      return useStore.getState();
    };
    const on = await load('1');
    assert.equal(on.selectedBotId, bot.id);
    assert.equal(on.detailsOpen, true, 'restored chat opens details');
    assert.equal(on.mobilePane, 'list', 'restoring does not navigate');
    assert.equal((await load('0')).detailsOpen, false, 'setting off keeps details closed');
    assert.equal((await load('1', true)).detailsOpen, false, 'never on phones');
    // A later roster refresh (SSE resync) does not reopen details the user closed.
    useStore.setState({ detailsOpen: false, mobile: false });
    await useStore.getState().loadBots();
    assert.equal(useStore.getState().detailsOpen, false, 'only the first load after a reload applies the default');
  } finally {
    Object.assign(g, saved);
    useStore.setState({ botsLoaded: false, transcripts: {}, detailsOpen: false, mobile: false });
  }
});

// Pure web logic from the QA master fix (WS3): effort cycle, shortcuts, SSE watchdog, rows fallback,
// signed-in history entry, queued phrase and the shared toast store. No network, no browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Effort } from '../server/src/types.js';
import { effortCycleOrder, nextEffort } from '../web/src/lib/effortCycle.js';
import { SHORTCUTS, isNewBotShortcut, shortcutKeys, shortcutLabel } from '../web/src/lib/shortcuts.js';
import { createSseWatchdog, expectRowsAfterSend, noteRowsEvent, SSE_STALE_MS, ROWS_FALLBACK_MS } from '../web/src/lib/sseWatchdog.js';
import { consumeSignedInRedirect } from '../web/src/lib/signedIn.js';
import { queuedPhrase } from '../web/src/lib/queued.js';
import { currentToast, dismissToast, toast } from '../web/src/lib/toast.js';

test('effort cycles weakest to strongest and wraps (MF-030)', () => {
  const api: Effort[] = ['ultracode', 'max', 'xhigh', 'high', 'medium', 'low', 'none'];
  assert.deepEqual(effortCycleOrder(api), ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
  const seen: Effort[] = [];
  let current: Effort = 'medium';
  for (let i = 0; i < 6; i++) { current = nextEffort(api, current)!; seen.push(current); }
  assert.deepEqual(seen, ['high', 'xhigh', 'max', 'ultracode', 'low', 'medium']);
  assert.equal(nextEffort(api, null), 'low', 'an unknown current starts at the weakest');
  assert.equal(nextEffort([], 'medium'), null);
  assert.equal(nextEffort(['high', 'medium', 'low'], 'high'), 'low', 'plan models without Ultracode wrap from the top');
});

test('shortcut glyphs follow the platform and every handled shortcut is listed (MF-029)', () => {
  const details = SHORTCUTS.find(s => s.id === 'details')!;
  assert.equal(shortcutLabel(details, true), '⇧⌘,');
  assert.equal(shortcutLabel(details, false), 'Ctrl+Shift+,');
  assert.deepEqual(shortcutKeys(SHORTCUTS.find(s => s.id === 'new-bot')!, false), ['Alt', 'Shift', 'N']);
  assert.equal(shortcutLabel('new-bot', true), '⌥⇧N');
  for (const s of SHORTCUTS) assert.ok(!shortcutLabel(s, false).includes('⌘'), `${s.id} has no Mac glyph off Mac`);
  for (const id of ['search', 'settings', 'new-bot', 'focus', 'sidebar', 'details', 'effort', 'fast']) assert.ok(SHORTCUTS.some(s => s.id === id), `${id} listed`);
  const key = (p: Partial<KeyboardEvent>) => ({ altKey: false, shiftKey: false, metaKey: false, ctrlKey: false, code: '', key: '', ...p });
  assert.equal(isNewBotShortcut(key({ altKey: true, shiftKey: true, code: 'KeyN', key: '˜' })), true, 'Option changes key on Mac; code still matches');
  assert.equal(isNewBotShortcut(key({ ctrlKey: true, code: 'KeyN', key: 'n' })), false, 'browsers reserve Ctrl+N');
  assert.equal(isNewBotShortcut(key({ altKey: true, code: 'KeyN', key: 'n' })), false);
});

test('SSE watchdog reconnects after 45 s without any event, pings included (MF-011)', () => {
  let now = 0;
  let tick: (() => void) | undefined;
  const clock = { now: () => now, setInterval: (fn: () => void) => { tick = fn; return 1; }, clearInterval: () => { tick = undefined; } };
  let stale = 0;
  const dog = createSseWatchdog(() => { stale++; }, { clock });
  dog.start();
  for (const at of [20_000, 40_000, 60_000]) { now = at; dog.beat(); tick!(); } // pings every 20 s keep it quiet
  assert.equal(stale, 0);
  now = 60_000 + SSE_STALE_MS - 1; tick!();
  assert.equal(stale, 0, 'just under 45 s is still healthy');
  now = 60_000 + SSE_STALE_MS; tick!();
  assert.equal(stale, 1, 'silence for 45 s forces one reconnect');
  now += 1_000; tick!();
  assert.equal(stale, 1, 'one reconnect per stale window');
  now += SSE_STALE_MS; tick!();
  assert.equal(stale, 2);
  dog.stop();
  assert.equal(tick, undefined);
});

test('a send reloads rows once only when no rows event arrives within 10 s (MF-011)', () => {
  const timers: { fn: () => void; ms: number }[] = [];
  const setTimer = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; };
  let reloads = 0;
  expectRowsAfterSend('quiet-bot', () => { reloads++; }, { since: 1_000, setTimer });
  assert.equal(timers[0].ms, ROWS_FALLBACK_MS);
  timers[0].fn();
  assert.equal(reloads, 1);

  expectRowsAfterSend('busy-bot', () => { reloads++; }, { since: 2_000, setTimer });
  noteRowsEvent('busy-bot', 2_000); // the echo of the user's own row can land before the POST resolves
  timers[1].fn();
  assert.equal(reloads, 1, 'a rows event for that Bot cancels the fallback');

  noteRowsEvent('other-bot', 5_000);
  expectRowsAfterSend('third-bot', () => { reloads++; }, { since: 4_000, setTimer });
  timers[2].fn();
  assert.equal(reloads, 2, 'rows for another Bot do not count');
});

test('?signed_in=1 is stripped and one in-app history entry is pushed (MF-022)', () => {
  const calls: [string, unknown, string][] = [];
  const hist = { state: null, replaceState: (s: unknown, _t: string, url?: string | URL | null) => { calls.push(['replace', s, String(url)]); }, pushState: (s: unknown, _t: string, url?: string | URL | null) => { calls.push(['push', s, String(url)]); } };
  assert.equal(consumeSignedInRedirect({ pathname: '/', search: '?signed_in=1', hash: '' }, hist), true);
  assert.deepEqual(calls.map(c => [c[0], c[2]]), [['replace', '/'], ['push', '/']]);
  calls.length = 0;
  assert.equal(consumeSignedInRedirect({ pathname: '/', search: '?signed_in=1&screen=b1', hash: '#settings/keys' }, hist), true);
  assert.deepEqual(calls.map(c => c[2]), ['/?screen=b1#settings/keys', '/?screen=b1#settings/keys'], 'other parameters survive');
  calls.length = 0;
  assert.equal(consumeSignedInRedirect({ pathname: '/', search: '', hash: '' }, hist), false);
  assert.equal(calls.length, 0, 'normal boots leave history alone');
});

test('queued live state reads "Queued behind <name>" or "Starting..." (MF-011)', () => {
  assert.equal(queuedPhrase('Quinn'), 'Queued behind Quinn');
  assert.equal(queuedPhrase('  '), 'Starting...');
  assert.equal(queuedPhrase(undefined), 'Starting...');
});

test('toast keeps one current message with a tone and can be dismissed (MF-052)', () => {
  toast('Started a new conversation');
  assert.deepEqual({ ...currentToast(), id: 0 }, { id: 0, message: 'Started a new conversation', tone: 'info' });
  toast('Could not sign out', { tone: 'error' });
  assert.equal(currentToast()?.tone, 'error');
  assert.equal(currentToast()?.message, 'Could not sign out');
  toast('   ');
  assert.equal(currentToast()?.message, 'Could not sign out', 'blank messages are ignored');
  dismissToast();
  assert.equal(currentToast(), null);
});

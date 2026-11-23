import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { acknowledgeSubmission, beginSubmission, pendingSubmission } from '../web/src/lib/chatSubmission.js';

const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
  else Reflect.deleteProperty(globalThis, 'sessionStorage');
});
function storage() {
  const values = new Map<string, string>();
  const fixture = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: fixture });
  return fixture;
}

test('P-02: uncertain sends retain their ID, edits get a new ID, and late receipts preserve new drafts', () => {
  storage();
  const original = beginSubmission('account:bot', 'Original text');
  assert.deepEqual(pendingSubmission('account:bot'), original);
  assert.deepEqual(beginSubmission('account:bot', 'Original text'), original);
  const edited = beginSubmission('account:bot', 'Edited text');
  assert.notEqual(edited.id, original.id);
  acknowledgeSubmission('account:bot', original.id);
  assert.deepEqual(pendingSubmission('account:bot'), edited);
  acknowledgeSubmission('account:bot', edited.id);
  assert.equal(pendingSubmission('account:bot'), null);
  assert.notEqual(beginSubmission('account:bot', 'Edited text').id, edited.id);
});

test('P-02: pending sends cannot cross account, Bot or tab boundaries', () => {
  storage();
  const first = beginSubmission('account:bot', 'Same text');
  const otherBot = beginSubmission('account:other-bot', 'Same text');
  const otherAccount = beginSubmission('other-account:bot', 'Same text');
  assert.equal(new Set([first.id, otherBot.id, otherAccount.id]).size, 3);
  // A separate tab has its own storage, so accepting its draft cannot erase this tab's retry ID.
  const firstTab = globalThis.sessionStorage;
  storage();
  const otherTab = beginSubmission('account:bot', 'Same text');
  assert.notEqual(otherTab.id, first.id);
  acknowledgeSubmission('account:bot', otherTab.id);
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: firstTab });
  assert.deepEqual(beginSubmission('account:bot', 'Same text'), first);
});

test('P-02: unavailable retry storage prevents submission before any network work', () => {
  const fixture = storage();
  fixture.setItem = () => { throw new Error('Storage unavailable'); };
  assert.throws(() => beginSubmission('account:bot', 'Do work'), /Unable to save this message for retry/);
  assert.equal(pendingSubmission('account:bot'), null);
});

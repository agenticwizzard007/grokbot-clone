import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cliApi } from '../web/src/lib/cliApi.js';
import { useStore } from '../web/src/store.js';

const originalFetch = globalThis.fetch;
const account = (id: string | null) => useStore.setState({ user: id ? { id, email: `${id}@example.test`, name: id, avatarUrl: null } : null });
afterEach(() => { globalThis.fetch = originalFetch; account(null); });

test('CLI browser calls require a rendered account without contacting a server', async () => {
  account(null);
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  await assert.rejects(cliApi.pair(), { status: 401, code: 'unauthenticated' });
  await assert.rejects(cliApi.status(), { status: 401, code: 'unauthenticated' });
  assert.equal(calls, 0);
});

test('CLI account intent preserves terminal cursor and encodes the initiating identity', async () => {
  account('account/a+b');
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input), 'https://fixture.invalid');
    assert.equal(url.pathname, '/api/cli/login/terminal');
    assert.equal(url.searchParams.get('cursor'), '7');
    assert.equal(url.searchParams.get('expectedUserId'), 'account/a+b');
    assert.equal(options?.credentials, 'include');
    return Response.json({ id: 'terminal', output: 'owned output' });
  };
  assert.equal((await cliApi.login('terminal', 7)).output, 'owned output');
});

for (const status of [200, 401]) {
  test(`CLI rejects account changes while consuming a ${status} response body`, async () => {
    account('alice');
    let release!: () => void;
    let bodyStarted!: () => void;
    const started = new Promise<void>(resolve => { bodyStarted = resolve; });
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify(status === 200 ? { command: 'private fixture command' } : { error: 'Old account error', code: 'reauth_required' }))); controller.close(); };
      },
      pull() { bodyStarted(); },
    }), { status, headers: { 'content-type': 'application/json' } });
    const result = cliApi.pair();
    const rejected = assert.rejects(result, { status: 409, code: 'account_changed' });
    await started;
    // Response headers and body have separate lifetimes in a real browser.
    await new Promise(resolve => setImmediate(resolve));
    account('bob');
    release();
    await rejected;
  });
}

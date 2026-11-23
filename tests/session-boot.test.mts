import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useStore } from '../web/src/store.js';
import { expireSession } from '../web/src/lib/session.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  useStore.setState(useStore.getInitialState(), true);
});

for (const failure of ['server', 'network', 'invalid-json', 'missing-user', 'invalid-user']) {
  test(`A-03: ${failure} failure stays distinct from a signed-out session`, async () => {
    globalThis.fetch = async () => {
      if (failure === 'network') throw new TypeError('Failed to fetch');
      if (failure === 'invalid-json') return new Response('<html>Unavailable</html>');
      if (failure === 'missing-user') return Response.json({});
      if (failure === 'invalid-user') return Response.json({ user: false });
      return Response.json({ error: 'Internal diagnostic detail' }, { status: 500 });
    };
    await useStore.getState().checkAuth();
    const state = useStore.getState();
    assert.equal(state.authChecked, false);
    assert.equal(state.authChecking, false);
    assert.equal(state.user, null);
    assert.match(state.authError!, /check your session/i);
    assert.doesNotMatch(state.authError!, /Internal diagnostic detail/);
  });
}

test('A-03: retry is single-flight, retains the error while pending, and restores the session', async () => {
  const user = { id: 'session-test', email: 'session@example.test', name: 'Test account', avatarUrl: null };
  useStore.setState({ user, authChecked: true });
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await useStore.getState().checkAuth();
  assert.equal(useStore.getState().user, user, 'a failed lookup does not clear a known user');
  assert.equal(useStore.getState().authChecked, false, 'a stale user does not count as a verified session');
  const error = useStore.getState().authError;
  let release!: (response: Response) => void;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Promise<Response>(resolve => { release = resolve; }); };
  const pending = useStore.getState().checkAuth();
  await useStore.getState().checkAuth();
  assert.equal(calls, 1);
  assert.equal(useStore.getState().authChecking, true);
  assert.equal(useStore.getState().authError, error);
  release(Response.json({ user, devLogin: true, googleLogin: false, appleLogin: true, appleLinked: true, googleLinked: true }));
  await pending;
  const state = useStore.getState();
  assert.deepEqual(state.user, user);
  assert.equal(state.authError, null);
  assert.equal(state.authChecking, false);
  assert.equal(state.devLogin, true);
  assert.equal(state.googleLogin, false);
  assert.equal(state.appleLogin, true);
  assert.equal(state.appleLinked, true);
  assert.equal(state.googleLinked, true);
});

test('A-03: a confirmed signed-out response clears the error and restores sign-in options', async () => {
  globalThis.fetch = async () => Response.json({ error: 'Unavailable' }, { status: 503 });
  await useStore.getState().checkAuth();
  assert.ok(useStore.getState().authError);
  globalThis.fetch = async () => Response.json({ user: null, devLogin: true, googleLogin: false, appleLogin: true });
  await useStore.getState().checkAuth();
  const state = useStore.getState();
  assert.equal(state.user, null);
  assert.equal(state.authError, null);
  assert.equal(state.authChecked, true);
  assert.equal(state.authChecking, false);
  assert.equal(state.devLogin, true);
  assert.equal(state.googleLogin, false);
  assert.equal(state.appleLogin, true);
});

test('P-09: a never-settling boot request reaches retry at five seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  };
  const pending = useStore.getState().checkAuth();
  assert.ok(signal, 'the session request receives a cancellation signal');
  t.mock.timers.tick(4999);
  assert.equal(useStore.getState().authChecking, true);
  assert.equal(useStore.getState().authError, null);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(useStore.getState().authChecking, false);
  assert.equal(useStore.getState().authChecked, false);
  assert.match(useStore.getState().authError!, /check your session/i);

  globalThis.fetch = async () => Response.json({ user: null, devLogin: true });
  await useStore.getState().checkAuth();
  assert.equal(useStore.getState().authChecked, true);
  assert.equal(useStore.getState().authError, null);
});

for (const stage of ['fetch', 'body']) {
  for (const outcome of ['resolve', 'reject']) {
    for (const retryState of ['pending', 'successful']) {
      test(`P-09: late ${stage} ${outcome} cannot overwrite a ${retryState} retry`, async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        let resolveOld!: (value: Response | { user: null; devLogin: boolean }) => void;
        let rejectOld!: (reason: Error) => void;
        const old = new Promise<Response | { user: null; devLogin: boolean }>((resolve, reject) => { resolveOld = resolve; rejectOld = reject; });
        globalThis.fetch = async () => stage === 'fetch' ? old as Promise<Response> : ({ ok: true, json: () => old } as Response);
        const pending = useStore.getState().checkAuth();
        await Promise.resolve();
        t.mock.timers.tick(5000);
        await pending;
        const error = useStore.getState().authError;
        assert.ok(error);

        let releaseRetry!: (response: Response) => void;
        let retrySignal: AbortSignal | undefined;
        globalThis.fetch = async (_input, init) => {
          retrySignal = init?.signal ?? undefined;
          return new Promise<Response>(resolve => { releaseRetry = resolve; });
        };
        const retry = useStore.getState().checkAuth();
        if (retryState === 'successful') {
          releaseRetry(Response.json({ user: null, devLogin: true }));
          await retry;
        }
        if (outcome === 'reject') rejectOld(new Error('Late request failure'));
        else resolveOld(stage === 'fetch' ? Response.json({ user: null, devLogin: false }) : { user: null, devLogin: false });
        await new Promise<void>(resolve => setImmediate(resolve));
        if (retryState === 'pending') {
          assert.equal(useStore.getState().authChecking, true);
          assert.equal(useStore.getState().authError, error);
          assert.equal(useStore.getState().authChecked, false);
          releaseRetry(Response.json({ user: null, devLogin: true }));
          await retry;
        }
        t.mock.timers.tick(5000);
        assert.equal(retrySignal?.aborted, false, 'success clears its deadline');
        assert.equal(useStore.getState().authChecking, false);
        assert.equal(useStore.getState().authChecked, true);
        assert.equal(useStore.getState().authError, null);
        assert.equal(useStore.getState().devLogin, true);
      });
    }
  }
}

// Expiry is terminal for the document, so this race must run last.
test('A-03: a delayed boot lookup cannot replace confirmed session expiry with an error', async () => {
  const user = { id: 'session-test', email: 'session@example.test', name: 'Test account', avatarUrl: null };
  useStore.setState({ user, authChecked: true });
  let release!: (response: Response) => void;
  globalThis.fetch = async () => new Promise<Response>(resolve => { release = resolve; });
  const globals = globalThis as Record<string, unknown>;
  const originalWindow = globals.window;
  const redirects: string[] = [];
  globals.window = { location: { replace: (url: string) => redirects.push(url) } };
  try {
    const pending = useStore.getState().checkAuth();
    expireSession(user.id);
    release(Response.json({ user }));
    await pending;
    const state = useStore.getState();
    assert.deepEqual(redirects, ['/']);
    assert.equal(state.user, null);
    assert.equal(state.authChecked, true);
    assert.equal(state.authError, null);
    assert.equal(state.authChecking, false);
  } finally {
    if (originalWindow === undefined) delete globals.window;
    else globals.window = originalWindow;
  }
});

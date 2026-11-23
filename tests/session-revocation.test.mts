import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { useStore } from '../web/src/store.js';
import { api, needsReauth } from '../web/src/lib/api.js';
import { accessApi, verifyAccessAccount } from '../web/src/lib/accessApi.js';
import { revalidateSession } from '../web/src/lib/session.js';
import { startEvents } from '../web/src/lib/events.js';

const originalFetch = globalThis.fetch;
const globals = globalThis as Record<string, unknown>;
const original = { window: globals.window, localStorage: globals.localStorage, document: globals.document, EventSource: globals.EventSource };
const user = { id: 'session-fixture', email: 'session@example.test', name: 'Session fixture', avatarUrl: null };
let redirects: string[], removed: string[];
function signedIn() {
  redirects = []; removed = [];
  globals.window = Object.assign(new EventTarget(), { location: { replace: (url: string) => redirects.push(url) } });
  globals.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  globals.localStorage = { removeItem: (key: string) => removed.push(key) };
  useStore.setState({ ...useStore.getInitialState(), user, authChecked: true, selectedBotId: 'private-bot',
    bots: [{ id: 'private-bot', generation: 1 }] as any, botsLoaded: true,
    transcripts: { 'private-bot': { generation: 1, bySeq: { 1: { body: { text: 'Private fixture' } } as any }, loaded: true } },
    live: { 'private-bot': {} as any }, routines: { 'private-bot': [{} as any] }, computer: {} as any,
    modal: 'search', viewerOpen: true, viewerControl: true, detailsOpen: true, sseConnected: true,
  });
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(globals, original);
  useStore.setState(useStore.getInitialState(), true);
});

test('network, server and malformed responses do not sign out a valid session', async () => {
  signedIn();
  for (const response of [new Error('offline'), new DOMException('timeout', 'TimeoutError'), new Response('', { status: 503 }), Response.json({}), Response.json({ user })]) {
    globalThis.fetch = async () => { if (response instanceof Error) throw response; return response; };
    assert.equal(await revalidateSession(), true);
    assert.equal(useStore.getState().user, user);
    assert.deepEqual(redirects, []);
  }
});

test('concurrent failures share one session probe; a changed account ignores its old result', async () => {
  signedIn();
  let release!: (value: Response) => void, calls = 0;
  globalThis.fetch = async () => { calls++; return new Promise<Response>(resolve => { release = resolve; }); };
  const first = revalidateSession(), second = revalidateSession();
  assert.equal(first, second);
  useStore.setState({ user: { ...user, id: 'next-session-fixture' } });
  release(Response.json({ user: null }));
  assert.equal(await first, true);
  assert.equal(calls, 1);
  assert.deepEqual(redirects, []);
});

test('API and account-session 401s verify the browser session; reauth_required preserves the shell', async () => {
  for (const request of [() => api.bots(), () => accessApi.sessions()]) {
    signedIn();
    const paths: string[] = [];
    globalThis.fetch = async input => {
      paths.push(String(input));
      return String(input) === '/api/auth/me' ? Response.json({ user }) : Response.json({ error: 'Provider authorization failed' }, { status: 401 });
    };
    await assert.rejects(request());
    await revalidateSession();
    assert.ok(paths.includes('/api/auth/me'));
    assert.equal(useStore.getState().user, user);
    assert.deepEqual(redirects, []);

    paths.length = 0;
    globalThis.fetch = async input => {
      paths.push(String(input));
      return Response.json({ error: 'Sign in again', code: 'reauth_required' }, { status: 401 });
    };
    await assert.rejects(request(), needsReauth);
    assert.equal(paths.length, 1);
    assert.equal(useStore.getState().user, user);
    assert.deepEqual(redirects, []);
  }
});

test('Account preflight for a departed account cannot sign out the current account', async () => {
  signedIn();
  globalThis.fetch = async () => Response.json({ user: null });
  await assert.rejects(verifyAccessAccount('departed-account'));
  assert.deepEqual(redirects, []);
  assert.equal(useStore.getState().user, user);
});

// Expiry is terminal for a document, so exercise it last without a test-only reset API.
test('confirmed expiry clears private UI and rejects delayed responses and stream events while navigation waits', async () => {
  signedIn();
  const releases: { path: string; release: () => void }[] = [];
  let authReads = 0, calls = 0, source: any;
  globals.EventSource = class {
    constructor() { source = this; }
    close() {}
  };
  globalThis.fetch = async input => {
    calls++;
    const path = String(input);
    const missing = path === '/api/auth/me' && ++authReads === 2;
    const body = path.endsWith('/rows') ? { generation: 1, rows: [] }
      : path.endsWith('/routines') ? { routines: [{ id: 'private-routine' }] }
      : path.endsWith('/sessions') ? { sessions: [{ id: 'private-session' }] }
      : path.endsWith('/bots') ? { bots: [{ id: 'private-bot' }], live: [] }
      : { user: missing ? null : user };
    // Hold bodies to control both sides of the API/store promise-continuation boundary.
    return { ok: true, status: 200, json: () => new Promise(resolve => releases.push({ path: missing ? 'expiry' : path, release: () => resolve(body) })) } as Response;
  };
  const stop = startEvents();
  try {
    const pending = [useStore.getState().loadRows('private-bot'), useStore.getState().loadRoutines('private-bot'), api.bots(), accessApi.sessions()];
    const checkingAuth = useStore.getState().checkAuth();
    const results = Promise.allSettled(pending);
    const expiry = revalidateSession();
    await Promise.resolve();
    assert.equal(releases.length, 6);
    // These bodies pass the API guard, then expiry wins before the store continuations.
    releases.find(item => item.path.endsWith('/routines'))!.release();
    releases.find(item => item.path === '/api/auth/me')!.release();
    releases.find(item => item.path === 'expiry')!.release();
    assert.equal(await expiry, false);
    const readsAtExpiry = calls;
    assert.deepEqual(redirects, ['/']);
    assert.deepEqual(removed, ['swarm.selectedBot']);
    for (const { release } of releases) release();
    const settled = await results;
    for (const index of [0, 2, 3]) assert.equal(settled[index].status, 'rejected');
    await checkingAuth;
    source.onopen();
    source.onmessage({ data: JSON.stringify({ type: 'bot', bot: { id: 'late-private-bot' } }) });
    await source.onerror();
    assert.equal(await revalidateSession(), false);
    await assert.rejects(api.bots(), /session has ended/);
    assert.equal(calls, readsAtExpiry, 'expired document never dispatches again');
    const state = useStore.getState();
    for (const field of ['user', 'selectedBotId', 'computer', 'modal'] as const) assert.equal(state[field], null);
    assert.deepEqual(state.bots, []);
    for (const field of ['transcripts', 'live', 'routines'] as const) assert.deepEqual(state[field], {});
    for (const field of ['botsLoaded', 'viewerOpen', 'viewerControl', 'detailsOpen', 'sseConnected'] as const) assert.equal(state[field], false);
    assert.deepEqual(redirects, ['/']);
  } finally { stop(); }
});

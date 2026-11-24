import assert from 'node:assert/strict';
import { after, test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Real call controller, audio lifecycle and HTTP client. Only browser devices and transport are fake.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'voice-connect-'));
const bundle = await build({ entryPoints: ['web/src/voice/call.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'store', setup(b) {
    b.onResolve({ filter: /^\.\.\/store$/ }, () => ({ path: 'store', namespace: 'fake' }));
    b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'export const useStore = { getState: () => ({ user: null, bots: [] }) };' }));
  } }],
});
const file = path.join(tmp, 'call.mjs'); writeFileSync(file, bundle.outputFiles[0].text);
after(() => rmSync(tmp, { recursive: true, force: true }));
const voice: typeof import('../web/src/voice/call.js') = await import(pathToFileURL(file).href);
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const deferred = () => { let resolve!: (value?: any) => void; const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve }; };

function fixture(t: TestContext, stage = '') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stopped = 0, sources = 0, micRequests = 0;
  const pending = deferred(), sockets: Socket[] = [], requests: { url: string; signal?: AbortSignal }[] = [];
  const track = { enabled: true, readyState: 'live', stop: () => { stopped++; track.readyState = 'ended'; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Node { gain = { value: 0 }; fftSize = 512; port = { onmessage: null }; connect() { return this; } disconnect() {} getFloatTimeDomainData() {} }
  class Context {
    state = stage === 'audio' ? 'suspended' : 'running'; currentTime = 0; destination = new Node();
    audioWorklet = { addModule: () => stage === 'worklet' ? pending.promise : Promise.resolve() };
    constructor() { if (stage === 'constructor') throw new Error('Unsupported audio'); }
    createGain() { return new Node(); } createAnalyser() { return new Node(); }
    createMediaStreamSource() { sources++; return new Node(); }
    resume() { return stage === 'audio' ? pending.promise : Promise.resolve(); }
    async close() { this.state = 'closed'; }
  }
  class Socket {
    static OPEN = 1; readyState = 1;
    onopen?: () => void; onmessage?: (m: { data: string }) => void; onclose?: (e: object) => void; onerror?: () => void;
    sent: any[] = [];
    constructor() { sockets.push(this); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
    ready() { this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'session.updated' }) }); }
  }
  t.after(() => voice.endCall());
  for (const [key, value] of Object.entries({ window: { AudioContext: Context, addEventListener() {}, removeEventListener() {} },
    navigator: { userAgent: 'test', mediaDevices: { getUserMedia: () => { micRequests++; return stage === 'microphone' ? pending.promise : ['denied', 'device', 'busy'].includes(stage) ? Promise.reject(new DOMException('fixture', stage === 'denied' ? 'NotAllowedError' : stage === 'device' ? 'NotFoundError' : 'NotReadableError')) : Promise.resolve(stream); } } },
    AudioWorkletNode: Node, WebSocket: Socket,
  })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
  }
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push({ url, signal: init.signal as AbortSignal });
    if (url.endsWith('/session')) {
      if (stage === 'session') return pending.promise;
      if (stage === 'token') return Response.json({ error: 'Voice session token was rejected. Check voice settings and retry.' }, { status: 502 });
      return Response.json({ callId: 'fixture', clientSecret: 'fake', websocketUrl: 'ws://localhost/fixture', session: {} });
    }
    return Response.json(url.endsWith('/updates') ? { cursor: 0, updates: [], tasks: [] } : { ok: true });
  });
  return { pending, sockets, requests, stream, stopped: () => stopped, sources: () => sources, micRequests: () => micRequests, track };
}

test('S-02: realtime handshake reaches live, clears deadline, and can end', async t => {
  const f = fixture(t); voice.startCall('fixture'); await settle();
  assert.equal(voice.useVoice.getState().status, 'connecting');
  f.sockets[0].ready(); await settle();
  t.mock.timers.tick(10001); await settle();
  assert.equal(voice.useVoice.getState().status, 'live');
  assert.ok(f.sockets[0].sent.some(e => e.type === 'response.create'));
  voice.endCall(); assert.equal(f.stopped(), 1); assert.equal(voice.useVoice.getState().status, 'idle');
});
for (const stage of ['audio', 'worklet', 'session', 'socket']) {
  test(`S-02: stalled ${stage} leaves connecting with a persistent actionable error`, async t => {
    const f = fixture(t, stage); voice.startCall('fixture'); await settle();
    t.mock.timers.tick(10001); await settle();
    assert.equal(voice.useVoice.getState().status, 'error');
    assert.match(voice.useVoice.getState().error!, /retry|Tap the voice button/i);
    t.mock.timers.tick(60001); await settle();
    assert.equal(voice.useVoice.getState().status, 'error');
    if (stage === 'session') assert.equal(f.requests.find(r => r.url.endsWith('/session'))!.signal?.aborted, true);
    // Late completions cannot revive the call or reconnect audio capture.
    f.pending.resolve(stage === 'session' ? Response.json({ callId: 'late' }) : undefined);
    await settle();
    assert.equal(voice.useVoice.getState().status, 'error');
    assert.equal(f.stopped(), 0, 'retain granted stream for retry');
    assert.equal(f.track.enabled, false);
    voice.endCall(); assert.equal(f.stopped(), 1);
    if (stage === 'worklet') assert.equal(f.sources(), 0);
  });
}
for (const stage of ['denied', 'token', 'constructor']) {
  test(`S-02: ${stage} failure is visible and can retry`, async t => {
    fixture(t, stage); voice.startCall('fixture'); await settle();
    assert.equal(voice.useVoice.getState().status, 'error');
    assert.match(voice.useVoice.getState().error!, /microphone|token|audio/i);
    voice.startCall('fixture'); await settle(); assert.equal(voice.useVoice.getState().status, 'error');
  });
}
test('S-02: socket errors fail immediately, and a retry connects', async t => {
  const f = fixture(t); voice.startCall('fixture'); await settle();
  f.sockets[0].onerror?.(); assert.equal(f.stopped(), 0); assert.equal(voice.useVoice.getState().status, 'error');
  voice.startCall('fixture'); await settle(); f.sockets[1].ready();
  assert.equal(voice.useVoice.getState().status, 'live');
  assert.equal(f.micRequests(), 1, 'Retry reuses the granted stream');
  assert.equal(f.track.enabled, true);
  f.sockets[0].ready(); assert.equal(voice.useVoice.getState().status, 'live');
});


test('permission prompt time is excluded and setup expires exactly 10s after permission', async t => {
  const f = fixture(t, 'microphone'); voice.startCall('fixture'); await settle();
  t.mock.timers.tick(120000); await settle();
  assert.equal(voice.useVoice.getState().status, 'connecting');
  assert.equal(voice.useVoice.getState().waitingForMic, true);
  assert.equal(f.requests.length, 0);
  f.pending.resolve(f.stream); await settle();
  assert.equal(voice.useVoice.getState().waitingForMic, false);
  t.mock.timers.tick(9999); await settle();
  assert.equal(voice.useVoice.getState().status, 'connecting');
  t.mock.timers.tick(1); await settle();
  assert.equal(voice.useVoice.getState().status, 'error');
  assert.match(voice.useVoice.getState().error!, /timed out.*voice connection/);
});

test('ending while permission is pending releases a late grant', async t => {
  const f = fixture(t, 'microphone'); voice.startCall('fixture'); await settle();
  voice.endCall(); f.pending.resolve(f.stream); await settle();
  assert.equal(f.stopped(), 1);
  assert.equal(voice.useVoice.getState().status, 'idle');
  assert.equal(f.requests.length, 0);
});

for (const [stage, message] of [
  ['denied', /permission was denied.*site settings.*allow Microphone/i],
  ['device', /microphone device found/i], ['busy', /microphone device.*other apps/i],
  ['token', /session token.*server.*token was rejected/i],
  ['worklet', /microphone device/i], ['session', /session token.*server/i],
] as const) {
  test(`setup error identifies the failed ${stage} step`, async t => {
    fixture(t, stage); voice.startCall('fixture'); await settle();
    t.mock.timers.tick(10000); await settle();
    assert.match(voice.useVoice.getState().error!, message);
  });
}

test('provider rejection is identified as a voice server error', async t => {
  const f = fixture(t); voice.startCall('fixture'); await settle();
  f.sockets[0].onmessage?.({ data: JSON.stringify({ type: 'error', error: { message: 'Server unavailable' } }) });
  assert.match(voice.useVoice.getState().error!, /Voice server error: Server unavailable/);
});

test('Retry reacquires only when the retained microphone track ended', async t => {
  const f = fixture(t); voice.startCall('fixture'); await settle();
  f.sockets[0].onerror?.(); f.track.readyState = 'ended';
  voice.startCall('fixture'); await settle();
  assert.equal(f.micRequests(), 2);
});

test('the setup deadline does not restart after audio worklet setup', async t => {
  const f = fixture(t, 'worklet'); voice.startCall('fixture'); await settle();
  t.mock.timers.tick(8000); f.pending.resolve(); await settle();
  assert.equal(f.sockets.length, 1);
  t.mock.timers.tick(1999); await settle(); assert.equal(voice.useVoice.getState().status, 'connecting');
  t.mock.timers.tick(1); await settle(); assert.equal(voice.useVoice.getState().status, 'error');
});

test('a delayed handshake cannot beat an expired monotonic deadline', async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const f = fixture(t); voice.startCall('fixture'); await settle();
  now = 10000; f.sockets[0].ready();
  assert.equal(voice.useVoice.getState().status, 'error');
  assert.match(voice.useVoice.getState().error!, /timed out.*voice connection/);
});

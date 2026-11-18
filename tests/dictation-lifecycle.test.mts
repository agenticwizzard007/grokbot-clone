// node --import tsx --test tests/dictation-lifecycle.test.mts
// Exercise the real React hook and STT HTTP client in Chrome; all browser media and fetch are fake.
import assert from 'node:assert/strict';
import { after, before, test, type TestContext } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';

const bundle = await build({
  stdin: { resolveDir: process.cwd(), loader: 'js', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { useDictation } from './web/src/voice/dictation';
    const deferred = () => {
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      return { promise, resolve, reject };
    };
    const mics = [], streams = [], recorders = [], requests = [], events = [], timers = new Map();
    const realSetTimeout = window.setTimeout.bind(window), realClearTimeout = window.clearTimeout.bind(window);
    let now = 1000, nextTimer = -1, failStage, root, hook;
    Date.now = () => now;
    window.setTimeout = (fn, delay, ...args) => {
      if (delay !== 120000) return realSetTimeout(fn, delay, ...args);
      const id = nextTimer--;
      timers.set(id, fn);
      return id;
    };
    window.clearTimeout = id => { timers.delete(id); realClearTimeout(id); };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: () => { const mic = deferred(); mics.push(mic); return mic.promise; },
    } });
    class FakeRecorder {
      static isTypeSupported = () => true;
      state = 'inactive'; mimeType = 'audio/webm';
      onstop = null; ondataavailable = null; onerror = null;
      constructor() {
        if (failStage === 'constructor') { failStage = undefined; throw new Error('constructor failed'); }
        recorders.push(this);
      }
      start() {
        if (failStage === 'start') { failStage = undefined; throw new Error('start failed'); }
        this.state = 'recording';
      }
      stop() {
        if (failStage === 'stop') { failStage = undefined; throw new Error('stop failed'); }
        this.state = 'inactive';
      }
    }
    window.MediaRecorder = FakeRecorder;
    window.fetch = (url, init) => {
      if (url !== '/api/voice/stt') throw new Error('Unexpected network request: ' + url);
      const request = { ...deferred(), init };
      requests.push(request);
      // Deliberately ignore abort: stale-result guards must work even if a transport completes late.
      return request.promise;
    };
    let props = { contextKey: 'a:1', enabled: true, language: 'en', callback: 'initial' };
    function Harness() {
      const { callback, language, ...options } = props;
      hook = useDictation(text => events.push(['text', callback, text]), error => events.push(['error', callback, error]), language, options);
      return null;
    }
    const render = () => flushSync(() => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness))));
    const settle = async () => { await new Promise(resolve => realSetTimeout(resolve, 0)); flushSync(() => {}); };
    root = createRoot(document.getElementById('root'));
    render();
    window.h = {
      update(next) { props = { ...props, ...next }; render(); },
      start() { flushSync(() => { void hook.start(); }); },
      stop() { flushSync(() => hook.stop()); },
      cancel() { flushSync(() => hook.cancel()); },
      escape() { flushSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))); },
      unmount() { flushSync(() => root.unmount()); },
      async grant(index = mics.length - 1) {
        const tracks = [{ stops: 0, stop() { this.stops++; } }, { stops: 0, stop() { this.stops++; } }];
        const stream = { getTracks: () => tracks };
        streams[index] = tracks;
        mics[index].resolve(stream);
        await settle();
      },
      async deny(index = mics.length - 1) { mics[index].reject(new DOMException('denied', 'NotAllowedError')); await settle(); },
      async finish(index = recorders.length - 1, data = true) {
        now += 500;
        const recorder = recorders[index];
        if (data) recorder.ondataavailable?.({ data: new Blob(['recorded audio']) });
        void recorder.onstop?.();
        await settle();
      },
      async reply(index = requests.length - 1, text = 'dictated text') {
        requests[index].resolve(Response.json({ text })); await settle();
      },
      async reject(index = requests.length - 1) { requests[index].reject(new Error('STT failed')); await settle(); },
      async maxDuration() { now += 120000; for (const fn of [...timers.values()]) fn(); await settle(); },
      fail(stage) { failStage = stage; },
      saveRecorderEvents() {
        const recorder = recorders[recorders.length - 1];
        this.recorderEvents = [recorder.ondataavailable, recorder.onstop, recorder.onerror];
      },
      async lateRecorderEvents() {
        this.recorderEvents[0]?.({ data: new Blob(['late audio']) });
        void this.recorderEvents[1]?.();
        this.recorderEvents[2]?.({ error: new Error('late recorder error') });
        await settle();
      },
      saveCallbacks() { this.callbacks = [hook.start, hook.stop, hook.cancel]; },
      snapshot() {
        return {
          state: hook.state, starting: hook.starting, events,
          microphones: mics.length, recorders: recorders.length,
          tracks: streams.map(tracks => tracks?.map(track => track.stops)),
          recorderStates: recorders.map(recorder => recorder.state), timers: timers.size,
          requests: requests.map(request => ({ aborted: request.init.signal.aborted, language: request.init.body.get('language'), file: request.init.body.get('file').name })),
          stableCallbacks: !this.callbacks || this.callbacks.every((fn, index) => fn === [hook.start, hook.stop, hook.cancel][index]),
        };
      },
    };
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false,
  define: { 'process.env.NODE_ENV': '"development"' },
});
let browser: Browser;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); });

async function fixture(t: TestContext) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], 'No unhandled browser errors');
  });
  const act = (method: string, ...args: unknown[]) => page.evaluate(async ({ method, args }) => {
    await (window as any).h[method](...args);
  }, { method, args });
  const snapshot = () => page.evaluate(() => (window as any).h.snapshot());
  const record = async () => { await act('start'); await act('grant'); };
  const transcribe = async () => { await record(); await act('stop'); await act('finish'); };
  return { act, snapshot, record, transcribe };
}

test('capture pins language and callbacks; start/stop/cancel stay stable across rerenders', async t => {
  const f = await fixture(t);
  await f.act('saveCallbacks');
  await f.act('start');
  assert.equal((await f.snapshot()).state, 'starting');
  assert.equal((await f.snapshot()).starting, true);
  await f.act('start');
  await f.act('update', { language: 'fr', callback: 'fresh' });
  await f.act('grant');
  assert.equal((await f.snapshot()).state, 'recording');
  await f.act('stop');
  assert.deepEqual((await f.snapshot()).tracks, [[1, 1]], 'Stop immediately releases every track');
  await f.act('finish');
  assert.equal((await f.snapshot()).state, 'transcribing');
  assert.deepEqual((await f.snapshot()).requests, [{ aborted: false, language: 'en', file: 'dictation.webm' }]);
  await f.act('reply');
  const result = await f.snapshot();
  assert.equal(result.state, 'idle');
  assert.equal(result.microphones, 1, 'Duplicate starts reuse the current capture');
  assert.equal(result.timers, 0);
  assert.equal(result.stableCallbacks, true);
  assert.deepEqual(result.events, [['text', 'initial', 'dictated text']]);
});

test('cancel during permission permits a new capture; a late stream cannot erase its state', async t => {
  const f = await fixture(t);
  await f.act('start');
  await f.act('cancel');
  await f.act('start');
  await f.act('grant', 1);
  await f.act('grant', 0);
  const result = await f.snapshot();
  assert.equal(result.state, 'recording');
  assert.equal(result.recorders, 1);
  assert.deepEqual(result.tracks, [[1, 1], [0, 0]]);
  assert.deepEqual(result.events, []);
  await f.act('cancel');
});

test('late permission rejection cannot report an error or clear a fresh capture', async t => {
  const f = await fixture(t);
  await f.act('start');
  await f.act('cancel');
  await f.record();
  await f.act('deny', 0);
  assert.equal((await f.snapshot()).state, 'recording');
  assert.deepEqual((await f.snapshot()).events, []);
  await f.act('cancel');
});

test('queued recorder events after cancellation cannot affect a newer capture', async t => {
  const f = await fixture(t);
  await f.record();
  await f.act('saveRecorderEvents');
  await f.act('cancel');
  await f.record();
  await f.act('lateRecorderEvents');
  const result = await f.snapshot();
  assert.equal(result.state, 'recording');
  assert.equal(result.timers, 1);
  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.tracks, [[1, 1], [0, 0]]);
  await f.act('cancel');
});

test('current transcription errors use the callback pinned at capture start', async t => {
  const f = await fixture(t);
  await f.transcribe();
  await f.act('update', { callback: 'fresh' });
  await f.act('reject');
  const result = await f.snapshot();
  assert.equal(result.state, 'idle');
  assert.deepEqual(result.events, [['error', 'initial', 'STT failed']]);
});

for (const outcome of ['reply', 'reject']) {
  test(`cancel aborts STT; old ${outcome} cannot insert, error, or clear a newer capture`, async t => {
    const f = await fixture(t);
    await f.transcribe();
    await f.act('cancel');
    assert.equal((await f.snapshot()).requests[0].aborted, true);
    await f.record();
    await f.act(outcome, 0);
    const result = await f.snapshot();
    assert.equal(result.state, 'recording');
    assert.equal(result.timers, 1);
    assert.deepEqual(result.events, []);
    await f.act('cancel');
  });
}

for (const phase of ['starting', 'recording', 'transcribing']) {
  test(`Escape cancels ${phase}`, async t => {
    const f = await fixture(t);
    if (phase === 'starting') await f.act('start');
    else if (phase === 'recording') await f.record();
    else await f.transcribe();
    await f.act('escape');
    assert.equal((await f.snapshot()).state, 'idle');
    if (phase === 'starting') await f.act('grant');
    if (phase === 'transcribing') await f.act('reply');
    const result = await f.snapshot();
    assert.deepEqual(result.tracks, [[1, 1]]);
    assert.equal(result.timers, 0);
    assert.deepEqual(result.events, []);
  });

  test(`chat and generation transitions invalidate ${phase}, including A -> B -> A`, async t => {
    const f = await fixture(t);
    if (phase === 'starting') await f.act('start');
    else if (phase === 'recording') await f.record();
    else await f.transcribe();
    await f.act('update', { contextKey: 'b:1' });
    await f.act('update', { contextKey: 'a:1' });
    await f.record();
    if (phase === 'starting') await f.act('grant', 0);
    if (phase === 'transcribing') await f.act('reply', 0);
    let result = await f.snapshot();
    assert.equal(result.state, 'recording');
    assert.deepEqual(result.events, []);
    await f.act('update', { contextKey: 'a:2' });
    result = await f.snapshot();
    assert.equal(result.state, 'idle');
    assert.equal(result.timers, 0);
    assert.ok(result.tracks.every((tracks: number[]) => tracks.every(count => count === 1)));
  });

  test(`global call disabling cancels ${phase} and prevents starts`, async t => {
    const f = await fixture(t);
    if (phase === 'starting') await f.act('start');
    else if (phase === 'recording') await f.record();
    else await f.transcribe();
    await f.act('update', { enabled: false });
    await f.act('start');
    assert.equal((await f.snapshot()).microphones, 1);
    assert.equal((await f.snapshot()).state, 'idle');
    await f.act('update', { enabled: true });
    await f.record();
    if (phase === 'starting') await f.act('grant', 0);
    if (phase === 'transcribing') await f.act('reply', 0);
    assert.equal((await f.snapshot()).state, 'recording');
    assert.deepEqual((await f.snapshot()).events, []);
    await f.act('cancel');
  });

  test(`unmount releases ${phase} and suppresses late work`, async t => {
    const f = await fixture(t);
    if (phase === 'starting') await f.act('start');
    else if (phase === 'recording') await f.record();
    else await f.transcribe();
    await f.act('unmount');
    if (phase === 'starting') await f.act('grant');
    if (phase === 'transcribing') await f.act('reject');
    const result = await f.snapshot();
    assert.deepEqual(result.tracks, [[1, 1]]);
    assert.equal(result.timers, 0);
    assert.deepEqual(result.events, []);
    if (phase === 'transcribing') assert.equal(result.requests[0].aborted, true);
  });
}

for (const stage of ['constructor', 'start', 'stop']) {
  test(`MediaRecorder ${stage} errors release streams and timers, allowing a retry`, async t => {
    const f = await fixture(t);
    await f.act('fail', stage);
    await f.record();
    if (stage === 'stop') await f.act('stop');
    const result = await f.snapshot();
    assert.equal(result.state, 'idle');
    assert.deepEqual(result.tracks, [[1, 1]]);
    assert.equal(result.timers, 0);
    assert.deepEqual(result.events, [['error', 'initial', `${stage} failed`]]);
    await f.record();
    assert.equal((await f.snapshot()).state, 'recording');
    await f.act('cancel');
  });
}

test('maximum recording duration stops capture and releases tracks before transcription', async t => {
  const f = await fixture(t);
  await f.record();
  await f.act('maxDuration');
  assert.deepEqual((await f.snapshot()).tracks, [[1, 1]]);
  assert.deepEqual((await f.snapshot()).recorderStates, ['inactive']);
  await f.act('finish');
  await f.act('reply');
  assert.equal((await f.snapshot()).state, 'idle');
  assert.deepEqual((await f.snapshot()).events, [['text', 'initial', 'dictated text']]);
});

test('stop during permission cancels and immediately releases any late stream', async t => {
  const f = await fixture(t);
  await f.act('start');
  await f.act('stop');
  await f.act('grant');
  const result = await f.snapshot();
  assert.equal(result.state, 'idle');
  assert.equal(result.recorders, 0);
  assert.deepEqual(result.tracks, [[1, 1]]);
});

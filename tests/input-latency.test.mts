import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInputLatencySamples, observeComposerInput, inputLatency, resetInputLatency } from '../web/src/lib/inputLatency.ts';

test('typing statistics bound the rolling sample and retain session count and maximum', () => {
  const meter = createInputLatencySamples(4);
  assert.deepEqual(meter.read(), { count: 0, sampleCount: 0, p50Ms: null, p95Ms: null, maxMs: null });
  [500, 1, 2, 3, 4, 5].forEach(meter.add);
  assert.deepEqual(meter.read(), { count: 6, sampleCount: 4, p50Ms: 3, p95Ms: 5, maxMs: 500 });
  [NaN, Infinity, -1].forEach(meter.add);
  assert.equal(meter.read().count, 6);
  meter.reset(); assert.equal(meter.read().count, 0);
});

test('composer timing batches frames, covers IME, reads no content and has no idle work', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const input = new EventTarget();
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  for (const key of ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  Object.assign(globalThis, { window: globalThis, document,
    requestAnimationFrame: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  });
  const fire = (type: string) => {
    const event = new Event(type);
    for (const key of ['key', 'data', 'value']) Object.defineProperty(event, key, { get() { throw new Error('Never read content'); } });
    input.dispatchEvent(event);
  };
  const paint = () => { const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn(performance.now())); };
  resetInputLatency(); const stop = observeComposerInput(input as HTMLTextAreaElement);
  assert.equal(frames.size, 0);
  fire('keydown'); fire('beforeinput'); fire('keyup');
  fire('beforeinput'); // mobile or IME with no preceding key
  assert.equal(frames.size, 1); paint();
  assert.equal(inputLatency().count, 0, 'wait until after the frame');
  fire('beforeinput'); // arrives after this frame, before its task
  t.mock.timers.tick(1);
  assert.equal(inputLatency().count, 2);
  assert.equal(frames.size, 1); paint(); t.mock.timers.tick(1);
  assert.equal(inputLatency().count, 3); assert.equal(frames.size, 0);
  fire('keydown'); fire('keyup'); assert.equal(frames.size, 0, 'navigation keys do not schedule work');
  fire('beforeinput'); document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  paint(); t.mock.timers.tick(1); assert.equal(inputLatency().count, 3);
  document.visibilityState = 'visible'; fire('beforeinput'); stop(); paint(); t.mock.timers.tick(1);
  fire('beforeinput'); assert.equal(frames.size, 0); assert.equal(inputLatency().count, 3);
});

test('Event Timing corrects delayed presentation samples without keeping event or text data', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const input = new EventTarget(); let paint!: FrameRequestCallback, deliver!: (list: any) => void;
  class Timing { get interactionId() { return 1; } }
  class Observer { constructor(callback: (list: any) => void) { deliver = callback; } observe() {} disconnect() {} }
  for (const key of ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'PerformanceObserver', 'PerformanceEventTiming']) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : Reflect.deleteProperty(globalThis, key));
  }
  Object.assign(globalThis, { window: globalThis, document, requestAnimationFrame: (fn: FrameRequestCallback) => { paint = fn; return 1; }, cancelAnimationFrame() {}, PerformanceObserver: Observer, PerformanceEventTiming: Timing });
  resetInputLatency(); const stop = observeComposerInput(input as HTMLTextAreaElement);
  const keydown = new Event('keydown'); input.dispatchEvent(keydown); input.dispatchEvent(new Event('beforeinput'));
  paint(0); t.mock.timers.tick(1);
  assert.equal(inputLatency().p95Ms, 16);
  const entry = { name: 'keydown', startTime: keydown.timeStamp, duration: 80, interactionId: 1, target: input };
  deliver({ getEntries: () => [entry] });
  assert.equal(inputLatency().p95Ms, 80); assert.equal(inputLatency().count, 1);
  assert.equal(inputLatency().method, 'event-timing');
  resetInputLatency(); deliver({ getEntries: () => [{ ...entry, duration: 96 }] });
  assert.equal(inputLatency().count, 0); assert.equal(inputLatency().maxMs, null, 'late entries cannot cross a session reset');
  stop();
});

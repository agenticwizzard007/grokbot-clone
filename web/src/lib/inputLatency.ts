/** Numeric timings only. No keys, text, event objects, account IDs or network writes. */
export function createInputLatencySamples(capacity = 256) {
  const samples: number[] = [];
  let count = 0, maxMs = 0, epoch = 0;
  return {
    add(ms: number) {
      if (!Number.isFinite(ms) || ms < 0) return;
      const id = { ordinal: count, epoch };
      samples[count++ % capacity] = ms;
      maxMs = Math.max(maxMs, ms);
      return id;
    },
    update(id: { ordinal: number; epoch: number } | undefined, ms: number) {
      if (!id || id.epoch !== epoch || !Number.isFinite(ms) || ms < 0) return;
      if (count - id.ordinal <= capacity) samples[id.ordinal % capacity] = ms;
      maxMs = Math.max(maxMs, ms);
    },
    read() {
      const sorted = [...samples].sort((a, b) => a - b);
      const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null;
      return { count, sampleCount: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: count ? maxMs : null };
    },
    reset() { samples.length = 0; count = 0; maxMs = 0; epoch++; },
  };
}

const session = createInputLatencySamples();
let eventTiming = false;
export const inputLatency = () => ({ ...session.read(), method: eventTiming ? 'event-timing' : 'frame-task', resolutionFloorMs: eventTiming ? 16 : null });
export const resetInputLatency = session.reset;
declare global { interface Window { __swarmInputLatency: typeof inputLatency } }
if (typeof window !== 'undefined') window.__swarmInputLatency = inputLatency;

/** One frame and one post-frame task per batch, and no work while idle. The
 * post-frame task approximates presentation; it is not a hardware paint clock.
 * beforeinput also covers mobile keyboards and IME without inspecting content. */
export function observeComposerInput(input: HTMLTextAreaElement) {
  let keyStart: number | undefined;
  type Sample = { start: number; duration?: number; id?: ReturnType<typeof session.add>; timed: boolean };
  let pending: Sample[] = [];
  const timed = new Map<number, Sample>();
  // Event Timing includes dispatch delay and actual presentation, with an 8 ms
  // resolution. Its minimum reporting threshold is 16 ms; shorter eligible
  // interactions are conservatively counted as 16 ms, never as zero.
  let observer: PerformanceObserver | undefined;
  try {
    if (typeof PerformanceEventTiming !== 'undefined' && 'interactionId' in PerformanceEventTiming.prototype) {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries() as PerformanceEventTiming[]) {
          if (entry.name !== 'keydown' || !entry.interactionId || entry.target !== input) continue;
          const sample = timed.get(entry.startTime);
          if (sample) { sample.duration = Math.max(16, entry.duration); session.update(sample.id, sample.duration); }
        }
      });
      observer.observe({ type: 'event', durationThreshold: 16 } as PerformanceObserverInit);
      eventTiming = true;
    }
  } catch { observer?.disconnect(); observer = undefined; }

  let frame = 0, task = 0;
  const clear = () => {
    keyStart = undefined; pending = []; timed.clear();
    cancelAnimationFrame(frame); clearTimeout(task); frame = task = 0;
  };
  const keydown = (event: KeyboardEvent) => { keyStart = event.isComposing ? undefined : event.timeStamp; };
  const keyup = () => { keyStart = undefined; };
  const schedule = () => {
    if (frame || task || !pending.length) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      // Capture only inputs that preceded this frame. A new input arriving
      // before the task needs its own frame, not the preceding paint.
      const batch = pending; pending = [];
      task = window.setTimeout(() => {
        task = 0;
        if (document.visibilityState === 'visible') {
          const end = performance.now();
          batch.forEach(sample => { sample.id = session.add(sample.timed ? sample.duration ?? 16 : end - sample.start); });
        }
        if (pending.length) schedule();
      }, 0);
    });
  };
  const beforeinput = (event: InputEvent) => {
    if (document.visibilityState !== 'visible') { clear(); return; }
    const sample: Sample = { start: keyStart ?? event.timeStamp, timed: !!observer && keyStart !== undefined && !event.isComposing };
    keyStart = undefined;
    if (sample.timed) {
      timed.set(sample.start, sample);
      if (timed.size > 256) timed.delete(timed.keys().next().value!);
    }
    // Bound even the pending queue if rendering is suspended by the browser.
    if (pending.length < 256) pending.push(sample);
    schedule();
  };
  const visibility = () => { if (document.visibilityState !== 'visible') clear(); };
  input.addEventListener('keydown', keydown);
  input.addEventListener('keyup', keyup);
  input.addEventListener('beforeinput', beforeinput);
  input.addEventListener('blur', keyup);
  document.addEventListener('visibilitychange', visibility);
  return () => {
    clear(); observer?.disconnect();
    input.removeEventListener('keydown', keydown);
    input.removeEventListener('keyup', keyup);
    input.removeEventListener('beforeinput', beforeinput);
    input.removeEventListener('blur', keyup);
    document.removeEventListener('visibilitychange', visibility);
  };
}

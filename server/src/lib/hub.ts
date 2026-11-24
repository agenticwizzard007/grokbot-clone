import { canPublishRun, currentRun } from '../agent/run-scope.js';
import type { ServerEvent } from '../types.js';
import { afterCommit } from './commit-effects.js';

type Listener = (ev: ServerEvent) => void;

/** Per-user fan-out of server events to connected SSE clients. */
class Hub {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(userId: string, fn: Listener): () => void {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(userId);
    };
  }

  emit(userId: string, ev: ServerEvent) {
    const run = currentRun();
    if (!canPublishRun(run)) return;
    const tagged = run ? { ...ev, runId: run.id, runBotId: run.botId } : ev;
    afterCommit(() => { if (canPublishRun(run)) this.deliver(userId, tagged); });
  }

  private deliver(userId: string, ev: ServerEvent) {
    const set = this.listeners.get(userId);
    if (!set) return;
    for (const fn of set) {
      try { fn(ev); } catch { /* ignore broken listener */ }
    }
  }

  isOnline(userId: string) {
    return (this.listeners.get(userId)?.size ?? 0) > 0;
  }

  broadcast(ev: ServerEvent) {
    for (const userId of this.listeners.keys()) this.emit(userId, ev);
  }
}

export const hub = new Hub();

import { settingsRead } from './settingsReads';

/** Shared bounded read, including response bodies and upstreams that ignore abort. */
export function readDeadline<T>(read: (signal: AbortSignal) => Promise<T>, ms = 4000): Promise<T> {
  return settingsRead(read, undefined, ms);
}

import { EventEmitter } from 'node:events';
const events = new EventEmitter(); events.setMaxListeners(0);
export function sessionRevoked(hash: string) { events.emit(hash); }
export function onSessionRevoked(hash: string, close: () => void) {
  events.on(hash, close); return () => { events.off(hash, close); };
}

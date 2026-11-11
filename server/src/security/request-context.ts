import { AsyncLocalStorage } from 'node:async_hooks';
const context = new AsyncLocalStorage<{ sessionHash: string }>();
export const withSessionContext = <T>(sessionHash: string, fn: () => T): T => context.run({ sessionHash }, fn);
export const currentSessionHash = () => context.getStore()?.sessionHash;

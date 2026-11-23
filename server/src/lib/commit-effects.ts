import { db } from '../db.js';

type Effect = () => void;
let pending: Effect[] | undefined;

/** Defer observable work while an admission transaction is open. */
export function afterCommit(effect: Effect): void {
  if (pending) pending.push(effect);
  else effect();
}

/** Synchronous SQLite admission, including its outer commit and side effects. */
export function transactionWithEffects<T>(write: () => T): T {
  // An unmanaged outer transaction could still roll back after we publish.
  if (db.inTransaction && !pending) throw new Error('Admission must own the transaction boundary.');
  const parent = pending;
  const effects: Effect[] = [];
  let result: T;
  try {
    pending = effects;
    result = db.transaction(write).immediate();
  } finally {
    pending = parent;
  }
  // A failed transaction never reaches this point. Nested commits wait for their parent.
  if (parent) parent.push(...effects);
  else for (const effect of effects) {
    // Committed work remains accepted even if a notification fails. Queued jobs
    // are durable and startup recovery can schedule them again.
    try { effect(); } catch { console.error('[admission] post-commit effect failed'); }
  }
  return result;
}

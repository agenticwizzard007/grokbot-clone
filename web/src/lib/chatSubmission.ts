interface Submission { id: string; text: string }
const storageKey = (draftKey: string) => `swarm.chatSubmission:${draftKey}`;

/** Unacknowledged sends survive reloads, scoped to this tab, account and Bot. */
export function pendingSubmission(draftKey: string): Submission | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(draftKey)) ?? 'null');
    return value && typeof value.id === 'string' && typeof value.text === 'string' ? value : null;
  } catch { return null; }
}

export function beginSubmission(draftKey: string, text: string): Submission {
  const prior = pendingSubmission(draftKey);
  const submission = prior?.text === text ? prior : { id: crypto.randomUUID(), text };
  // Persist before POST, including when the previous attempt failed before receiving a response.
  // If storage is unavailable, do not send work that cannot be safely retried after reload.
  try { sessionStorage.setItem(storageKey(draftKey), JSON.stringify(submission)); }
  catch { throw new Error('Unable to save this message for retry. Enable browser storage and try again.'); }
  return submission;
}

export function acknowledgeSubmission(draftKey: string, id: string) {
  // A late receipt must not clear a newer draft from another mounted composer.
  if (pendingSubmission(draftKey)?.id === id) sessionStorage.removeItem(storageKey(draftKey));
}

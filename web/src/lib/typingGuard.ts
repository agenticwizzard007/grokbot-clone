/**
 * R2F-005: keys typed into one field must not land in another one that takes focus on its own.
 * Tracks the last key press so auto-focus can wait until the user stops typing.
 */
export const TYPING_IDLE_MS = 300;
const HOLD_MS = 3000;
let lastKeyAt = -Infinity;
let holdUntil = 0;
if (typeof window !== 'undefined') window.addEventListener('keydown', () => { lastKeyAt = performance.now(); }, true);

export const msSinceLastKey = () => performance.now() - lastKeyAt;

/** Call before navigating from a form into a chat: that chat's composer focuses only once typing pauses. */
export function holdComposerFocus() { holdUntil = performance.now() + HOLD_MS; }

/** True once per hold: the caller must wait for {@link whenTypingIdle} before taking focus. */
export function takeComposerHold(): boolean {
  const held = performance.now() < holdUntil;
  holdUntil = 0;
  return held;
}

/** Run `fn` once no key has been pressed for `idle` ms. Returns a cancel function. */
export function whenTypingIdle(fn: () => void, idle = TYPING_IDLE_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const age = msSinceLastKey();
    if (age >= idle) fn();
    else timer = setTimeout(check, Math.ceil(idle - age) + 5);
  };
  check();
  return () => clearTimeout(timer);
}

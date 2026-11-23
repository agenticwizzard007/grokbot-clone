/** Only an explicit chat stop is described as a user stop. */
export type InterruptionSource = 'user' | 'voice' | 'setup' | 'conversation' | 'workflow' | 'system';
const reasons: Record<InterruptionSource, string> = {
  user: 'You stopped this request.',
  voice: 'This request was stopped by a voice call control.',
  setup: 'This request ended because setup was skipped.',
  conversation: 'This request ended because a new conversation was started.',
  workflow: 'This request was interrupted by a task control. Review its activity, then retry if needed.',
  system: 'This request was interrupted by a server action. Review its activity, then retry.',
};
export class TurnInterruption extends Error {
  constructor(readonly source: InterruptionSource) { super(reasons[source]); }
}
export function interruptionMessage(signal: AbortSignal): string {
  return signal.reason instanceof TurnInterruption ? signal.reason.message
    : 'This request was interrupted before it finished. Review its activity, then retry.';
}

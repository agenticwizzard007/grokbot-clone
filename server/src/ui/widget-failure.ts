/** Stable diagnostics and user copy. Never log provider output or prompts. */
export const widgetFailureMessages = {
  timeout: 'The answer took too long. Try again.',
  provider_unavailable: 'Your model is unavailable. Check Models & access in Settings.',
  budget: 'Your account usage limit has been reached.',
  parse: 'The answer format was invalid. Try again.',
  empty: 'Your model returned no answer. Try again.',
  cancelled: 'The run was interrupted. Try again.',
  source_unavailable: 'The requested data is unavailable. Try again.',
  invalid_action: 'The answer included an unavailable action. Try again.',
  internal: 'The answer could not be saved. Try again.',
} as const;
export type WidgetFailureCode = keyof typeof widgetFailureMessages;
export class WidgetRunFailure extends Error {
  constructor(readonly reason: WidgetFailureCode) { super(widgetFailureMessages[reason]); }
}
export function widgetFailure(error: unknown, fallback: WidgetFailureCode = 'internal'): WidgetFailureCode {
  if (error instanceof WidgetRunFailure) return error.reason;
  const value = error as { code?: string; name?: string; message?: string; status?: number } | null;
  if (value?.code === 'cost_cap' || value?.status === 402 || /budget|quota|usage limit|credit|insufficient/i.test(value?.message ?? '')) return 'budget';
  if (/timeout|timed out/i.test(`${value?.name} ${value?.message}`)) return 'timeout';
  if (value?.name === 'AbortError') return 'cancelled';
  if (/empty response|neither a reply nor an action/i.test(value?.message ?? '')) return 'empty';
  if (value?.name === 'ZodError' || value?.name === 'SyntaxError' || /invalid.*(?:output|response|arguments)/i.test(value?.message ?? '')) return 'parse';
  return fallback;
}

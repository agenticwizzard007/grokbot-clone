export type HandoffErrorCode = 'invalid_input' | 'not_found' | 'output_deleted' | 'disabled' | 'policy_denied' | 'cycle_detected' | 'chain_too_long' | 'rate_limited' | 'target_not_allowed' | 'not_in_loop' | 'loop_nested' | 'size_limit' | 'idempotency_conflict' | 'invalid_state' | 'same_bot_roles';

export class HandoffError extends Error {
  readonly status: number;
  constructor(readonly code: HandoffErrorCode, message: string) {
    super(message);
    this.name = 'HandoffError';
    this.status = code === 'not_found' ? 404 : code === 'output_deleted' ? 410 : code === 'disabled' ? 503
      : code === 'rate_limited' ? 429 : ['idempotency_conflict', 'invalid_state'].includes(code) ? 409
        : ['invalid_input', 'size_limit'].includes(code) ? 400 : 422;
  }
}

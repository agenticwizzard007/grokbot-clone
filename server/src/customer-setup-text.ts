/** Display copy only: connection API values and executable instructions keep their types. */
export const setupConnectionWords: Record<string, string> = {
  ACTIVE: 'connected', CONNECTED: 'connected', EXPIRED: 'needs to be reconnected',
  INACTIVE: 'not connected', DISCONNECTED: 'not connected', REVOKED: 'needs to be reconnected',
  NEEDS_REAUTH: 'needs to be reconnected', REAUTH_REQUIRED: 'needs to be reconnected', AUTHORIZATION_REQUIRED: 'needs to be reconnected',
  INITIATED: 'waiting for connection', INITIALIZING: 'waiting for connection', PENDING: 'waiting for connection',
  INITIATING: 'waiting for connection', AUTHORIZATION_PENDING: 'waiting for connection', AWAITING_AUTHORIZATION: 'waiting for connection',
  FAILED: 'could not connect', ERROR: 'connection unavailable', DISABLED: 'connection turned off', DELETED: 'connection removed',
  UNKNOWN: 'connection status unavailable',
};
const states = Object.keys(setupConnectionWords).join('|');
const stateSentence = new RegExp(`\\b(?:account\\s+)?(?:is|was)\\s+(${states})\\b`, 'g');
const stateWord = new RegExp(`\\b(${states})\\b`, 'g');

export function customerSetupText(text: string): string {
  return text.replace(stateSentence, (_match, state: string) => setupConnectionWords[state])
    .replace(stateWord, state => setupConnectionWords[state])
    .replace(/\bconnection (?:has )?expired\b/gi, 'needs to be reconnected');
}

/** A render-only copy of generated brief fields, without changing the saved specification. */
export function customerSetupValue<T>(value: T): T {
  if (typeof value === 'string') return customerSetupText(value) as T;
  if (Array.isArray(value)) return value.map(customerSetupValue) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, customerSetupValue(item)])) as T;
  return value;
}

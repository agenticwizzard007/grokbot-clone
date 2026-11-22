/** MF-011: a job waiting in the account queue (detail names the Bot it waits behind, when known). */
export function queuedPhrase(detail?: string | null): string {
  const name = typeof detail === 'string' ? detail.trim() : '';
  return name ? `Queued behind ${name}` : 'Starting...';
}

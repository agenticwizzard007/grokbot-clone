import type { LiveState, Row } from '@shared/types';

/** Filter the explicit wire audience, including legacy peer-message envelopes. */
export function isInternalRow(row: Row): boolean {
  const body = row.body as Row['body'] & { audience?: string };
  return (row as Row & { audience?: string }).audience === 'internal' || body.audience === 'internal'
    || (body.type === 'message' && body.from?.kind === 'bot');
}
export function userFacingLive(live: LiveState | undefined): LiveState | undefined {
  return (live as (LiveState & { audience?: string }) | undefined)?.audience === 'internal' ? undefined : live;
}

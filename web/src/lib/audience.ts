import type { LiveState, Row } from '@shared/types';

/** Explicit audience wins; infer internal peer messages only for legacy rows. */
export function isInternalRow(row: Row): boolean {
  const body = row.body as Row['body'] & { audience?: string };
  if (row.audience === 'internal' || body.audience === 'internal') return true;
  if (row.audience === 'user' || body.audience === 'user') return false;
  return body.type === 'message' && body.from?.kind === 'bot';
}
export function userFacingLive(live: LiveState | undefined): LiveState | undefined {
  return (live as (LiveState & { audience?: string }) | undefined)?.audience === 'internal' ? undefined : live;
}

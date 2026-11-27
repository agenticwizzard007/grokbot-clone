import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { Row } from '../components/layout';
import type { HandoffStatus } from './api';
import { handoffHref, handoffText } from './useHandoffs';
import './handoffs.css';

export const handoffStatus: Record<HandoffStatus, string> = {
  pending_approval: 'Needs approval', queued: 'Queued', delivered: 'Delivered', running: 'Working',
  completed: 'Completed', failed: 'Failed', declined: 'Declined', cancelled: 'Stopped', expired: 'Expired',
};
export interface HandoffRowBody {
  handoffId: string; direction: 'sent' | 'received'; otherBotId: string; status: HandoffStatus;
  title: string; loopId?: string; iteration?: number;
}
export function HandoffRow({ body, otherBotName = 'Agent' }: { body: HandoffRowBody; otherBotName?: string }) {
  const Direction = body.direction === 'sent' ? ArrowUpRight : ArrowDownLeft;
  return <Row className="ho ho-receipt" leading={<Direction size={18} aria-hidden="true" />}
    title={`${body.direction === 'sent' ? 'Sent to' : 'Handed off from'} ${handoffText(otherBotName)}`}
    subtitle={handoffText(body.title)} trailing={<a className="ho-button ho-button--quiet" href={handoffHref(body.handoffId)} aria-label={`View handoff ${handoffText(body.title)}`}>View</a>}>
    <span className="ho-status" role="status"><span className="ho-dot" aria-hidden="true" />{handoffStatus[body.status]}</span>
    {body.loopId && <a className="ho-inline-link" href={`#loop/${encodeURIComponent(body.loopId)}`}>Loop{body.iteration ? `, pass ${body.iteration}` : ''}</a>}
  </Row>;
}

export function HandoffState({ loading, error, empty, retry }: { loading?: boolean; error?: string; empty?: string; retry?: () => void }) {
  if (error) return <div className="ho ho-state"><p role="alert">{error}</p>{retry && <button className="ho-button" onClick={retry}>Retry</button>}</div>;
  if (loading) return <Row className="ho ho-loading" title={<span role="status">Loading</span>} />;
  return empty ? <Row className="ho" title={empty} /> : null;
}

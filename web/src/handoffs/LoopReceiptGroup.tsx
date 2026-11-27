import { useEffect, useId, useState } from 'react';
import { ChevronDown, ChevronUp, Repeat2 } from 'lucide-react';
import type { Row as TranscriptRow } from '@shared/types';
import { Row } from '../components/layout';
import { useStore } from '../store';
import { HandoffRow, type HandoffRowBody } from './HandoffRow';
import { receiptLoopSummary } from './groupReceipts';
import { loopsApi } from './loops/api';
import { useHandoffResource } from './useHandoffs';

export function LoopReceiptGroup({ loopId, rows }: { loopId: string; rows: TranscriptRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const passesId = useId();
  const bots = useStore(state => state.bots);
  const run = useHandoffResource(`receipt-loop:${loopId}`, signal => loopsApi.get(loopId, signal));
  useEffect(() => loopsApi.subscribe(id => { if (!id || id === loopId) run.retry(); }), [loopId, run.retry]);
  const summary = receiptLoopSummary(rows.map(row => row.body as unknown as HandoffRowBody), run.data?.loop);
  const Chevron = expanded ? ChevronUp : ChevronDown;
  return <div className="ho-receipt-wrap ho-loop-receipt" data-row-seq={expanded ? undefined : rows[0].seq}>
    <Row className="ho ho-receipt ho-receipt--loop" leading={<Repeat2 size={20} aria-hidden="true" />} title="Loop"
      trailing={<>
        <button type="button" className="ho-button ho-button--quiet ho-receipt-expand" aria-label={expanded ? 'Hide passes' : 'Show passes'} aria-expanded={expanded} aria-controls={passesId} onClick={() => setExpanded(value => !value)}><Chevron size={20} aria-hidden="true" /></button>
        <a className="ho-button ho-button--quiet" href={`#loop/${encodeURIComponent(loopId)}`} aria-label="View loop">View</a>
      </>}>
      <div className="ho-receipt-meta" aria-live="polite">
        <span className="ho-chip">{summary.chip}</span>
        <span className="ho-status" role="status">{summary.status ?? (run.error ? 'Unavailable' : 'Loading')}</span>
      </div>
    </Row>
    <div id={passesId} className="ho-receipt-passes" role="group" aria-label="Loop passes" hidden={!expanded}>
      {expanded && rows.map(row => {
        const body = row.body as unknown as HandoffRowBody;
        return <div key={row.seq} data-row-seq={row.seq}><HandoffRow body={body} inLoopGroup otherBotName={bots.find(bot => bot.id === body.otherBotId)?.name} /></div>;
      })}
    </div>
  </div>;
}

import { useRef, useState } from 'react';
import { ButtonGroup, Card, Page, Row, Section } from '../components/layout';
import { handoffApi, type RunOutput } from './api';
import { handoffStatus, HandoffState } from './HandoffRow';
import { BackControl, OutputParts } from './OutputViewer';
import { OutputCard } from './OutputCard';
import { errorText, handoffText, refreshHandoffs, useHandoffResource } from './useHandoffs';
import './handoffs.css';

const eventLabels: Record<string, string> = {
  'handoff.created': 'Created', 'handoff.approved': 'Approved', 'handoff.declined': 'Declined',
  'handoff.delivered': 'Delivered', 'handoff.read': 'Read parts', 'handoff.completed': 'Completed',
  'handoff.failed': 'Failed', 'handoff.cancelled': 'Stopped', 'handoff.expired': 'Expired',
};
export function HandoffDetail({ handoffId, onBack, onSend }: { handoffId: string; onBack?: () => void; onSend: (output: RunOutput) => void }) {
  const detail = useHandoffResource(`handoff:${handoffId}`, signal => handoffApi.detail(handoffId, signal));
  const agents = useHandoffResource('handoff-agents', signal => handoffApi.agents(signal));
  const handoff = detail.data?.handoff;
  const source = useHandoffResource(`source:${handoff?.sourceOutputId ?? ''}`, signal => handoffApi.output(handoff!.sourceOutputId, signal), !!handoff);
  const result = useHandoffResource(`result:${handoff?.resultOutputId ?? ''}`, signal => handoffApi.output(handoff!.resultOutputId!, signal), !!handoff?.resultOutputId);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const lock = useRef(false);
  const name = (id: string) => handoffText(agents.data?.bots.find(bot => bot.id === id)?.name ?? 'Agent');
  async function act(action: 'approve' | 'decline' | 'cancel') {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await handoffApi.act(handoffId, action); refreshHandoffs(); }
    catch (reason) { setError(errorText(reason)); }
    finally { lock.current = false; setBusy(false); }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(JSON.stringify({ id: handoffId, status: handoff?.status,
        sourceOutputId: handoff?.sourceOutputId, resultOutputId: handoff?.resultOutputId,
        events: detail.data?.events.map(({ seq, type }) => ({ seq, type })) }, null, 2));
      setCopied(true);
    } catch { setError('Could not copy details. Try again.'); }
  }
  return <Page type="form" className="ho"><BackControl onBack={onBack} /><h1 className="ho-heading">Handoff</h1>
    <HandoffState loading={!detail.data && detail.loading} error={detail.error} retry={detail.retry} empty={!detail.loading && !detail.error && !handoff ? 'Nothing here yet' : undefined} />
    {handoff && <>
      <Section title="Agents"><Card variant="list"><Row title={`From ${name(handoff.fromBotId)}`} /><Row title={`To ${name(handoff.toBotId)}`} subtitle={<span className="ho-status" role="status">{handoffStatus[handoff.status]}</span>} />
        {handoff.reason && <Row title={handoffText(handoff.reason)} />}
      </Card></Section>
      <Section title="Ask"><Card><p className="ho-prose">{handoffText(handoff.instruction)}</p></Card></Section>
      <Section title="Passed"><HandoffState loading={!source.data && source.loading} error={source.error} retry={source.retry} />{source.data && <OutputParts output={source.data.output} />}</Section>
      <Section title="Result">{handoff.resultOutputId ? <OutputCard output={result.data?.output} loading={result.loading} error={result.error} onRetry={result.retry} onSend={onSend} openLabel="Open output" /> : <Card variant="list"><HandoffState empty={['queued', 'delivered', 'running', 'pending_approval'].includes(handoff.status) ? 'Waiting for a result' : 'No result returned'} /></Card>}</Section>
      <Section title="Events"><Card variant="list">{detail.data?.events.length ? [...detail.data.events].sort((a, b) => a.seq - b.seq).map(event => <Row key={event.seq}
        title={eventLabels[event.type] ?? 'Updated'} subtitle={new Date(event.createdAt).toLocaleString()} />) : <HandoffState empty="No events yet" />}</Card></Section>
      <ButtonGroup>
        {handoff.status === 'pending_approval' ? <><button disabled={busy} className="ho-button ho-button--primary" onClick={() => void act('approve')}>Approve</button><button disabled={busy} className="ho-button" onClick={() => void act('decline')}>Decline</button></> : ['queued', 'delivered', 'running'].includes(handoff.status) && <button disabled={busy} className="ho-button" onClick={() => void act('cancel')}>Stop</button>}
        {handoff.status !== 'pending_approval' && <button className="ho-button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy details'}</button>}
      </ButtonGroup>
      {handoff.status === 'pending_approval' && <details className="ho-more"><summary>More options</summary><button className="ho-button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy details'}</button></details>}
      {error && <p className="ho-error" role="alert">{error}</p>}
    </>}
  </Page>;
}

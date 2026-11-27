import { useLayoutEffect, useRef, useState } from 'react';
import { FileText, Send } from 'lucide-react';
import { ButtonGroup, Card, Row } from '../components/layout';
import type { HandoffLink, RunOutput } from './api';
import { handoffText, outputHref } from './useHandoffs';
import { HandoffState } from './HandoffRow';
import './handoffs.css';

export interface OutputCardProps {
  output?: RunOutput | null; loading?: boolean; error?: string; onRetry?: () => void;
  onSend: (output: RunOutput, targetId?: string) => void;
  openLabel?: string;
  suggestions?: { link: HandoffLink; name: string }[];
}
export function OutputCard({ output, loading, error, onRetry, onSend, suggestions = [], openLabel = 'Open' }: OutputCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const summary = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const element = summary.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollHeight > parseFloat(getComputedStyle(element).lineHeight) * 2 + 1);
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [output]);
  return <Card className="ho ho-output-card">
    {!output || error ? <HandoffState loading={loading} error={error} retry={onRetry} empty="No output yet" /> : <>
      <Row title={handoffText(output.title)} leading={<FileText size={18} aria-hidden="true" />}
        subtitle={output.status === 'draft' ? 'Incomplete' : output.status === 'superseded' ? 'Earlier output' : 'Output'} />
      <p ref={summary} className={`ho-summary${expanded ? ' is-expanded' : ''}`}>{handoffText(output.summary)}</p>
      {overflows && <button className="ho-button ho-button--quiet" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show more'}</button>}
      <div className="ho-chips" aria-label="Output parts">
        {(['file', 'link'] as const).map(kind => {
          const count = output.parts.filter(part => part.kind === kind).length;
          return count ? <span key={kind} className="ho-chip">{count} {kind}{count === 1 ? '' : 's'}</span> : null;
        })}
      </div>
      <ButtonGroup><button className="ho-button ho-button--primary" onClick={() => onSend(output)}><Send size={16} aria-hidden="true" />Send to agent</button>
        <a className="ho-button" href={outputHref(output.id)}>{openLabel}</a></ButtonGroup>
      {suggestions.filter(({ link }) => link.mode === 'suggest').map(({ link, name }) => <button key={link.id} className="ho-button ho-suggestion" onClick={() => onSend(output, link.toBotId)}>Send to {handoffText(name)}</button>)}
    </>}
  </Card>;
}

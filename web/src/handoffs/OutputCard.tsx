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
export function OutputCard({ output, loading, error, onRetry, onSend, openLabel = 'Open' }: OutputCardProps) {
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
  const title = handoffText(output?.title ?? '');
  const preview = handoffText(output?.summary ?? '').trim();
  const content = preview.toLowerCase().startsWith(title.toLowerCase()) ? preview.slice(title.length).replace(/^[\s:.,]+/, '') : preview;
  return <Card className="ho ho-output-card">
    {!output || error ? <HandoffState loading={loading} error={error} retry={onRetry} empty="No output yet" /> : <>
      <Row title={title} leading={<FileText size={18} aria-hidden="true" />}
        subtitle={output.status === 'draft' ? 'Incomplete' : output.status === 'superseded' ? 'Earlier output' : 'Output'} />
      {content && <p ref={summary} className={`ho-summary${expanded ? ' is-expanded' : ''}`}>{content}</p>}
      {overflows && <button className="ho-button ho-button--quiet" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show less' : 'Show more'}</button>}
      <div className="ho-chips" aria-label="Output parts">
        {(['file', 'link'] as const).map(kind => {
          const count = output.parts.filter(part => part.kind === kind).length;
          return count ? <span key={kind} className="ho-chip">{count} {kind}{count === 1 ? '' : 's'}</span> : null;
        })}
      </div>
      <ButtonGroup><button className="ho-button ho-button--primary" onClick={() => onSend(output)}><Send size={16} aria-hidden="true" />Send to agent</button>
        <a className="ho-button" href={outputHref(output.id)}>{openLabel}</a></ButtonGroup>
    </>}
  </Card>;
}

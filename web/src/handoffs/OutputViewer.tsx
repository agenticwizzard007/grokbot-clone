import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, File, FileText, Link as LinkIcon, Braces } from 'lucide-react';
import { ButtonGroup, Card, Page, Row, Section } from '../components/layout';
import { ProviderLabel } from '../components/ProviderMark';
import { handoffApi, type OutputPart, type RunOutput } from './api';
import { HandoffState } from './HandoffRow';
import { handoffText, outputHref, useHandoffResource } from './useHandoffs';
import { outputPreview } from './presentation';
import './handoffs.css';

export function BackControl({ onBack = () => history.back() }: { onBack?: () => void }) {
  return <button className="ho-button ho-button--quiet ho-back" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" />Back</button>;
}
export function partLabel(part: OutputPart) {
  return handoffText(part.kind === 'file' ? part.filename : part.kind === 'link' ? part.title || 'Link' : part.kind === 'text' ? 'Body' : part.name);
}
function partSize(part: OutputPart) {
  if (part.kind === 'text') return `${part.chars.toLocaleString()} characters`;
  if (part.kind === 'link') return 'Link';
  const bytes = part.kind === 'file' ? part.size : part.bytes;
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024).toLocaleString()} KB`;
}
const partIcons = { text: FileText, file: File, data: Braces, link: LinkIcon };
function httpsUrl(value: string) { try { return new URL(value).protocol === 'https:'; } catch { return false; } }

/** Manifest only. Text/data pages and artifact bytes remain lazy. */
export function OutputParts({ output, onOpen }: { output: RunOutput; onOpen?: (part: OutputPart) => void }) {
  return <Card variant="list">
    {!output.parts.length && <HandoffState empty="No parts" />}
    {output.parts.map(part => {
      const Icon = partIcons[part.kind];
      const action = part.kind === 'link'
        ? httpsUrl(part.url) ? <a className="ho-button ho-button--quiet" href={part.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${partLabel(part)}`}>Open</a> : <span>Link unavailable</span>
        : part.kind === 'file' ? <a className="ho-button ho-button--quiet" href={`/api/deliverables/artifacts/${encodeURIComponent(part.artifactId)}/download`} download aria-label={`Open ${partLabel(part)}`}>Open</a>
        : onOpen ? <button className="ho-button ho-button--quiet" onClick={() => onOpen(part)} aria-label={`Open ${partLabel(part)}`}>Open</button>
        : <a className="ho-button ho-button--quiet" href={outputHref(output.id, part.id)} aria-label={`Open ${partLabel(part)}`}>Open</a>;
      return <Row key={part.id} leading={<Icon size={18} aria-hidden="true" />} title={partLabel(part)} subtitle={partSize(part)} trailing={action} />;
    })}
  </Card>;
}

function PartReader({ outputId, part }: { outputId: string; part: OutputPart }) {
  const [offset, setOffset] = useState(0);
  const [pages, setPages] = useState<Record<number, string>>({});
  const heading = useRef<HTMLHeadingElement>(null);
  const page = useHandoffResource(`part:${outputId}:${part.id}:${offset}`, signal => handoffApi.part(outputId, part.id, offset, signal));
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    if (page.data) setPages(previous => ({ ...previous, [offset]: page.data?.text ?? '' }));
  }, [page.data, offset]);
  return <Section><h2 ref={heading} tabIndex={-1} className="ho-part-heading">{partLabel(part)}</h2>
    <Card><pre className="ho-part-text">{Object.entries(pages).sort(([a], [b]) => Number(a) - Number(b)).map(([, text]) => handoffText(text)).join('')}</pre>
      <HandoffState loading={page.loading} error={page.error} retry={page.retry} />
      {!page.loading && page.data?.next != null && page.data.next > offset && <button className="ho-button" onClick={() => setOffset(page.data!.next!)}>Read more</button>}
      {!page.loading && !page.error && !Object.values(pages).some(Boolean) && <HandoffState empty="No text in this part" />}
    </Card>
  </Section>;
}

export interface OutputViewerProps {
  outputId: string; partId?: string; onBack?: () => void; onSend: (output: RunOutput) => void;
  onStartLoop?: (output: RunOutput) => void;
}
export function OutputViewer({ outputId, partId, onBack, onSend, onStartLoop }: OutputViewerProps) {
  const resource = useHandoffResource(`output:${outputId}`, signal => handoffApi.output(outputId, signal));
  const [selected, setSelected] = useState<{ outputId: string; partId: string } | null>(null);
  const output = resource.data?.output;
  const summary = output ? outputPreview(handoffText(output.title), handoffText(output.summary)) : '';
  const activePart = output?.parts.find(part => part.id === (selected?.outputId === outputId ? selected.partId : partId) && (part.kind === 'text' || part.kind === 'data'));
  return <Page className="ho" type="form">
    <BackControl onBack={onBack} /><h1 className="ho-heading">{output ? handoffText(output.title) : 'Output'}</h1>
    <HandoffState loading={!output && resource.loading} error={resource.error} retry={resource.retry} empty={!resource.loading && !resource.error && !output ? 'No output yet' : undefined} />
    {output && <>
      {summary && <Section title="Summary"><Card><p className="ho-prose ho-output-summary">{summary}</p></Card></Section>}
      {output.status !== 'final' && <div className="ho-chips"><span className="ho-chip">{output.status === 'draft' ? 'Incomplete' : 'Earlier output'}</span></div>}
      <ButtonGroup><button className="ho-button ho-button--primary" onClick={() => onSend(output)}>Send to agent</button>{onStartLoop && <button className="ho-button" onClick={() => onStartLoop(output)}>Start loop</button>}</ButtonGroup>
      <Section title="Parts"><OutputParts output={output} onOpen={part => setSelected({ outputId, partId: part.id })} /></Section>
      {activePart && <PartReader key={`${outputId}:${activePart.id}`} outputId={outputId} part={activePart} />}
      <Section title="Provenance"><Card variant="list"><Row title={handoffText(output.provenance.producer.botName)} subtitle={new Date(output.finalizedAt ?? output.createdAt).toLocaleString()} />
        {output.provenance.model && <Row title={<ProviderLabel provider={output.provenance.model}>{handoffText(output.provenance.model)}</ProviderLabel>} subtitle={output.provenance.effort ? handoffText(output.provenance.effort) : undefined} />}
        {output.provenance.consumed.map((input, index) => <Row key={input} title={`Input ${index + 1}`} trailing={<a className="ho-button ho-button--quiet" href={outputHref(input)}>Open</a>} />)}
      </Card></Section>
    </>}
  </Page>;
}

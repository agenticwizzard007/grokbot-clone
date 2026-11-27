import { useId, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { ButtonGroup, Card, Page, Row, Section } from '../../components/layout';
import { GateCard } from './GateCard';
import { Timeline, endSentence } from './Timeline';
import { RunGraph } from './RunGraph';
import { useLoop } from './useLoop';
import { isTerminal, loopsApi, outputHref, statusLabel, type LoopApi, type OutputLink } from './api';
import './loops.css';

export interface LoopRunProps {
  id: string; api?: LoopApi; showBack?: boolean; onBack?: () => void;
  onUseOutput?: (output: OutputLink) => void; onSendOutput?: (output: OutputLink) => void;
}
export function LoopRun({ id, api = loopsApi, showBack = true, onBack = () => { location.hash = '#loops'; }, onUseOutput = output => { location.hash = outputHref(output); }, onSendOutput }: LoopRunProps) {
  const { detail, events, loading, error, refresh, act, pending, actionError } = useLoop(id, api);
  const [view, setView] = useState<'Timeline' | 'Graph'>('Timeline'), [copied, setCopied] = useState('');
  const [fullGoal, setFullGoal] = useState(false);
  const tabsId = useId();
  const back = showBack && <button className="ho-loop-button ho-loop-back" onClick={onBack}><ArrowLeft size={18} aria-hidden />Back</button>;
  if (!detail) return <Page type="list" className="ho-loops">{back}<h1>Loop</h1><Card aria-busy={loading}><Row title={loading ? 'Loading loop' : error || 'Nothing here yet'} trailing={!loading && <button className="ho-loop-button" onClick={refresh}>Retry</button>} /></Card></Page>;
  const { loop, bestOutput } = detail;
  const terminal = isTerminal(loop.status), sentence = endSentence(detail);
  const words = loop.spec.goal.split(/\s+/), shortGoal = words.length > 28;
  const copy = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify({ id: loop.id, status: loop.status, stopReason: loop.stopReason, revision: loop.revision, events: events.map(event => ({ seq: event.seq, type: event.type })) }, null, 2)); setCopied('Details copied'); }
    catch { setCopied('Could not copy details'); }
  };
  return <Page type="list" className="ho-loops" data-loop-revision={loop.revision}>
    <header className="ho-loop-heading">{back}<h1>{loop.spec.name}</h1><span className={`ho-loop-chip ho-loop-status-${loop.status}`} role="status">{statusLabel[loop.status]}</span></header>
    <div><p className="ho-loop-goal">{shortGoal && !fullGoal ? words.slice(0, 28).join(' ') : loop.spec.goal}</p>{shortGoal && <button className="ho-loop-button" aria-expanded={fullGoal} onClick={() => setFullGoal(!fullGoal)}>{fullGoal ? 'Less goal' : 'Full goal'}</button>}</div>
    <div className="ho-loop-progress"><label htmlFor={`${tabsId}-progress`}>{loop.iteration} of {loop.spec.limits.maxIterations} passes</label><progress id={`${tabsId}-progress`} max={loop.spec.limits.maxIterations} value={loop.iteration} /></div>
    {!terminal && <ButtonGroup>
      {loop.status === 'draft' && <button className="ho-loop-button ho-loop-primary" disabled={!!pending} onClick={() => void act('start')}>Start</button>}
      {loop.status === 'running' && <button className="ho-loop-button" disabled={!!pending} onClick={() => void act('pause')}>Pause</button>}
      {loop.status === 'paused' && <button className="ho-loop-button ho-loop-primary" disabled={!!pending} onClick={() => void act('resume')}>Resume</button>}
      <button className="ho-loop-button" disabled={!!pending} onClick={() => void act('stop')}>Stop</button>
    </ButtonGroup>}
    {(error || actionError) && <Card><Row title={<span role="alert">{actionError || error}</span>} trailing={error && <button className="ho-loop-button" onClick={refresh}>Retry</button>} /></Card>}
    <GateCard detail={detail} pending={pending} onAction={action => void act(action)} />
    <ButtonGroup role="tablist" aria-label="Run view">{(['Timeline', 'Graph'] as const).map((name, index) => <button key={name} className="ho-loop-button" role="tab" id={`${tabsId}-${name}`} aria-controls={`${tabsId}-panel`} aria-selected={view === name} tabIndex={view === name ? 0 : -1} onClick={() => setView(name)} onKeyDown={event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'Timeline' : event.key === 'End' ? 'Graph' : index === 0 ? 'Graph' : 'Timeline'; setView(next); document.getElementById(`${tabsId}-${next}`)?.focus(); }
    }}>{name}</button>)}</ButtonGroup>
    <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${view}`}>{view === 'Timeline' ? <Timeline detail={detail} events={events} /> : <RunGraph detail={detail} events={events} />}</div>
    {sentence && <Section title="Result"><Card><p className="ho-loop-result" role="status">{sentence}</p>
      {(loop.stopReason === 'max_cost' || loop.stopReason === 'max_tokens') && <p className="ho-loop-muted">Stopped after the step that crossed the limit.</p>}
      {bestOutput && <Row title="Best output" subtitle={bestOutput.title} />}
      <ButtonGroup stack>
        {bestOutput && <button className="ho-loop-button ho-loop-primary" onClick={() => onUseOutput(bestOutput)}>Use this</button>}
        {detail.canExtend === true && loop.spec.limits.maxIterations <= 8 && loop.stopReason === 'max_iterations' && <button className="ho-loop-button" disabled={!!pending} onClick={() => void act('extend')}>Continue 2 more passes</button>}
        {bestOutput && (onSendOutput ? <button className="ho-loop-button" onClick={() => onSendOutput(bestOutput)}>Send to agent</button> : <a className="ho-loop-button" href={`${outputHref(bestOutput)}${bestOutput.partId ? '&' : '?'}send=1`}>Send to agent</a>)}
      </ButtonGroup>
    </Card></Section>}
    <footer className="ho-loop-footer"><span className="ho-loop-muted">{detail.usage?.tracked ? [detail.usage.costUsd !== undefined ? `$${detail.usage.costUsd.toFixed(2)}` : '', detail.usage.tokens !== undefined ? `${detail.usage.tokens.toLocaleString()} tokens` : ''].filter(Boolean).join(' · ') : 'Cost not tracked on this plan'}</span><button className="ho-loop-button" onClick={() => void copy()}>Copy details</button><span role="status">{copied}</span></footer>
  </Page>;
}
export default LoopRun;

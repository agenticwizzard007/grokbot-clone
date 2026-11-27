import { useState } from 'react';
import { Bot } from 'lucide-react';
import { BrailleSpinner, fmtElapsed } from '../../components/BrailleSpinner';
import { Card, Row, Section } from '../../components/layout';
import { outputHref, type LoopDetail, type LoopEvent, type LoopVerdict } from './api';

export function endSentence({ loop, verdicts }: LoopDetail): string | null {
  const n = loop.iteration;
  const verdict = verdicts.find(item => item.iteration === n);
  switch (loop.stopReason) {
    case 'passed': return `Done in ${n} ${n === 1 ? 'pass' : 'passes'}: all checks passed.`;
    case 'max_iterations': {
      const failing = verdict?.checklist.filter(item => !item.pass).length ?? 0;
      const count = verdict?.checklist.length ?? 0;
      return `Stopped after ${n} ${n === 1 ? 'pass' : 'passes'} (limit).${count ? ` ${failing} of ${count} checks still fail.` : ''}`;
    }
    case 'stalled': return `Stopped: no progress between passes ${Math.max(1, n - 1)} and ${n}.`;
    case 'user_stopped': return 'Stopped by you.';
    case 'max_cost': case 'max_tokens': case 'max_minutes': return 'Stopped: budget reached.';
    case 'step_failed': return 'Stopped: an agent could not finish its step.';
    case 'no_verdict': return 'Stopped: the checker did not submit a verdict.';
    case 'declined': return 'Stopped: approval declined.';
    case 'gate_expired': return 'Stopped: approval expired.';
    default: return null;
  }
}

function VerdictRow({ verdict }: { verdict: LoopVerdict }) {
  const [expanded, setExpanded] = useState(false);
  const words = verdict.feedback.split(/\s+/);
  const excerpt = words.length > 24 && !expanded ? words.slice(0, 24).join(' ') : verdict.feedback;
  return <Row title={<span className="ho-loop-inline"><span className={`ho-loop-chip ${verdict.pass ? 'ho-loop-good' : 'ho-loop-warn'}`}>{verdict.pass ? 'Pass' : 'Fail'}</span><span>{verdict.checklist.filter(item => item.pass).length} of {verdict.checklist.length} checks</span>{verdict.score !== undefined && <span>Score {Math.round(verdict.score * 100)}%</span>}</span>}>
    <p className="ho-loop-feedback">{excerpt}</p>
    {words.length > 24 && <button className="ho-loop-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Less feedback' : 'More feedback'}</button>}
    <details><summary>Checks</summary><ul className="ho-loop-checklist">{verdict.checklist.map(item => <li key={item.id}>{item.pass ? 'Pass' : 'Fail'}: {item.note || item.id}</li>)}</ul></details>
    {verdict.corrected && <p className="ho-loop-muted">Verdict corrected from the required checks.</p>}
  </Row>;
}

const eventCopy: Record<string, string> = {
  'loop.approval_requested': 'Waiting for your approval', 'loop.approved': 'Approved', 'loop.declined': 'Approval declined',
  'loop.paused': 'Paused', 'loop.resumed': 'Resumed', 'loop.extended': 'Two more passes allowed',
  'loop.warning': 'Score has not improved over two passes', 'verdict.corrected': 'Verdict corrected from the required checks',
};
export function Timeline({ detail, events }: { detail: LoopDetail; events: LoopEvent[] }) {
  const passes = [...new Set([...detail.steps.map(step => step.iteration), ...detail.verdicts.map(verdict => verdict.iteration), ...events.flatMap(event => typeof event.data.iteration === 'number' && event.data.iteration > 0 ? [event.data.iteration] : [])])].sort((a, b) => a - b);
  if (!passes.length) return <Card><Row title={detail.loop.status === 'awaiting_approval' ? 'Waiting for your approval' : 'Nothing here yet'} /></Card>;
  return <ol className="ho-loop-timeline" aria-label="Loop timeline">{passes.map(iteration => {
    const steps = detail.steps.filter(step => step.iteration === iteration).sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity) || detail.loop.spec.steps.findIndex(step => step.id === a.stepId) - detail.loop.spec.steps.findIndex(step => step.id === b.stepId));
    const verdict = detail.verdicts.find(item => item.iteration === iteration);
    const passEvents = events.filter(event => event.data.iteration === iteration && eventCopy[event.type]);
    const inputs = [...new Map(steps.flatMap(step => step.inputs ?? []).map(input => [`${input.id}:${input.partId ?? ''}`, input])).values()];
    return <li key={iteration}><Section title={`Pass ${iteration}`}><Card variant="list">
      {steps.map(step => <Row key={step.id} leading={step.status === 'running' ? <BrailleSpinner /> : <Bot size={20} aria-hidden />} title={<span className="ho-loop-inline"><span>{step.botName || 'Agent'}</span><span className="ho-loop-chip">{step.role === 'maker' ? 'Maker' : step.role === 'checker' ? 'Checker' : 'Step'}</span></span>} subtitle={<span>{step.waitingForApproval ? 'Waiting for your approval' : ({ dispatching: 'Queued', dispatched: 'Queued', running: 'Working', completed: 'Complete', failed: 'Failed', skipped: 'Skipped' }[step.status])}{step.startedAt !== null && step.finishedAt !== null ? ` · ${fmtElapsed(step.finishedAt - step.startedAt)}` : ''}</span>} trailing={step.outputId ? <a className="ho-loop-button" href={outputHref({ id: step.outputId })}>Open output</a> : undefined} />)}
      {verdict && <VerdictRow verdict={verdict} />}
      {inputs.length > 0 && <Row title="Passed" subtitle={<span className="ho-loop-links">{inputs.map(input => <a className="ho-loop-button" key={`${input.id}:${input.partId ?? ''}`} href={outputHref(input)}>{input.title}</a>)}</span>} />}
      {passEvents.map(event => <Row key={event.seq} title={eventCopy[event.type]} subtitle={event.type === 'loop.warning' && typeof event.data.message === 'string' ? event.data.message : undefined} />)}
    </Card></Section></li>;
  })}</ol>;
}
export default Timeline;

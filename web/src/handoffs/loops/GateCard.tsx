import { ButtonGroup, Card, Row, Section } from '../../components/layout';
import type { LoopAction, LoopDetail } from './api';

export function GateCard({ detail, onAction, pending }: { detail: LoopDetail; onAction: (action: LoopAction) => void; pending: LoopAction | null }) {
  const { loop, gate } = detail;
  if (loop.status !== 'awaiting_approval') return null;
  const spec = loop.spec;
  const names = spec.steps.map(step => detail.bots?.find(bot => bot.id === step.botId)?.name ?? detail.steps.find(run => run.botId === step.botId)?.botName ?? 'Agent');
  return <Section title="Your approval"><Card tone="warning">
    <Row title={gate?.kind === 'cap' ? 'Pass limit reached' : gate?.kind === 'manual' ? 'Done or another pass?' : `Ready for pass ${gate?.iteration ?? loop.iteration + 1}`} />
    <Row title="Agents" subtitle={names.join(', ')} />
    <Row title="Stop when" subtitle={spec.exit.mode === 'checklist' ? spec.exit.items.map(item => item.text).join('; ') : spec.exit.mode === 'judge' ? spec.exit.rubric : spec.exit.mode === 'manual' ? 'You decide' : 'Checker decides'} />
    <Row title={`${spec.limits.maxIterations} passes · ${spec.limits.maxMinutes} minutes`} subtitle={[spec.limits.maxCostUsd !== undefined ? `Budget $${spec.limits.maxCostUsd}` : '', spec.limits.maxTokens !== undefined ? `${spec.limits.maxTokens} tokens` : '', `Step timeout ${spec.limits.stepTimeoutMinutes} minutes`].filter(Boolean).join(' · ')} />
    {gate?.expiresAt && <p className="ho-loop-muted">Approval expires <time dateTime={new Date(gate.expiresAt).toISOString()}>{new Date(gate.expiresAt).toLocaleString()}</time></p>}
    <ButtonGroup stack>
      {gate?.kind !== 'cap' && <button className="ho-loop-button ho-loop-primary" disabled={!!pending} onClick={() => onAction('approve')}>Approve</button>}
      <button className="ho-loop-button" disabled={!!pending} onClick={() => onAction('decline')}>Decline</button>
      {gate?.kind === 'cap' && detail.canExtend === true && spec.limits.maxIterations <= 8 && <button className="ho-loop-button ho-loop-primary" disabled={!!pending} onClick={() => onAction('extend')}>Extend</button>}
    </ButtonGroup>
  </Card></Section>;
}
export default GateCard;

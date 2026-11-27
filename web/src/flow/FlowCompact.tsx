import { Card, Row } from '../components/layout';
import { useFlow } from './useFlow';
import { openFlow } from './api';
import './flow.css';
export function FlowCompact({ botId }: { botId: string }) {
  const { model, disabled } = useFlow(botId);
  if (disabled) return null;
  return <Card className="flow-compact"><Row title="Agent flow" subtitle={model ? model.lanes.map(l => `${l.nodes.length + l.more} ${l.label.toLowerCase()}`).join(' · ') : 'Triggers, inputs, steps, outputs and handoffs'} trailing={<button type="button" onClick={() => openFlow(botId)}>View flow</button>} /></Card>;
}
export default FlowCompact;

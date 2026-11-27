import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, CornerDownLeft, GitBranch, Server, Circle } from 'lucide-react';
import type { FlowModel, FlowNode, FlowLaneId } from '@shared/flow/model-types';
import { Section, Card, Row } from '../components/layout';
import { BotAvatar } from '../avatar/BotAvatar';
import { useStore } from '../store';
import { ToolkitLogo } from '../components/ToolkitLogo';
import { openFlowNode, restoreFlowFocus } from './api';
import './flow.css';

const EMPTY: Record<FlowLaneId, [string, string]> = { triggers: ['Add a routine','settings/routines'], inputs: ['Add knowledge','settings/memories'], steps: ['Define steps','details/setup/responsibilities'], outputs: ['View files','details/files'], handoffs: ['Add a handoff','details/flow?link=new'] };
const MORE: Record<FlowLaneId, string> = { triggers: 'settings/routines', inputs: 'settings/general', steps: 'details/setup/responsibilities', outputs: 'details/files', handoffs: 'details/flow?link=all' };
const KIND: Record<FlowNode['kind'], string> = { schedule: 'schedule trigger', routine: 'routine trigger', event: 'event trigger', message: 'message trigger', inbound_handoff: 'incoming handoff', app: 'connected app', mcp: 'MCP server', knowledge: 'knowledge', suggested_app: 'suggested app', suggested_mcp: 'suggested MCP server', step: 'process step', skill: 'skill', report: 'report output', files: 'file output', message_out: 'message output', task: 'task output', handoff_to: 'outgoing handoff', handoff_from: 'incoming handoff', loop: 'loop' };
export function FlowChart({ model, onNode = node => openFlowNode(model.botId, node) }: { model: FlowModel; onNode?: (node: FlowNode) => void }) {
  const bots = useStore(s => s.bots);
  const title = useId(), root = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => { const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= 800)); if (root.current) observer.observe(root.current); return () => observer.disconnect(); }, []);
  useEffect(() => {
    const restore = () => requestAnimationFrame(() => requestAnimationFrame(() => restoreFlowFocus(model.botId, root.current)));
    restore(); window.addEventListener('swarm:flow-location', restore);
    return () => window.removeEventListener('swarm:flow-location', restore);
  }, [model]);
  const summary = `Flow: ${model.lanes.map(l => `${l.nodes.length + l.more} ${l.label.toLowerCase()}`).join(', ')}, ${model.loopBack.label.toLowerCase()}.`;
  return <section className={`flow-chart ${wide ? 'flow-chart--wide' : ''}`} ref={root} aria-labelledby={title}>
    <h2 id={title} className="flow-sr">Agent flow</h2><p className="flow-sr">{summary}</p>
    <ol className="flow-lanes">{model.lanes.map((lane, index) => <li key={lane.id} className="flow-lane">
      <Section title={<><span className="flow-lane__number" aria-hidden>{index + 1}</span>{lane.label}</>}>
        <ol className="flow-nodes">{lane.nodes.map(node => <li key={node.id}><Card className={`flow-node flow-node--${node.state}`}>
          <button type="button" data-flow-node={node.id} data-kind={node.kind} onClick={() => onNode(node)} aria-label={`${node.label}, ${KIND[node.kind]}${node.badge ? `, ${node.badge}` : ''}`}>
            <span className="flow-node__logo" aria-hidden>{node.logo?.kind === 'toolkit' ? <ToolkitLogo slug={node.logo.id} name={node.label} size={20} /> : node.logo?.kind === 'bot' ? (() => { const bot = bots.find(b => b.id === node.logo?.id); return bot ? <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={20} /> : <GitBranch size={20} />; })() : node.kind.includes('mcp') ? <Server size={20} /> : <Circle size={20} />}</span>
            <span className="flow-node__text"><strong>{node.label}</strong>{node.detail && <span>{node.detail}</span>}{node.badge && <small className="flow-badge">{node.badge}</small>}</span>
          </button>
        </Card></li>)}
        {!lane.nodes.length && <li><Card className="flow-empty"><Row title="None yet" /><button type="button" onClick={() => onNode({ id: `${lane.id}:empty`, kind: 'step', label: EMPTY[lane.id][0], state: 'ok', target: { hash: `#bot/${encodeURIComponent(model.botId)}/${EMPTY[lane.id][1]}` } })}>{EMPTY[lane.id][0]}</button></Card></li>}
        {lane.more > 0 && <li><button type="button" className="flow-more" onClick={() => onNode({ id: `${lane.id}:more`, kind: 'step', label: `More ${lane.label.toLowerCase()}`, state: 'ok', target: { hash: lane.id === 'inputs' ? (lane.nodes.every(n => n.kind.includes('mcp')) ? '#settings/mcp' : '#settings/apps') : `#bot/${encodeURIComponent(model.botId)}/${MORE[lane.id]}` } })}>+{lane.more} more</button></li>}
        </ol>
      </Section>
      {index < 4 && <span className="flow-arrow" aria-hidden>{wide ? <ArrowRight size={18} /> : <ArrowDown size={18} />}</span>}
    </li>)}</ol>
    <div className="flow-return"><svg className="flow-return__line" viewBox="0 0 1000 36" preserveAspectRatio="none" aria-hidden><path d="M 995 0 V 24 H 5 V 0 M 0 7 L 5 0 L 10 7" /></svg><Row leading={<CornerDownLeft size={18} aria-hidden />} title={`${model.loopBack.label}${wide ? '' : ': back to Triggers'}`} /></div>
  </section>;
}

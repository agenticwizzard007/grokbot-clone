import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { layoutRunGraph } from '@shared/handoffs/graph-layout';
import { Card, Row } from '../../components/layout';
import { outputHref, type LoopDetail, type LoopEvent } from './api';

export function RunGraph({ detail, events }: { detail: LoopDetail; events: LoopEvent[] }) {
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(390);
  const [paths, setPaths] = useState<{ paths: string[]; height: number }>({ paths: [], height: 0 });
  const marker = useId();
  const normalized = useMemo(() => events.map(event => {
    const step = detail.steps.find(step => step.stepId === event.data.stepId && step.iteration === event.data.iteration);
    return step ? { ...event, data: { ...event.data, botId: step.botId, botName: step.botName ?? 'Agent', role: step.role, ...(step.outputId ? { outputId: step.outputId } : {}), title: step.outputTitle ?? (step.role === 'checker' ? 'feedback' : 'Output') } } : event;
  }), [events, detail.steps]);
  const plan = useMemo(() => layoutRunGraph(normalized, width), [normalized, width]);
  const iterations = [...new Set(plan.nodes.map(node => node.iteration))];
  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    const measure = () => {
      const bounds = element.getBoundingClientRect(); setWidth(bounds.width);
      const nodes = new Map([...element.querySelectorAll<HTMLElement>('[data-graph-node]')].map(node => [node.dataset.graphNode, node.getBoundingClientRect()]));
      const next = plan.edges.map(edge => {
        const from = nodes.get(edge.from), to = nodes.get(edge.to); if (!from || !to) return edge.path;
        const x1 = from.left + from.width / 2 - bounds.left, y1 = from.bottom - bounds.top;
        const x2 = to.left + to.width / 2 - bounds.left, y2 = to.top - bounds.top;
        return x1 === x2 ? `M ${x1} ${y1} V ${y2}` : `M ${x1} ${y1} C ${x1} ${y1 + 16}, ${x2} ${y2 - 16}, ${x2} ${y2}`;
      });
      setPaths(previous => previous.height === bounds.height && previous.paths.join('|') === next.join('|') ? previous : { paths: next, height: bounds.height });
    };
    const observer = new ResizeObserver(measure); observer.observe(element);
    for (const node of element.querySelectorAll('[data-graph-node]')) observer.observe(node);
    measure(); return () => observer.disconnect();
  }, [plan]);
  if (!plan.nodes.length) return <Card><Row title="Nothing here yet" /></Card>;
  return <div ref={root} className="ho-loop-graph" data-mode={plan.mode} aria-label="Run graph">
    <svg className="ho-loop-graph-connectors" height={paths.height || plan.height} aria-hidden="true">
      <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M 1 1 L 6 4 L 1 7" /></marker></defs>
      {plan.edges.map((edge, index) => <path key={`${edge.from}:${edge.to}`} d={paths.paths[index] ?? edge.path} markerEnd={`url(#${marker})`} />)}
    </svg>
    <ol className="ho-loop-graph-list" aria-label="Passes">{iterations.map(iteration => <li key={iteration} className="ho-loop-graph-pass">
      <h3>Pass {iteration}</h3><ol aria-label={`Steps in pass ${iteration}`}>{plan.nodes.filter(node => node.iteration === iteration).map(node => {
        const step = detail.steps.find(step => step.iteration === node.iteration && step.stepId === node.stepId);
        const edge = plan.edges.find(edge => edge.from === node.id);
        const content = <><strong>{step?.botName ?? 'Agent'}</strong><span>{step?.role === 'maker' ? 'Maker' : step?.role === 'checker' ? 'Checker' : 'Step'} · {step?.status === 'completed' ? 'Complete' : step?.status === 'running' ? 'Working' : step?.status === 'failed' ? 'Failed' : 'Queued'}</span></>;
        return <li key={node.id} style={{ marginLeft: node.x, width: node.w, minHeight: node.h }}>
          {node.outputId ? <a className="ho-loop-graph-node" data-graph-node={node.id} href={outputHref({ id: node.outputId })}>{content}</a> : <div className="ho-loop-graph-node" data-graph-node={node.id}>{content}</div>}
          {edge && <div className="ho-loop-graph-then"><span>then · {edge.label}{edge.loopBack ? ' · next pass' : ''}</span></div>}
        </li>;
      })}</ol>
    </li>)}</ol>
  </div>;
}
export default RunGraph;

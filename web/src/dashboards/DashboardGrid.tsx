import type { CSSProperties, ReactNode } from 'react';
import { WidgetFrame } from './WidgetFrame';
import { Section } from '../components/layout';
import type { Widget, WidgetState } from './model';
export function DashboardGrid({ dashboardId, widgets, states, observe, refresh, toolbar, move }: { dashboardId?: string; move?(from: string, to: string): void; widgets: Widget[]; states: Record<string, WidgetState>; observe?: (id: string, node: HTMLElement | null) => void; refresh?: (id: string) => void; toolbar?: (widget: Widget, index: number) => ReactNode }) {
  return <div className={`dashboard-grid${toolbar ? ' dashboard-grid--editing' : ''}`}>
    {widgets.map((widget, index) => <Section className="dashboard-grid-slot" key={widget.id} onDragOver={event => { if (move && event.dataTransfer.types.includes('application/swarm-widget')) event.preventDefault(); }} onDrop={event => { event.preventDefault(); const from = event.dataTransfer.getData('application/swarm-widget'); if (from) move?.(from, widget.id); }} data-widget-kind={widget.type} data-widget-empty={isEmpty(widget, states[widget.id]) || undefined} data-widget-span={widget.span} data-widget-rows={widget.rows} style={{
      '--widget-span': Math.min(12, Math.max(1, widget.span)), '--widget-tablet-span': Math.min(6, Math.max(1, Math.ceil(widget.span / 2))),
      '--widget-phone-span': widget.span <= 4 ? 1 : 2, '--widget-small-span': widget.type === 'stat' && widget.span === 4 ? 2 : widget.span <= 4 ? 3 : 6, '--widget-rows': isEmpty(widget, states[widget.id]) ? 1 : Math.min(6, Math.max(1, widget.rows)),
    } as CSSProperties}><WidgetFrame dashboardId={dashboardId} widget={widget} state={states[widget.id]} observe={observe} retry={() => refresh?.(widget.id)} toolbar={toolbar?.(widget, index)} /></Section>)}
  </div>;
}

function isEmpty(widget: Widget, state?: WidgetState) {
  if (widget.type === 'note') return !String(widget.options.text ?? '').trim();
  if (!widget.source || state?.status !== 'ready' || !state.data || widget.type === 'stat') return false;
  if (widget.type === 'meter') return !state.data.value?.plan || !state.data.value.ownKeys;
  return state.data.available === false || Array.isArray(state.data.rows) && state.data.rows.length === 0;
}

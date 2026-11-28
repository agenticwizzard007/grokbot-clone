import type { CSSProperties, ReactNode } from 'react';
import { WidgetFrame } from './WidgetFrame';
import { Section } from '../components/layout';
import type { Widget, WidgetState } from './model';
import { statRowSpans } from './grid';
export function DashboardGrid({ dashboardId, widgets, states, observe, refresh, toolbar, move }: { dashboardId?: string; move?(from: string, to: string): void; widgets: Widget[]; states: Record<string, WidgetState>; observe?: (id: string, node: HTMLElement | null) => void; refresh?: (id: string) => void; toolbar?: (widget: Widget, index: number) => ReactNode }) {
  const spans = (columns: number, span: (widget: Widget) => number) => {
    const values = widgets.map(span);
    return toolbar ? values : statRowSpans(widgets, values, columns);
  };
  const desktop = spans(12, w => Math.min(12, Math.max(1, w.span)));
  const tablet = spans(6, w => Math.min(6, Math.max(1, Math.ceil(w.span / 2))));
  const phone = spans(2, w => w.type === 'stat' || w.span > 4 ? 2 : 1);
  const small = spans(6, w => w.type === 'stat' && w.span === 4 ? 2 : w.span <= 4 ? 3 : 6);
  return <div className={`dashboard-grid${toolbar ? ' dashboard-grid--editing' : ''}`}>
    {widgets.map((widget, index) => <Section className="dashboard-grid-slot" key={widget.id} onDragOver={event => { if (move && event.dataTransfer.types.includes('application/swarm-widget')) event.preventDefault(); }} onDrop={event => { event.preventDefault(); const from = event.dataTransfer.getData('application/swarm-widget'); if (from) move?.(from, widget.id); }} data-widget-kind={widget.type} data-widget-empty={isEmpty(widget, states[widget.id]) || undefined} data-widget-span={widget.span} data-widget-rows={widget.rows} style={{
      '--widget-span': desktop[index], '--widget-tablet-span': tablet[index],
      '--widget-phone-span': phone[index], '--widget-small-span': small[index], '--widget-rows': isEmpty(widget, states[widget.id]) ? 1 : Math.min(6, Math.max(1, widget.rows)),
    } as CSSProperties}><WidgetFrame dashboardId={dashboardId} widget={widget} state={states[widget.id]} observe={observe} retry={() => refresh?.(widget.id)} toolbar={toolbar?.(widget, index)} /></Section>)}
  </div>;
}

function isEmpty(widget: Widget, state?: WidgetState) {
  if (widget.type === 'note') return !String(widget.options.text ?? '').trim();
  if (!widget.source || state?.status !== 'ready' || !state.data || widget.type === 'stat') return false;
  if (widget.type === 'meter') return !state.data.value?.plan || !state.data.value.ownKeys;
  return state.data.available === false || Array.isArray(state.data.rows) && state.data.rows.length === 0;
}

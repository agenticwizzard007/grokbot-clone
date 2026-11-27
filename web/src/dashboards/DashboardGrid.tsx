import type { CSSProperties, ReactNode } from 'react';
import { WidgetFrame } from './WidgetFrame';
import type { Widget, WidgetState } from './model';
export function DashboardGrid({ widgets, states, observe, refresh, toolbar }: { widgets: Widget[]; states: Record<string, WidgetState>; observe?: (id: string, node: HTMLElement | null) => void; refresh?: (id: string) => void; toolbar?: (widget: Widget, index: number) => ReactNode }) {
  return <div className={`dashboard-grid${toolbar ? ' dashboard-grid--editing' : ''}`}>
    {widgets.map((widget, index) => <div className="dashboard-grid-slot" key={widget.id} data-widget-span={widget.span} data-widget-rows={widget.rows} style={{
      '--widget-span': Math.min(12, Math.max(1, widget.span)), '--widget-tablet-span': Math.min(6, Math.max(1, Math.ceil(widget.span / 2))),
      '--widget-phone-span': widget.span <= 4 ? 1 : 2, '--widget-rows': Math.min(6, Math.max(1, widget.rows)),
    } as CSSProperties}><WidgetFrame widget={widget} state={states[widget.id]} observe={observe} retry={() => refresh?.(widget.id)} toolbar={toolbar?.(widget, index)} /></div>)}
  </div>;
}

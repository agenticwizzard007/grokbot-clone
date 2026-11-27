import { useCallback, type ReactNode } from 'react';
import { Card } from '../components/layout';
import { widgetLabel, type Widget, type WidgetState } from './model';
import { AgentWidget } from './agent/AgentWidget';
import Stat from './widgets/Stat';
import List from './widgets/List';
import Table from './widgets/Table';
import Chart from './widgets/Chart';
import Meter from './widgets/Meter';
import BotStatus from './widgets/BotStatus';
import TaskBoard from './widgets/TaskBoard';
import RoutineSchedule from './widgets/RoutineSchedule';
import Note from './widgets/Note';
import Shortcuts from './widgets/Shortcuts';
const renderers = { stat: Stat, list: List, table: Table, chart: Chart, meter: Meter, botStatus: BotStatus, taskBoard: TaskBoard, routineSchedule: RoutineSchedule, note: Note, shortcuts: Shortcuts };
export function WidgetFrame({ dashboardId, widget, state, observe, retry, toolbar }: { dashboardId?: string; widget: Widget; state?: WidgetState; observe?: (id: string, node: HTMLElement | null) => void; retry?: () => void; toolbar?: ReactNode }) {
  const attach = useCallback((node: HTMLDivElement | null) => observe?.(widget.id, node), [widget.id, observe]);
  const current = state ?? (widget.source ? { status: 'loading' as const } : { status: 'ready' as const });
  if (widget.type === 'agent') return <div ref={attach} className="dashboard-widget-cell" data-widget-id={widget.id} data-widget-type="agent"><AgentWidget dashboardId={dashboardId ?? ''} widget={widget} toolbar={toolbar} /></div>;
  const title = widgetLabel(widget), Renderer = renderers[widget.type];
  return <div ref={attach} className="dashboard-widget-cell" data-widget-id={widget.id} data-widget-type={widget.type} data-widget-state={current.status}>
    <Card className={`dashboard-widget dashboard-widget--${widget.type}`} role="region" aria-labelledby={`title-${widget.id}`} aria-busy={current.status === 'loading' || current.refreshing || undefined}>
      <div className="dashboard-widget-header"><h2 id={`title-${widget.id}`} tabIndex={-1}>{title}</h2>{toolbar}</div>
      <div className={`dashboard-widget-body${widget.type === 'table' ? ' dashboard-widget-body--scroll' : ''}`}>
        {current.data?.available === false && ['connectors.status', 'email.recent', 'calendar.upcoming', 'crm.deals'].includes(widget.source?.id ?? '') ? <div className="dashboard-empty-data"><p>Connect an app to see your data.</p><a className="btn btn--secondary" href="#settings/apps">Connect</a></div> : current.status === 'loading' ? <div className="dashboard-skeleton" role="status" aria-label={`Loading ${title}`}><i /><i /><i /></div>
          : <>{current.status === 'error' && <div className="dashboard-widget-error"><p role="status">{current.error ?? 'Data is unavailable.'}</p><button type="button" className="btn btn--secondary" onClick={retry} aria-label={`Retry ${title}`}>Retry</button></div>}
            {(current.status !== 'error' || current.data) && <Renderer widget={widget} data={current.data} />}</>}
      </div>
    </Card>
  </div>;
}

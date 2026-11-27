import { useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import type { AgentWidgetResult, WidgetAction } from '@shared/ui-config';
import { ButtonGroup, Card, Section } from '../../components/layout';
import { prefillComposer } from '../../components/Composer';
import { navigation, openConversation } from '../../configStore';
import { useStore } from '../../store';
import { DashboardDialog } from '../Dialog';
import { widgetLabel, type Widget } from '../model';
import { useAgentWidget } from './useAgentWidget';
import { actionLabel, emptyAnswer, openActionScreen, updatedCaption } from './model';
export function AgentWidget({ dashboardId, widget }: { dashboardId: string; widget: Widget }) {
  const state = useAgentWidget(dashboardId, widget.id), title = widgetLabel(widget);
  const [confirm, setConfirm] = useState<{ action: WidgetAction; title: string }>(), [busy, setBusy] = useState(false), [actionError, setActionError] = useState('');
  const [approved, setApproved] = useState<string[]>([]), [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);
  const act = async (action: WidgetAction, confirmed = false) => {
    if (busy) return;
    setBusy(true); setActionError('');
    try {
      await state.action(action, confirmed);
      if (action.type === 'open') { const screen = openActionScreen(action); if (!screen) throw new Error('This destination is unavailable.'); navigation.navigate(screen); }
      if (action.type === 'send') { if (!useStore.getState().bots.some(bot => bot.id === action.botId)) throw new Error('This Bot is unavailable.'); prefillComposer(action.botId, action.text); openConversation(action.botId); }
      if (action.type === 'approve') { setApproved(items => [...items, action.itemId]); setConfirm(undefined); await state.refresh(); }
    } catch (e) { setActionError(e instanceof Error ? e.message : 'Could not complete this action. Try again.'); }
    finally { setBusy(false); }
  };
  const rowAction = (action: WidgetAction, rowTitle: string) => action.type === 'approve' && approved.includes(action.itemId) ? <span className="dashboard-caption" role="status">Approved</span> : <button type="button" className="btn btn--secondary" disabled={busy} aria-label={`${actionLabel(action)}: ${rowTitle}`} onClick={() => { setActionError(''); if (action.type === 'approve') setConfirm({ action, title: rowTitle }); else void act(action); }}>{actionLabel(action)}</button>;
  const doc = state.snapshot?.doc ?? null;
  return <Card className="dashboard-widget dashboard-widget--agent" role="region" aria-labelledby={`title-${widget.id}`} aria-busy={state.running || state.loading || undefined}>
    <div className="dashboard-agent-header"><h2 id={`title-${widget.id}`} tabIndex={-1}>{title}</h2><button type="button" className="btn btn--secondary" aria-label={`Refresh ${title}`} title="Refresh" disabled={state.running || state.loading} onClick={() => void state.run()}><RefreshCw size={18} aria-hidden /></button></div>
    {state.snapshot?.runAt != null && <p className="dashboard-caption">{updatedCaption(state.snapshot.runAt, now)}</p>}
    {state.running && <p className="dashboard-agent-state" role="status"><LoaderCircle size={16} className="spin" aria-hidden />Working</p>}
    {state.loading && !doc && <p role="status">Loading answer...</p>}
    {(state.error || state.snapshot?.state === 'error') && <div className="dashboard-empty-data"><p role="alert">{state.error || 'Could not read the answer. Try again.'}</p><button className="btn btn--secondary" disabled={state.running} onClick={() => void state.run()}>Try again</button></div>}
    {!state.loading && !state.error && state.snapshot?.state !== 'error' && !state.running && emptyAnswer(doc) && <div className="dashboard-empty-data"><p>No answer yet</p><button className="btn btn--secondary" onClick={() => void state.run()}>Run</button></div>}
    {doc && <div className={`dashboard-widget-body${doc.kind === 'list' ? ' dashboard-widget-body--scroll' : ''}`}><AgentAnswer doc={doc} action={rowAction} /></div>}
    {actionError && !confirm && <p role="alert">{actionError}</p>}
    {confirm && <DashboardDialog title="Approve item" close={() => { if (!busy) setConfirm(undefined); }}><Section><p>{confirm.title}</p>{actionError && <p role="alert">{actionError}</p>}<ButtonGroup><button type="button" className="btn btn--secondary" disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</button><button type="button" className="btn btn--primary" disabled={busy} onClick={() => void act(confirm.action, true)}>Approve</button></ButtonGroup></Section></DashboardDialog>}
  </Card>;
}
function AgentAnswer({ doc, action }: { doc: AgentWidgetResult; action(action: WidgetAction, title: string): React.ReactNode }) {
  if (doc.kind === 'text') return <p className="dashboard-agent-answer">{doc.text}</p>;
  if (doc.kind === 'stat') return <div><output className="dashboard-agent-stat">{doc.value}</output><p>{doc.label}</p>{doc.delta && <p className="dashboard-caption">{doc.delta}</p>}</div>;
  return <ul className="dashboard-agent-list">{doc.rows.map((row, index) => <li key={index}><div className="dashboard-agent-row-text"><strong>{row.title}</strong>{row.subtitle && <span className="dashboard-caption">{row.subtitle}</span>}{row.status && <span className="dashboard-caption">{row.status}</span>}</div>{row.action && action(row.action, row.title)}</li>)}</ul>;
}

import { Card as LayoutCard } from '../layout';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LabelWords } from '../ProviderMark';
import type { Bot, Task } from '@shared/types';
import type { NeedsYouItem } from '../../lib/api';
import { queueImportedSetup } from '../../lib/setupApi';
import { scrollToRow } from '../../lib/scrollToRow';
import { relativeShort } from '../../lib/time';
import { openConversation, useConfigUI } from '../../configStore';
import { botSlug, type WorkTab } from '../../lib/userRoutes';
import { useStore } from '../../store';
import { needsYouChip } from './settingsLogic';
import type { ReportLocation } from './WorkReports';
import { openWorkChat } from './workScope';
import { useNeedsYou, useTasks } from './taskData';
import './ui';
import './workArea.css';
import '@fontsource-variable/instrument-sans/wght.css';
import '../../styles/tasks.css';

/** Optional task response enrichment supplied by the handoff service. */
export type HandoffTask = Task & { handoff?: { loopId?: string; handoffId?: string; kind: 'loop' | 'gate' | 'receiver' } };
const HandoffEnabled = createContext(false);

export function TaskHandoffProvider({ children }: { children: ReactNode }) {
  const userId = useStore(s => s.user?.id);
  const [enabledFor, setEnabledFor] = useState<string>();
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    fetch('/api/handoff-settings', { credentials: 'include', signal: controller.signal })
      .then(async response => response.ok ? response.json() : undefined)
      .then(result => { if (!controller.signal.aborted && (result?.settings ?? result)?.enabled === true) setEnabledFor(userId); })
      .catch(() => {});
    return () => controller.abort();
  }, [userId]);
  return <HandoffEnabled.Provider value={!!userId && enabledFor === userId}>{children}</HandoffEnabled.Provider>;
}

/** Public launch contract for the shared HO-D sheet. The feature stays hidden until that module ships. */
const sendSheets = import.meta.glob('../../handoffs/SendSheet.tsx');
type SheetProps = { source: { taskId: string }; fromBotId: string; title: string; onClose: () => void; onSent?: () => void };
type SendSheetComponent = (props: SheetProps) => ReactNode;

export function TaskActions({ task, bot }: { task: HandoffTask; bot?: Bot }) {
  const enabled = useContext(HandoffEnabled);
  const [Sheet, setSheet] = useState<SendSheetComponent>();
  const [error, setError] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const open = async () => {
    if (loading) return;
    setLoading(true); setError(false); setReceipt(false);
    try {
      const module = await sendSheets['../../handoffs/SendSheet.tsx']() as { SendSheet: SendSheetComponent };
      if (alive.current) setSheet(() => module.SendSheet);
    } catch { if (alive.current) setError(true); }
    finally { if (alive.current) setLoading(false); }
  };
  const close = () => { setSheet(undefined); opener.current?.focus(); };
  if (!enabled) return null;
  return <div style={{ display: 'grid', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
    {task.handoff?.loopId && <><span className="pb-pill" style={{ justifySelf: 'start' }}>Loop</span><a className="cfg-btn cfg-btn--secondary" href={`#loop/${encodeURIComponent(task.handoff.loopId)}`}>View</a></>}
    {!task.handoff?.loopId && task.handoff?.handoffId && <a className="cfg-btn cfg-btn--secondary" href={`#handoff/${encodeURIComponent(task.handoff.handoffId)}`}>View</a>}
    {task.state === 'done' && bot && bot.kind !== 'room' && sendSheets['../../handoffs/SendSheet.tsx'] && <button ref={opener} type="button" className="cfg-btn cfg-btn--secondary" disabled={loading} onClick={open}>Send to agent</button>}
    {error && <p role="alert">Could not open Send to agent. Try again.</p>}
    {receipt && <p role="status">Sent to agent.</p>}
    {Sheet && bot && <Sheet source={{ taskId: task.id }} fromBotId={bot.id} title={task.title} onClose={close} onSent={() => { close(); setReceipt(true); }} />}
  </div>;
}

export type Filter = 'all' | 'open' | Task['state'];
export type WorkContext = { filter: Filter; caller?: string; report?: ReportLocation };
const defaultContext: WorkContext = { filter: 'all' };
export let workContext = defaultContext;
useStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) workContext = defaultContext;
});
export const STATES = ['needs_input', 'working', 'done'] as const;
export const STATUS = {
  needs_input: { label: 'Pending', chip: 'Needs you', action: 'Reply in chat' },
  working: { label: 'In progress', chip: 'In progress', action: 'View progress' },
  done: { label: 'Done', chip: 'Completed', action: 'View result' },
};

function when(t: Task): string {
  const r = relativeShort(t.updatedAt);
  return r === 'now' ? 'Just now' : r === 'Yesterday' ? 'Yesterday' : `${r} ago`;
}

function TaskTitle({ title }: { title: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    const measure = () => {
      context.font = getComputedStyle(element).font;
      setCompact(title.split(/\s+/).some(word => context.measureText(word).width > element.clientWidth));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [title]);
  return <span ref={ref} className="task-card__title"><LabelWords>{compact ? 'Task details' : title}</LabelWords></span>;
}

export function TaskCard({ task, bot, compact = false }: { task: HandoffTask; bot?: Bot; compact?: boolean }) {
  const status = STATUS[task.state];
  return (
    <LayoutCard className="task-card-frame"><button type="button" className={`task-card is-${task.state}${compact ? ' is-compact' : ''}`} onClick={() => bot && (task.handoff?.loopId ? window.location.assign(`#loop/${encodeURIComponent(task.handoff.loopId)}`) : openWorkChat(bot.id))} disabled={!bot} title={`${task.title}. ${task.state === 'done' ? 'Completed' : 'Updated'} ${when(task)} (${new Date(task.updatedAt).toLocaleString()})`}
      aria-label={`${task.title}: ${status.label}. ${bot ? `${status.action} with ${bot.name}` : 'Bot unavailable'}`}>

      <span className="task-card__body">
        <TaskTitle title={task.title} />
        <span className="task-card__note">{bot && <BotAvatarFor bot={bot} size={20} />}{bot?.name ?? 'Bot unavailable'}</span>

      </span>

    </button><TaskActions task={task} bot={bot} /></LayoutCard>
  );
}

/** Open the place where a needs-you item is answered: setup reviews in the Bot's Setup tab, cards in its chat. */
export function openNeedsYou(item: NeedsYouItem) {
  const store = useStore.getState();
  if (!store.bots.some(bot => bot.id === item.botId)) return;
  if (item.type === 'setup_review' && store.user) queueImportedSetup(store.user.id, item.botId);
  openConversation(item.botId);
  if (item.type === 'setup_review' && !store.mobile) useStore.getState().set({ detailsOpen: true });
  if (item.seq != null && item.type !== 'setup_review') scrollToRow(item.seq);
}

export function NeedsYouCard({ item, bot, compact = false }: { item: NeedsYouItem; bot?: Bot; compact?: boolean }) {
  const kind = needsYouChip(item.type);
  const action = item.type === 'setup_review' ? 'Review setup' : item.type === 'approval' ? 'Review approval' : item.type === 'connect' ? 'Connect in chat' : 'Reply in chat';
  const name = bot?.name ?? item.botName ?? 'Bot unavailable';
  return (
    <LayoutCard className="task-card-frame"><button type="button" className={`task-card is-needs_input is-attention${compact ? ' is-compact' : ''}`} onClick={() => openNeedsYou(item)} disabled={!bot}
      title={`Waiting since ${new Date(item.createdAt).toLocaleString()}`} aria-label={`${item.title}. ${kind}. ${bot ? `${action} with ${name}` : 'Bot unavailable'}`}>

      <span className="task-card__body">
        <TaskTitle title={item.title} />
        <span className="task-card__note">{bot && <BotAvatarFor bot={bot} size={20} />}{name}</span>

      </span>

    </button></LayoutCard>
  );
}

export function sortTasks(list: Task[]) {
  const rank = { needs_input: 0, working: 1, done: 2 } as const;
  return [...list].sort((a, b) => rank[a.state] - rank[b.state] || (a.state === 'needs_input' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt));
}

export function TaskError({ retry, stale }: { retry: () => void; stale: boolean }) {
  return <div className={`tasks-error${stale ? ' is-stale' : ''}`} role="alert"><div className="tasks-error__copy"><strong>{stale ? 'Tasks couldn’t refresh.' : 'Tasks couldn’t load.'}</strong><span>{stale ? 'Showing the last update.' : 'Please try again.'}</span></div><button className="work-button" type="button" onClick={retry}>Retry</button></div>;
}

export function AttentionStatus({ attention }: { attention: ReturnType<typeof useNeedsYou> }) {
  if (attention.error) return <div className={`tasks-error${attention.items !== null ? ' is-stale' : ''}`} role="alert">
    <div className="tasks-error__copy"><strong>Pending input could not {attention.items !== null ? 'refresh' : 'load'}.</strong><span>{attention.items !== null ? 'Showing the last update. Pending input may be out of date.' : 'Approvals, setup reviews and questions may be missing.'}</span></div>
    <button className="work-button" type="button" onClick={attention.retry} disabled={attention.loading}>{attention.loading ? 'Retrying...' : 'Retry pending input'}</button>
  </div>;
  if (attention.items === null) return <div className="tasks-loading" role="status">Loading pending input...</div>;
  return null;
}

/** The same task states remain visible in each bot’s details panel. */
export function BotTasks({ bot }: { bot: Bot }) {
  return <TaskHandoffProvider><BotTasksContent bot={bot} /></TaskHandoffProvider>;
}

function BotTasksContent({ bot }: { bot: Bot }) {
  const { tasks, error, retry } = useTasks(bot.id);
  const attention = useNeedsYou(bot.id);
  const waitingItems = attention.items ?? [];
  const sorted = useMemo(() => sortTasks(tasks ?? []), [tasks]);
  const openWorkspace = (tab: WorkTab, botId?: string) => {
    workContext = { filter: 'all', caller: bot.id };
    useConfigUI.getState().setWorkRoute({ tab, ...(botId ? { botSlug: botSlug(bot) } : {}) });
    useConfigUI.getState().setView('tasks');
  };
  return (
    <div className="details__sections"><section>
      <div className="section-label section-label--row"><span>Tasks</span><button type="button" className="link-btn link-btn--small" onClick={() => openWorkspace('Tasks', bot.id)}>See all tasks</button></div>
      {error && <TaskError retry={retry} stale={tasks !== null} />}
      <AttentionStatus attention={attention} />
      {tasks === null && !waitingItems.length ? (!error && <div className="panel-card"><div className="panel-empty" role="status">Loading…</div></div>) : sorted.length + waitingItems.length === 0 && attention.items !== null && !attention.error ? <div className="panel-card"><div className="panel-empty">No tasks yet. Ask {bot.name} for a few things at once and they’ll be tracked here.</div></div> : <div className="bot-task-cards">{waitingItems.map((item) => <NeedsYouCard key={`${item.type}:${item.id}`} item={item} bot={bot} compact />)}{sorted.map((t) => <TaskCard key={t.id} task={t} bot={bot} compact />)}</div>}
    </section><section className="work-row"><h3>Goals and workflows</h3><p className="work-meta">Plan and review work for {bot.name}.</p><button type="button" className="work-button" onClick={() => openWorkspace('Goals', bot.id)}>Goals and workflows</button></section></div>
  );
}

export function setWorkContext(context: WorkContext) { workContext = context; }

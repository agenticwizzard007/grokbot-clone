import { Card as LayoutCard } from '../layout';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { ArrowRight, Repeat2, Send } from 'lucide-react';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { LabelWords } from '../ProviderMark';
import type { Bot, Task } from '@shared/types';
import type { NeedsYouItem } from '../../lib/api';
import { queueImportedSetup } from '../../lib/setupApi';
import { scrollToRow } from '../../lib/scrollToRow';
import { relativeShort } from '../../lib/time';
import { openConversation, useConfigUI, useVersion } from '../../configStore';
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
const HandoffEnabled = createContext<{ enabled: boolean; links: Record<string, NonNullable<HandoffTask['handoff']>> }>({ enabled: false, links: {} });

export function TaskHandoffProvider({ children }: { children: ReactNode }) {
  const userId = useStore(s => s.user?.id);
  const [enabledFor, setEnabledFor] = useState<string>();
  const [linkSnapshot, setLinkSnapshot] = useState<{ userId: string; links: Record<string, NonNullable<HandoffTask['handoff']>> }>();
  const version = useVersion('tasks');
  const connected = useStore(s => s.sseConnected);
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    fetch('/api/handoff-settings', { credentials: 'include', signal: controller.signal })
      .then(async response => response.ok ? response.json() : undefined)
      .then(async result => {
        if (controller.signal.aborted) return;
        const enabled = (result?.settings ?? result)?.enabled === true;
        setEnabledFor(enabled ? userId : undefined);
        if (!enabled) { setLinkSnapshot(undefined); return; }
        const response = await fetch('/api/handoff-task-links', { credentials: 'include', signal: controller.signal });
        if (response.ok) {
          const data = await response.json();
          if (!controller.signal.aborted) setLinkSnapshot({ userId, links: data.links ?? {} });
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [userId, version, connected]);
  return <HandoffEnabled.Provider value={{ enabled: !!userId && enabledFor === userId, links: linkSnapshot && enabledFor === userId && linkSnapshot.userId === userId ? linkSnapshot.links : {} }}>{children}</HandoffEnabled.Provider>;
}

export function TaskLoopsLink() {
  const { enabled } = useContext(HandoffEnabled);
  return enabled ? <a className="cfg-btn cfg-btn--secondary" href="#loops">Loops</a> : null;
}

/** Public launch contract for the shared HO-D sheet. The feature stays hidden until that module ships. */
const sendSheets = import.meta.glob('../../handoffs/SendSheet.tsx');
type SheetProps = { open: boolean; source: { taskId: string }; senderId: string; title: string; onClose: () => void; onSent: (handoff: { id: string }, target: { name: string }) => void };
type SendSheetComponent = (props: SheetProps) => ReactNode;

export function TaskActions({ task, bot }: { task: HandoffTask; bot?: Bot }) {
  const { enabled, links } = useContext(HandoffEnabled);
  const handoff = links[task.id] ?? task.handoff;
  const [Sheet, setSheet] = useState<SendSheetComponent>();
  const [error, setError] = useState(false);
  const [receipt, setReceipt] = useState<{ id: string; name: string }>();
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  const opener = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (Sheet || !restoreFocus.current) return;
    restoreFocus.current = false;
    opener.current?.focus();
  }, [Sheet]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const open = async () => {
    if (loading) return;
    setLoading(true); setError(false); setReceipt(undefined);
    try {
      const module = await sendSheets['../../handoffs/SendSheet.tsx']() as { SendSheet: SendSheetComponent };
      if (alive.current) setSheet(() => module.SendSheet);
    } catch { if (alive.current) setError(true); }
    finally { if (alive.current) setLoading(false); }
  };
  const close = () => { restoreFocus.current = true; setSheet(undefined); };
  if (!enabled) return null;
  return <div className="task-secondary-actions">
    {handoff?.loopId && <a className="task-secondary-action" href={`#loop/${encodeURIComponent(handoff.loopId)}`}><Repeat2 size={14} aria-hidden />View loop</a>}
    {!handoff?.loopId && handoff?.handoffId && <a className="task-secondary-action" href={`#handoff/${encodeURIComponent(handoff.handoffId)}`}>View handoff</a>}
    {task.state === 'done' && bot && bot.kind !== 'room' && sendSheets['../../handoffs/SendSheet.tsx'] && <button ref={opener} type="button" className="task-secondary-action" disabled={loading} onClick={open}><Send size={14} aria-hidden />{loading ? 'Opening…' : 'Send to agent'}</button>}
    {error && <p role="alert">Could not open Send to agent. Try again.</p>}
    {receipt && <p role="status">Sent to {receipt.name}. <a href={`#handoff/${encodeURIComponent(receipt.id)}`}>View</a></p>}
    {Sheet && bot && <Sheet open source={{ taskId: task.id }} senderId={bot.id} title={task.title} onClose={close} onSent={(handoff, target) => { setReceipt({ id: handoff.id, name: target.name }); }} />}
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
  needs_input: { label: 'Needs input', chip: 'Needs you', action: 'Reply in chat' },
  working: { label: 'In progress', chip: 'In progress', action: 'View progress' },
  done: { label: 'Done', chip: 'Completed', action: 'View result' },
};

function when(t: Pick<Task, 'updatedAt'>): string {
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
    <LayoutCard className={`task-card-frame is-${task.state}`}><button type="button" className={`task-card is-${task.state}${compact ? ' is-compact' : ''}`} onClick={() => bot && openWorkChat(bot.id)} disabled={!bot} title={`${task.title}. ${task.state === 'done' ? 'Completed' : 'Updated'} ${when(task)} (${new Date(task.updatedAt).toLocaleString()})`}
      aria-description={`${task.title}. ${status.label}. ${bot ? `${status.action} with ${bot.name}` : 'Bot unavailable'}`}>

      <span className="task-card__body">
        <TaskTitle title={task.title} />
        {task.state === 'needs_input' && task.note && <span className="task-card__description">{task.note}</span>}
        <span className="task-card__meta"><span className="task-card__note">{bot && <BotAvatarFor bot={bot} size={20} />}<span>{bot?.name ?? 'Bot unavailable'}</span></span><time dateTime={new Date(task.updatedAt).toISOString()}>{when(task)}</time></span>

      </span>
      <span className="task-card__cta"><span>{bot ? status.action : 'Bot unavailable'}</span>{bot && <ArrowRight size={16} aria-hidden />}</span>
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
    <LayoutCard className="task-card-frame is-needs_input"><button type="button" className={`task-card is-needs_input is-attention${compact ? ' is-compact' : ''}`} onClick={() => openNeedsYou(item)} disabled={!bot}
      title={`Waiting since ${new Date(item.createdAt).toLocaleString()}`} aria-description={`${item.title}. ${kind}. ${bot ? `${action} with ${name}` : 'Bot unavailable'}`}>

      <span className="task-card__body">
        <TaskTitle title={item.title} />
        <span className="task-card__description">{kind}</span>
        <span className="task-card__meta"><span className="task-card__note">{bot && <BotAvatarFor bot={bot} size={20} />}<span>{name}</span></span><time dateTime={new Date(item.createdAt).toISOString()}>{when({ updatedAt: item.createdAt })}</time></span>

      </span>
      <span className="task-card__cta"><span>{bot ? action : 'Bot unavailable'}</span>{bot && <ArrowRight size={16} aria-hidden />}</span>
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

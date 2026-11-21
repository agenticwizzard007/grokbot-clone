import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Menu, RefreshCw } from 'lucide-react';
import type { Bot, Task } from '@shared/types';
import { configApi } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useConfigUI, useVersion } from '../../configStore';
import { backToList, useStore } from '../../store';
import { Glyph } from './glyphs';
import { TeamBoard } from './TeamBoard';
import { WorkflowsPanel } from './WorkflowsPanel';
import { WorkReports, type ReportLocation } from './WorkReports';
import { openWorkChat, workBotKey } from './workScope';
import './ui';
import './workArea.css';
import '@fontsource-variable/instrument-sans/wght.css';
import '../../styles/tasks.css';

type Filter = 'all' | Task['state'];
type WorkTab = 'Tasks' | 'Team' | 'Goals' | 'Reports';
type WorkContext = { tab: WorkTab; botId?: string; filter: Filter; caller?: string; report?: ReportLocation };
const TABS: WorkTab[] = ['Tasks', 'Team', 'Goals', 'Reports'];
const defaultContext: WorkContext = { tab: 'Tasks', filter: 'all' };
let workContext = defaultContext;
useStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) workContext = defaultContext;
});
const STATES = ['needs_input', 'working', 'done'] as const;
const STATUS = {
  needs_input: { label: 'Pending', chip: 'Needs you', action: 'Reply in chat' },
  working: { label: 'In progress', chip: 'In progress', action: 'View progress' },
  done: { label: 'Done', chip: 'Completed', action: 'View result' },
};

function when(t: Task): string {
  const r = relativeShort(t.updatedAt);
  return r === 'now' ? 'Just now' : r === 'Yesterday' ? 'Yesterday' : `${r} ago`;
}

function TaskCard({ task, bot, compact = false }: { task: Task; bot?: Bot; compact?: boolean }) {
  const status = STATUS[task.state];
  const note = task.note || (task.state === 'needs_input' ? 'Open chat to see what your bot needs.' : task.state === 'done' ? 'Open chat to see the result.' : 'Your bot is working on this task.');
  return (
    <button type="button" className={`task-card is-${task.state}${compact ? ' is-compact' : ''}`} onClick={() => bot && openWorkChat(bot.id)} disabled={!bot} title={`${task.state === 'done' ? 'Completed' : 'Updated'} ${when(task)} (${new Date(task.updatedAt).toLocaleString()})`}
      aria-label={`${task.title} — ${status.label}. ${bot ? `${status.action} with ${bot.name}` : 'Bot unavailable'}`}>
      <span className="task-card__top">
        <span className={`task-status is-${task.state}`}>{status.chip}</span>
      </span>
      <span className="task-card__body">
        <span className="task-card__title">{task.title}</span>
        <span className="task-card__note">{bot?.name ?? 'Bot unavailable'} · {note}</span>
        <span className="task-card__row-status">{status.chip}</span>
      </span>
      <span className="task-card__footer">
        {bot && <span className="task-card__action">{status.action}</span>}
      </span>
    </button>
  );
}

function useTasks(botId?: string, available = true) {
  const userId = useStore(s => s.user?.id);
  const generation = useStore(s => s.bots.find(bot => bot.id === botId)?.generation);
  const scope = JSON.stringify([userId, botId, generation]);
  const version = useVersion(botId ? `tasks:${botId}` : 'tasks');
  const connected = useStore((s) => s.sseConnected);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ scope: string; tasks: Task[] | null; error: boolean }>();
  useEffect(() => {
    if (!userId || !available) return;
    let alive = true;
    (botId ? configApi.botTasks(botId) : configApi.tasks()).then((r) => {
      if (alive && useStore.getState().user?.id === userId) setResult({ scope, tasks: r.tasks.filter(task => !botId || task.botId === botId), error: false });
    }).catch(() => {
      if (alive) setResult((prev) => ({ scope, tasks: prev?.scope === scope ? prev.tasks : null, error: true }));
    });
    return () => { alive = false; };
  }, [userId, botId, scope, available, version, attempt, connected]);
  const retry = () => {
    setResult((prev) => prev && ({ ...prev, error: false }));
    setAttempt((n) => n + 1);
  };
  return { tasks: available && result?.scope === scope ? result.tasks : null, error: available && result?.scope === scope && result.error, retry };
}

function sortTasks(list: Task[]) {
  const rank = { needs_input: 0, working: 1, done: 2 } as const;
  return [...list].sort((a, b) => rank[a.state] - rank[b.state] || (a.state === 'needs_input' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt));
}

function TaskError({ retry, stale }: { retry: () => void; stale: boolean }) {
  return <div className={`tasks-error${stale ? ' is-stale' : ''}`} role="alert"><div className="tasks-error__copy"><strong>{stale ? 'Tasks couldn’t refresh.' : 'Tasks couldn’t load.'}</strong><span>{stale ? 'Showing the last update.' : 'Please try again.'}</span></div><button className="work-button" type="button" onClick={retry}>Retry</button></div>;
}

/** Responsive board: status columns on wide screens, grouped cards on phones. */
export function TasksView() {
  const userId = useStore(s => s.user?.id);
  return <WorkWorkspace key={userId} />;
}

function WorkWorkspace() {
  const bots = useStore((s) => s.bots);
  const userId = useStore(s => s.user?.id);
  const connected = useStore((s) => s.sseConnected);
  const mobile = useStore((s) => s.mobile);
  const [context, setContext] = useState(workContext);
  const [childHeading, setHeading] = useState<{ title: string; subtitle: string; detail?: boolean }>();
  const scroll = useRef<HTMLDivElement>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const { tab, filter, botId: botFilter, caller } = context;
  const updateContext = (patch: Partial<WorkContext>) => {
    workContext = { ...workContext, ...('botId' in patch && patch.botId !== botFilter ? { report: undefined } : {}), ...patch };
    setContext(workContext);
    if (patch.tab && patch.tab !== tab) setHeading(undefined);
  };
  const setFilter = (next: Filter) => updateContext({ filter: next });
  const selectedBot = bots.find((b) => b.id === botFilter);
  const unavailable = !!botFilter && !selectedBot;
  const heading = unavailable ? undefined : childHeading;
  const primary = bots.find(bot => bot.isPrimary && bot.kind !== 'room');
  const scopeLabel = selectedBot?.name ?? (unavailable ? 'Bot unavailable' : 'All bots');
  const title = heading?.title ?? (tab === 'Team' ? (primary ? `${primary.name}’s board` : 'Team board') : tab === 'Goals' ? 'Goals and workflows' : tab === 'Reports' ? 'Saved reports' : 'Tasks');
  const subtitle = heading ? (tab === 'Reports' ? heading.subtitle : `${scopeLabel} · ${heading.subtitle}`) : tab === 'Team' ? `${scopeLabel} · Owners, dependencies and evidence from current team records.` : tab === 'Goals' ? `${scopeLabel} · Keep work running across turns and verify results against acceptance checks.` : `${scopeLabel} · Download saved reports, save in Library or review where they will be sent.`;
  const { tasks, error, retry } = useTasks(botFilter, !unavailable && tab === 'Tasks');
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const scoped = useMemo(() => sortTasks((tasks ?? []).filter((t) => !selectedBot || t.botId === selectedBot.id)), [tasks, selectedBot]);
  const counts = useMemo(() => ({ all: scoped.length, needs_input: scoped.filter((t) => t.state === 'needs_input').length, working: scoped.filter((t) => t.state === 'working').length, done: scoped.filter((t) => t.state === 'done').length }), [scoped]);
  const shownStates = filter === 'all' ? STATES.filter(state => counts[state] > 0) : [filter];
  const empty = tasks !== null && counts[filter] === 0;
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [tab, heading?.title]);
  useLayoutEffect(() => { if (heading?.detail) pageHeading.current?.focus({ preventScroll: true }); }, [heading?.detail]);

  return (
    <main className="chat tasks-view" aria-labelledby="tasks-heading">
      {(mobile || caller) && <header className="tasks-view__header">
        <button type="button" className="icon-btn" onClick={() => { if (caller && bots.some(bot => bot.id === caller)) openWorkChat(caller); else { useConfigUI.getState().setView('chat'); if (mobile) backToList(); } }} aria-label={caller ? 'Back to chat' : 'All Bots'}><ChevronLeft size={20} aria-hidden /></button>
        {mobile && <span className="tasks-view__flock" aria-hidden />}
        <span>{mobile ? heading?.detail ? 'Saved reports' : title : 'Back to chat'}</span>
        {mobile && <button type="button" className="icon-btn" aria-label="Bot list" onClick={() => { useConfigUI.getState().setView('chat'); backToList(); }}><Menu size={18} aria-hidden /></button>}
      </header>}
      <div className="tasks-view__scroll" ref={scroll}>
        <div className={`tasks-view__inner work-ui${tab === 'Tasks' && filter === 'all' && tasks !== null && !empty ? ' is-board' : ''}`}>
          <div className="work-heading"><h1 id="tasks-heading" ref={pageHeading} tabIndex={-1}>{title}</h1>
            {tab === 'Tasks' ? <span className={`tasks-sync${connected ? ' is-connected' : ''}`}><span aria-hidden="true" />{connected ? 'Updates automatically' : 'Reconnecting…'}</span> : <p>{subtitle}</p>}
          </div>
          {!heading?.detail && <nav className="work-tabs" aria-label="Work sections">{TABS.map(item => <button key={item} type="button" aria-current={item === tab ? 'page' : undefined} onClick={() => updateContext({ tab: item })}>{item}</button>)}</nav>}
          {tab !== 'Tasks' && unavailable && <p role="status">This bot is no longer available. Return to Tasks to choose another scope.</p>}
          {!unavailable && tab === 'Team' && <TeamBoard key={`${userId}:${workBotKey(selectedBot)}`} botId={botFilter} onGoals={() => updateContext({ tab: 'Goals' })} />}
          {!unavailable && tab === 'Goals' && <WorkflowsPanel key={`${userId}:${workBotKey(selectedBot)}`} botId={botFilter} workspace onHeading={setHeading} onTeam={() => updateContext({ tab: 'Team' })} />}
          {!unavailable && tab === 'Reports' && <WorkReports key={`${userId}:${workBotKey(selectedBot)}`} botId={botFilter} location={context.report} onLocation={report => updateContext({ report })} onHeading={setHeading} />}
          {tab === 'Tasks' && <>
          {tasks !== null && <div className={`tasks-attention${counts.needs_input ? '' : ' is-clear'}`}>
            <div className="tasks-attention__copy"><strong>{counts.needs_input ? `${counts.needs_input} ${counts.needs_input === 1 ? 'task needs' : 'tasks need'} your input` : 'You’re all caught up'}</strong><span>{counts.needs_input ? 'A quick reply helps your team keep moving.' : 'No tasks are waiting for your input.'}</span></div>
            {counts.needs_input > 0 && filter !== 'needs_input' && <button type="button" className="work-button" onClick={() => setFilter('needs_input')}>Show pending</button>}
          </div>}
          <div className="tasks-toolbar">
            <div className="task-filters" role="group" aria-label="Filter tasks by status">
              {(['all', ...STATES] as const).map((state) => <button key={state} type="button" aria-pressed={filter === state} className={`task-filter is-${state}${filter === state ? ' is-selected' : ''}`} onClick={() => setFilter(state)}>
                <span>{state === 'all' ? 'All tasks' : STATUS[state].label}</span><span className="task-filter__count">{tasks === null ? '–' : counts[state]}</span>
              </button>)}
            </div>
            <label className="work-field">Filter by bot<select className="tasks-bot-filter" aria-label="Filter tasks by bot" value={botFilter ?? 'all'} onChange={(event) => updateContext({ botId: event.currentTarget.value === 'all' ? undefined : event.currentTarget.value })}>
              <option value="all">All bots</option>{unavailable && <option value={botFilter}>Bot unavailable</option>}{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select></label>
          </div>
          {error && <TaskError retry={retry} stale={tasks !== null} />}
          {unavailable ? <div className="tasks-empty" role="status"><h2>Bot unavailable</h2><p>No tasks are shown for this bot. Choose another bot or All bots.</p></div> : tasks === null ? (!error && <div className="tasks-loading" role="status"><RefreshCw size={20} aria-hidden="true" />Loading tasks…</div>) : empty ? (
            <div className="tasks-empty">
              <h2>{filter === 'needs_input' ? 'No pending tasks' : filter === 'done' ? 'Nothing finished yet' : filter === 'working' ? 'Nothing in progress' : selectedBot ? `No tasks for ${selectedBot.name} yet` : 'No tasks yet'}</h2>
              <p>{filter === 'needs_input' ? 'You’re all caught up. Tasks that need your input will appear here.' : filter === 'done' ? 'Completed work will appear here, ready to revisit.' : 'Give a Bot a multi-part request and every piece gets its own card here.'}</p>
              {filter !== 'all' && <button type="button" className="btn btn--secondary" onClick={() => setFilter('all')}>See all tasks</button>}
            </div>
          ) : <div className={`task-board${filter !== 'all' ? ' is-filtered' : ''}`}>
            {shownStates.map((state) => {
              return <section key={state} className={`task-column is-${state}`} aria-label={filter !== 'all' ? STATUS[state].label : undefined} aria-labelledby={filter === 'all' ? `tasks-${state}` : undefined}>
                {filter === 'all' && <header className="task-column__header"><h2 id={`tasks-${state}`}>{STATUS[state].label} · {counts[state]}</h2></header>}
                <div className="task-column__cards">{scoped.filter((t) => t.state === state).map((t) => <TaskCard key={t.id} task={t} bot={byId.get(t.botId)} />)}</div>
              </section>;
            })}
          </div>}
          </>}
        </div>
      </div>
    </main>
  );
}

/** Sidebar entry with the number of tasks waiting on the user. */
export function TasksIsland() {
  const view = useConfigUI((s) => s.view);
  const { tasks } = useTasks();
  const waiting = tasks?.filter((t) => t.state === 'needs_input').length ?? 0;
  return (
    <button type="button" className={`sidebar-island${view === 'tasks' ? ' is-active' : ''}`} onClick={() => {
      const ui = useConfigUI.getState();
      ui.closeAppSettings(); ui.closeBotSettings(); useStore.getState().setModal(null); ui.setView('tasks');
    }} title={waiting ? `${waiting} pending tasks need your input` : 'Tasks'} aria-label="Tasks" aria-pressed={view === 'tasks'}>
      <span className="sidebar-island__icon"><Glyph name="tasks" size={18} /></span><span className="sidebar-island__label">Tasks</span>
      {waiting > 0 && <span className="sidebar-island__count" aria-label={`${waiting} waiting on you`}>{waiting}</span>}
    </button>
  );
}

/** The same task states remain visible in each bot’s details panel. */
export function BotTasks({ bot }: { bot: Bot }) {
  const { tasks, error, retry } = useTasks(bot.id);
  const sorted = useMemo(() => sortTasks(tasks ?? []), [tasks]);
  return (
    <div className="details__sections"><section>
      <div className="section-label section-label--row"><span>Tasks</span><button type="button" className="link-btn link-btn--small" onClick={() => { workContext = { ...workContext, tab: 'Tasks', botId: bot.id, caller: bot.id, report: workContext.botId === bot.id ? workContext.report : undefined }; useConfigUI.getState().setView('tasks'); }}>See all</button></div>
      {error && <TaskError retry={retry} stale={tasks !== null} />}
      {tasks === null ? (!error && <div className="panel-card"><div className="panel-empty" role="status">Loading…</div></div>) : sorted.length === 0 ? <div className="panel-card"><div className="panel-empty">No tasks yet. Ask {bot.name} for a few things at once and they’ll be tracked here.</div></div> : <div className="bot-task-cards">{sorted.map((t) => <TaskCard key={t.id} task={t} bot={bot} compact />)}</div>}
    </section><WorkflowsPanel botId={bot.id} /></div>
  );
}

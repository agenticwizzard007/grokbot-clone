import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, ChevronLeft, CircleCheck, CircleHelp, Clock3, ListTodo, RefreshCw } from 'lucide-react';
import type { Bot, Task } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { useConfigUI, useVersion } from '../../configStore';
import { backToList, useStore } from '../../store';
import { Glyph } from './glyphs';
import './ui';
import '@fontsource-variable/instrument-sans/wght.css';
import '../../styles/tasks.css';

type Filter = 'all' | Task['state'];
const STATES = ['needs_input', 'working', 'done'] as const;
const STATUS = {
  needs_input: { label: 'Pending', chip: 'Needs you', description: 'Waiting for your input', action: 'Reply in chat', icon: CircleHelp },
  working: { label: 'In progress', chip: 'In progress', description: 'Your bots are on it', action: 'View progress', icon: Clock3 },
  done: { label: 'Done', chip: 'Completed', description: 'Finished and ready to view', action: 'View result', icon: CircleCheck },
};

function when(t: Task): string {
  const r = relativeShort(t.updatedAt);
  return r === 'now' ? 'Just now' : r === 'Yesterday' ? 'Yesterday' : `${r} ago`;
}

function TaskCard({ task, bot, compact = false }: { task: Task; bot?: Bot; compact?: boolean }) {
  const status = STATUS[task.state];
  const StatusIcon = status.icon;
  const open = () => {
    if (!bot) return;
    useStore.getState().selectBot(bot.id);
    useConfigUI.getState().setView('chat');
  };
  return (
    <button type="button" className={`task-card is-${task.state}${compact ? ' is-compact' : ''}`} onClick={open} disabled={!bot}
      aria-label={`${task.title} — ${status.label}. ${bot ? `${status.action} with ${bot.name}` : 'Bot unavailable'}`}>
      <span className="task-card__top">
        <span className={`task-status is-${task.state}`}><StatusIcon size={13} aria-hidden="true" />{status.chip}</span>
        <time dateTime={new Date(task.updatedAt).toISOString()} title={`${task.state === 'done' ? 'Completed' : 'Updated'} ${new Date(task.updatedAt).toLocaleString()}`}>{when(task)}</time>
      </span>
      <span className="task-card__body">
        <span className="task-card__title">{task.title}</span>
        <span className="task-card__note">{task.note || (task.state === 'needs_input' ? 'Open the conversation to see what your bot needs.' : task.state === 'done' ? 'Open the conversation to see the result.' : 'Your bot is working on this task.')}</span>
      </span>
      <span className="task-card__footer">
        <span className="task-card__bot">{bot && <BotAvatarFor bot={bot} size={22} />}<span>{bot?.name ?? 'Bot unavailable'}</span></span>
        {bot && <span className="task-card__action">{status.action}<ArrowRight size={14} aria-hidden="true" /></span>}
      </span>
    </button>
  );
}

function useTasks(botId?: string) {
  const version = useVersion(botId ? `tasks:${botId}` : 'tasks');
  const connected = useStore((s) => s.sseConnected);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ scope?: string; tasks: Task[] | null; error: boolean }>({ scope: botId, tasks: null, error: false });
  useEffect(() => {
    let alive = true;
    (botId ? configApi.botTasks(botId) : configApi.tasks()).then((r) => {
      if (alive) setResult({ scope: botId, tasks: r.tasks, error: false });
    }).catch(() => {
      if (alive) setResult((prev) => ({ scope: botId, tasks: prev.scope === botId ? prev.tasks : null, error: true }));
    });
    return () => { alive = false; };
  }, [botId, version, attempt, connected]);
  const retry = () => {
    setResult((prev) => ({ ...prev, error: false }));
    setAttempt((n) => n + 1);
  };
  return { tasks: result.scope === botId ? result.tasks : null, error: result.scope === botId && result.error, retry };
}

function sortTasks(list: Task[]) {
  const rank = { needs_input: 0, working: 1, done: 2 } as const;
  return [...list].sort((a, b) => rank[a.state] - rank[b.state] || (a.state === 'needs_input' ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt));
}

function TaskError({ retry, stale }: { retry: () => void; stale: boolean }) {
  return <div className="tasks-error" role="alert"><span>{stale ? 'Tasks couldn’t refresh. Showing the last update.' : 'Tasks couldn’t load. Please try again.'}</span><button type="button" onClick={retry}><RefreshCw size={14} aria-hidden="true" />Retry</button></div>;
}

/** Responsive board: status columns on wide screens, grouped cards on phones. */
export function TasksView() {
  const bots = useStore((s) => s.bots);
  const connected = useStore((s) => s.sseConnected);
  const mobile = useStore((s) => s.mobile);
  const { tasks, error, retry } = useTasks();
  const [filter, setFilter] = useState<Filter>('all');
  const [botFilter, setBotFilter] = useState('all');
  const selectedBot = bots.find((b) => b.id === botFilter);
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const scoped = useMemo(() => sortTasks((tasks ?? []).filter((t) => !selectedBot || t.botId === selectedBot.id)), [tasks, selectedBot]);
  const counts = useMemo(() => ({ all: scoped.length, needs_input: scoped.filter((t) => t.state === 'needs_input').length, working: scoped.filter((t) => t.state === 'working').length, done: scoped.filter((t) => t.state === 'done').length }), [scoped]);
  const shownStates = filter === 'all' ? STATES : [filter];
  const empty = tasks !== null && counts[filter] === 0;

  return (
    <main className="chat tasks-view" aria-labelledby="tasks-heading">
      <header className="tasks-view__header">
        {mobile && (
          <button type="button" className="chat__back icon-btn" onClick={() => { useConfigUI.getState().setView('chat'); backToList(); }} aria-label="All Bots">
            <ChevronLeft size={22} strokeWidth={1.75} aria-hidden />
          </button>
        )}
        <h1 id="tasks-heading">Tasks</h1>
        <span className={`tasks-sync${connected ? ' is-connected' : ''}`}><span aria-hidden="true" />{connected ? 'Updates automatically' : 'Reconnecting…'}</span>
      </header>
      <div className="tasks-view__scroll">
        <div className="tasks-view__inner">
          {error && <TaskError retry={retry} stale={tasks !== null} />}
          {tasks !== null && <div className={`tasks-attention${counts.needs_input ? '' : ' is-clear'}`}>
            <span className="tasks-attention__icon" aria-hidden="true">{counts.needs_input ? <CircleHelp size={20} /> : <Check size={20} />}</span>
            <div className="tasks-attention__copy"><strong>{counts.needs_input ? `${counts.needs_input} ${counts.needs_input === 1 ? 'task needs' : 'tasks need'} your input` : 'You’re all caught up'}</strong><span>{counts.needs_input ? 'A quick reply helps your team keep moving.' : 'No tasks are waiting for your input.'}</span></div>
            {counts.needs_input > 0 && filter !== 'needs_input' && <button type="button" className="tasks-attention__action" onClick={() => setFilter('needs_input')}>Show pending<ArrowRight size={15} aria-hidden="true" /></button>}
          </div>}
          <div className="tasks-toolbar">
            <div className="task-filters" role="group" aria-label="Filter tasks by status">
              {(['all', ...STATES] as const).map((state) => <button key={state} type="button" aria-pressed={filter === state} className={`task-filter is-${state}${filter === state ? ' is-selected' : ''}`} onClick={() => setFilter(state)}>
                <span>{state === 'all' ? 'All tasks' : STATUS[state].label}</span><span className="task-filter__count">{tasks === null ? '–' : counts[state]}</span>
              </button>)}
            </div>
            <select className="tasks-bot-filter" aria-label="Filter tasks by bot" value={selectedBot?.id ?? 'all'} onChange={(e) => setBotFilter(e.target.value)}>
              <option value="all">All bots</option>{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          </div>
          {tasks === null ? (!error && <div className="tasks-loading" role="status"><RefreshCw size={20} aria-hidden="true" />Loading tasks…</div>) : empty ? (
            <div className="tasks-empty">
              {filter === 'needs_input' ? <CircleCheck size={28} aria-hidden="true" /> : <ListTodo size={28} aria-hidden="true" />}
              <h2>{filter === 'needs_input' ? 'No pending tasks' : filter === 'done' ? 'Nothing finished yet' : filter === 'working' ? 'Nothing in progress' : selectedBot ? `No tasks for ${selectedBot.name} yet` : 'No tasks yet'}</h2>
              <p>{filter === 'needs_input' ? 'You’re all caught up. Tasks that need your input will appear here.' : filter === 'done' ? 'Completed work will appear here, ready to revisit.' : 'Give a Bot a multi-part request and every piece gets its own card here.'}</p>
              {filter !== 'all' && <button type="button" className="btn btn--secondary" onClick={() => setFilter('all')}>See all tasks</button>}
            </div>
          ) : <div className={`task-board${filter !== 'all' ? ' is-filtered' : ''}`}>
            {shownStates.map((state) => {
              const StatusIcon = STATUS[state].icon;
              return <section key={state} className={`task-column is-${state}`} aria-labelledby={`tasks-${state}`}>
                <header className="task-column__header"><h2 id={`tasks-${state}`}><StatusIcon size={16} aria-hidden="true" />{STATUS[state].label}<span>{counts[state]}</span></h2><p>{STATUS[state].description}</p></header>
                <div className="task-column__cards">{scoped.filter((t) => t.state === state).map((t) => <TaskCard key={t.id} task={t} bot={byId.get(t.botId)} />)}</div>
                {counts[state] === 0 && <p className="task-column__empty">{state === 'needs_input' ? 'All caught up. Nothing needs your input.' : state === 'working' ? 'No tasks in progress.' : 'Completed tasks will appear here.'}</p>}
              </section>;
            })}
          </div>}
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
    <button type="button" className={`sidebar-island${view === 'tasks' ? ' is-active' : ''}`} onClick={() => { useConfigUI.getState().setView(view === 'tasks' ? 'chat' : 'tasks'); }} title={waiting ? `${waiting} pending tasks need your input` : 'Tasks'} aria-label="Tasks" aria-pressed={view === 'tasks'}>
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
      <div className="section-label section-label--row"><span>Tasks</span><button type="button" className="link-btn link-btn--small" onClick={() => useConfigUI.getState().setView('tasks')}>See all</button></div>
      {error && <TaskError retry={retry} stale={tasks !== null} />}
      {tasks === null ? (!error && <div className="panel-card"><div className="panel-empty" role="status">Loading…</div></div>) : sorted.length === 0 ? <div className="panel-card"><div className="panel-empty">No tasks yet. Ask {bot.name} for a few things at once and they’ll be tracked here.</div></div> : <div className="bot-task-cards">{sorted.map((t) => <TaskCard key={t.id} task={t} bot={bot} compact />)}</div>}
    </section></div>
  );
}

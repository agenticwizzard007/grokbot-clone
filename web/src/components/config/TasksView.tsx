import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, Menu, RefreshCw } from 'lucide-react';
import { backFromWork, useReturnLabel, useConfigUI } from '../../configStore';
import { botSlug, routeBot, workTabLabel, type WorkTab } from '../../lib/userRoutes';
import { backToList, useStore } from '../../store';
import { RosterFeedback } from '../LoadFeedback';
import { TeamBoard } from './TeamBoard';
import { WorkflowsPanel } from './WorkflowsPanel';
import { WorkReports } from './WorkReports';
import { workBotKey } from './workScope';
import { useNeedsYou, useTasks } from './taskData';
import { AttentionStatus, NeedsYouCard, TaskCard, TaskError, sortTasks, STATES, STATUS, workContext, setWorkContext, type Filter, type WorkContext } from './TaskCards';

const TABS: WorkTab[] = ['Tasks', 'Team', 'Goals', 'Reports'];

/** Responsive board: status columns on wide screens, grouped cards on phones. */
export function TasksView() {
  const userId = useStore(s => s.user?.id);
  return <WorkWorkspace key={userId} />;
}

function WorkWorkspace() {
  const backTitle = useReturnLabel();
  const bots = useStore((s) => s.bots);
  const botsLoaded = useStore((s) => s.botsLoaded);
  const rosterUnavailable = !botsLoaded && !bots.length;
  const userId = useStore(s => s.user?.id);
  const connected = useStore((s) => s.sseConnected);
  const mobile = useStore((s) => s.mobile);
  const [context, setContext] = useState(workContext);
  const [childHeading, setHeading] = useState<{ title: string; subtitle: string; detail?: boolean }>();
  const scroll = useRef<HTMLDivElement>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const route = useConfigUI(s => s.workRoute);
  const tab = route.tab;
  const botFilter = route.botSlug ? routeBot(route.botSlug, bots)?.id ?? 'unavailable' : undefined;
  const { filter } = context;
  const updateContext = (patch: Partial<WorkContext> & { tab?: WorkTab; botId?: string }) => {
    const bot = bots.find(bot => bot.id === patch.botId);
    useConfigUI.getState().setWorkRoute({ tab: patch.tab ?? tab, botSlug: 'botId' in patch ? bot && botSlug(bot) : route.botSlug });
    setWorkContext({ ...workContext, ...('botId' in patch && patch.botId !== botFilter ? { report: undefined } : {}), ...patch });
    setContext(workContext);
    if (patch.tab && patch.tab !== tab) setHeading(undefined);
  };
  const setFilter = (next: Filter) => updateContext({ filter: next });
  const selectedBot = bots.find((b) => b.id === botFilter);
  useLayoutEffect(() => { setHeading(undefined); }, [tab, botFilter]);
  const unavailable = !!botFilter && !selectedBot;
  const heading = unavailable ? undefined : childHeading;
  // Titles are fixed. A Bot is named only when the user filtered to it.
  const scope = selectedBot ? `${selectedBot.name} · ` : unavailable && botsLoaded ? 'Bot unavailable · ' : '';
  const title = heading?.title ?? workTabLabel(tab);
  const subtitle = heading ? (tab === 'Reports' ? heading.subtitle : `${scope}${heading.subtitle}`) : tab === 'Team' ? `Team board · ${scope}Owners, dependencies and evidence from current team records.` : tab === 'Goals' ? `${scope}Keep work running across turns and verify results against acceptance checks.` : `${scope}View and download saved files, or review where to send them.`;

  const { tasks, error, retry } = useTasks(botFilter, !rosterUnavailable && !unavailable && tab === 'Tasks');
  const attention = useNeedsYou(botFilter, !rosterUnavailable && !unavailable && tab === 'Tasks');
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const scoped = useMemo(() => sortTasks((tasks ?? []).filter((t) => !selectedBot || t.botId === selectedBot.id)), [tasks, selectedBot]);
  const waitingItems = attention.items ?? [];
  const attentionKnown = attention.items !== null && !attention.error;
  const counts = useMemo(() => ({ all: scoped.length + waitingItems.length, needs_input: scoped.filter((t) => t.state === 'needs_input').length + waitingItems.length, working: scoped.filter((t) => t.state === 'working').length, done: scoped.filter((t) => t.state === 'done').length }), [scoped, waitingItems.length]);
  const shownStates = filter === 'all' ? STATES.filter(state => counts[state] > 0) : [filter];
  const empty = tasks !== null && counts[filter] === 0 && (attentionKnown || (filter !== 'all' && filter !== 'needs_input'));
  const countLabel = (state: Filter) => tasks === null || (!attentionKnown && (state === 'all' || state === 'needs_input')) ? '?' : counts[state];
  // R2F-022: only the board content widens; the heading and tab bar keep one width and position on every tab.
  const board = tab === 'Tasks' && filter === 'all' && tasks !== null && !empty;
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [tab, heading?.title]);
  useLayoutEffect(() => { if (heading?.detail) pageHeading.current?.focus({ preventScroll: true }); }, [heading?.detail]);

  return (
    <main className="chat tasks-view" aria-labelledby="tasks-heading">
      <header className="tasks-view__header">
        {/* Only scoped sub-pages have a parent. Top-level tabs use browser history. */}
        {!!route.botSlug && <button type="button" className={mobile ? 'icon-btn' : 'tasks-view__back'} onClick={backFromWork} aria-label={backTitle}><ChevronLeft size={20} aria-hidden />{!mobile && <span>{backTitle}</span>}</button>}
        {mobile && <span className="tasks-view__flock" aria-hidden />}
        {mobile && <span>{heading?.detail ? 'Files' : title}</span>}
        {mobile && <button type="button" className="icon-btn" aria-label="Bot list" onClick={backToList}><Menu size={18} aria-hidden /></button>}
      </header>
      <div className="tasks-view__scroll" ref={scroll}>
        <div className="tasks-view__inner work-ui">
          <div className="work-heading"><h1 id="tasks-heading" ref={pageHeading} tabIndex={-1}>{title === workTabLabel(tab) ? `${scope}${title}` : title}</h1>
            {tab === 'Tasks' ? <span className={`tasks-sync${connected ? ' is-connected' : ''}`}><span aria-hidden="true" />{connected ? 'Updates automatically' : 'Reconnecting…'}</span> : <p>{subtitle}</p>}
          </div>
          {!heading?.detail && <nav className="work-tabs" aria-label="Work sections">{TABS.map(item => <button key={item} type="button" aria-current={item === tab ? 'page' : undefined} onClick={() => updateContext({ tab: item })}>{workTabLabel(item)}</button>)}</nav>}
          <RosterFeedback />
          {!rosterUnavailable && <>
          {tab !== 'Tasks' && unavailable && <p role="status">This Bot is no longer available. Return to Tasks to choose another scope.</p>}
          {!unavailable && tab === 'Team' && <TeamBoard key={`${userId}:${workBotKey(selectedBot)}`} botId={botFilter} onGoals={() => updateContext({ tab: 'Goals' })} />}
          {!unavailable && tab === 'Goals' && <WorkflowsPanel key={`${userId}:${workBotKey(selectedBot)}`} botId={botFilter} workspace onHeading={setHeading} onTeam={() => updateContext({ tab: 'Team' })} />}
          {!unavailable && tab === 'Reports' && <WorkReports key={`${userId}:${workBotKey(selectedBot)}`} botId={botFilter} location={context.report} onLocation={report => updateContext({ report })} onHeading={setHeading} />}
          {tab === 'Tasks' && <div className={`tasks-board-area${board ? ' is-board' : ''}`}>
          {selectedBot && <div className="tasks-scope" role="status"><span>Showing tasks for {selectedBot.name}</span><button type="button" className="work-button" aria-label={`Clear the ${selectedBot.name} filter and show tasks for all Bots`} onClick={() => updateContext({ botId: undefined })}>Show all Bots</button></div>}
          {tasks !== null && attentionKnown && <div className={`tasks-attention${counts.needs_input ? '' : ' is-clear'}`}>
            <div className="tasks-attention__copy"><strong>{counts.needs_input ? `${counts.needs_input} ${counts.needs_input === 1 ? 'task needs' : 'tasks need'} your input` : 'You’re all caught up'}</strong><span>{counts.needs_input ? 'A quick reply helps your team keep moving.' : 'No tasks are waiting for your input.'}</span></div>
            {counts.needs_input > 0 && filter !== 'needs_input' && <button type="button" className="work-button" onClick={() => setFilter('needs_input')}>Show pending</button>}
          </div>}
          <div className="tasks-toolbar">
            <div className="task-filters" role="group" aria-label="Filter tasks by status">
              {(['all', ...STATES] as const).map((state) => <button key={state} type="button" aria-pressed={filter === state} className={`task-filter is-${state}${filter === state ? ' is-selected' : ''}`} onClick={() => setFilter(state)}>
                <span>{state === 'all' ? 'All tasks' : STATUS[state].label}</span><span className="task-filter__count">{countLabel(state)}</span>
              </button>)}
            </div>
            <label className="work-field">Filter by Bot<select className="tasks-bot-filter" aria-label="Filter tasks by bot" value={botFilter ?? 'all'} onChange={(event) => updateContext({ botId: event.currentTarget.value === 'all' ? undefined : event.currentTarget.value })}>
              <option value="all">All Bots</option>{unavailable && <option value={botFilter}>Bot unavailable</option>}{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select></label>
          </div>
          {error && <TaskError retry={retry} stale={tasks !== null} />}
          {!unavailable && <AttentionStatus attention={attention} />}
          {unavailable ? <div className="tasks-empty" role="status"><h2>Bot unavailable</h2><p>No tasks are shown for this Bot. Choose another Bot or All Bots.</p></div> : tasks === null ? (!error && <div className="tasks-loading" role="status"><RefreshCw size={20} aria-hidden="true" />Loading tasks…</div>) : empty ? (
            <div className="tasks-empty">
              <h2>{filter === 'needs_input' ? 'No pending tasks' : filter === 'done' ? 'Nothing finished yet' : filter === 'working' ? 'Nothing in progress' : selectedBot ? `No tasks for ${selectedBot.name} yet` : 'No tasks yet'}</h2>
              <p>{filter === 'needs_input' ? 'You’re all caught up. Tasks that need your input will appear here.' : filter === 'done' ? 'Completed work will appear here, ready to revisit.' : 'Give a Bot a multi-part request and every piece gets its own card here.'}</p>
              {filter !== 'all' && <button type="button" className="btn btn--secondary" onClick={() => setFilter('all')}>See all tasks</button>}
            </div>
          ) : <div className={`task-board${filter !== 'all' ? ' is-filtered' : ''}`}>
            {shownStates.map((state) => {
              return <section key={state} className={`task-column is-${state}`} aria-label={filter !== 'all' ? STATUS[state].label : undefined} aria-labelledby={filter === 'all' ? `tasks-${state}` : undefined}>
                {filter === 'all' && <header className="task-column__header"><h2 id={`tasks-${state}`}>{STATUS[state].label} · {countLabel(state)}</h2></header>}
                <div className="task-column__cards">
                  {state === 'needs_input' && waitingItems.map((item) => <NeedsYouCard key={`${item.type}:${item.id}`} item={item} bot={byId.get(item.botId)} />)}
                  {scoped.filter((t) => t.state === state).map((t) => <TaskCard key={t.id} task={t} bot={byId.get(t.botId)} />)}
                </div>
              </section>;
            })}
          </div>}
          </div>}
          </>}
        </div>
      </div>
    </main>
  );
}

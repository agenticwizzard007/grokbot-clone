import { prefillComposer } from '../Composer';
import { openConversation } from '../../configStore';
import { TaskCount } from './TaskCount';
import { taskCountState } from '../../lib/taskCount';
import { Page, Section, Card } from '../layout';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useConfigUI } from '../../configStore';
import { botSlug, routeBot, workTabLabel, type WorkTab } from '../../lib/userRoutes';
import { useStore } from '../../store';
import { RosterFeedback } from '../LoadFeedback';
import { TeamBoard } from './TeamBoard';
import { WorkflowsPanel } from './WorkflowsPanel';
import { WorkReports } from './WorkReports';
import { workBotKey } from './workScope';
import { useNeedsYou, useTasks } from './taskData';
import { TaskLoopsLink, TaskHandoffProvider, AttentionStatus, NeedsYouCard, TaskCard, TaskError, sortTasks, workContext, setWorkContext, type Filter, type WorkContext } from './TaskCards';

const TABS: WorkTab[] = ['Tasks', 'Team', 'Goals', 'Reports'];

/** Responsive board: status columns on wide screens, grouped cards on phones. */
export function TasksView() {
  const userId = useStore(s => s.user?.id);
  return <TaskHandoffProvider key={userId}><WorkWorkspace /></TaskHandoffProvider>;
}

function WorkWorkspace() {
  const bots = useStore((s) => s.bots);
  const botsLoaded = useStore((s) => s.botsLoaded);
  const rosterUnavailable = !botsLoaded && !bots.length;
  const userId = useStore(s => s.user?.id);
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


  const { tasks, error, retry } = useTasks(botFilter, !rosterUnavailable && !unavailable && tab === 'Tasks');
  const attention = useNeedsYou(botFilter, !rosterUnavailable && !unavailable && tab === 'Tasks');
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const scoped = useMemo(() => sortTasks((tasks ?? []).filter((t) => !selectedBot || t.botId === selectedBot.id)), [tasks, selectedBot]);
  const waitingItems = attention.items ?? [];
  const attentionKnown = attention.items !== null && !attention.error;
  const counts = useMemo(() => ({ all: scoped.length + waitingItems.length, needs_input: scoped.filter((t) => t.state === 'needs_input').length + waitingItems.length, working: scoped.filter((t) => t.state === 'working').length, done: scoped.filter((t) => t.state === 'done').length }), [scoped, waitingItems.length]);
  const columns = [{ key: 'todo', title: 'To do' }, { key: 'working', title: 'Doing' }, { key: 'needs_input', title: 'Blocked' }, { key: 'done', title: 'Done' }] as const;
  const shownColumns = columns.filter(column => filter === 'all' || (filter === 'open' ? column.key !== 'done' : column.key === filter));
  const empty = tasks !== null && (filter === 'open' ? counts.all - counts.done : counts[filter]) === 0 && (attentionKnown || (filter !== 'all' && filter !== 'open' && filter !== 'needs_input'));
  const countLabel = (state: Exclude<Filter, 'open'>) => <TaskCount className="task-filter__count" count={counts[state]} name={state === 'needs_input' ? 'Pending input count' : 'Task count'} label={`${counts[state]} tasks`} state={taskCountState([
    { known: tasks !== null, error },
    ...(state === 'all' || state === 'needs_input' ? [{ known: attention.items !== null, ...attention }] : []),
  ])} />;
  // R2F-022: only the board content widens; the heading and tab bar keep one width and position on every tab.
  const board = tab === 'Tasks' && filter === 'all' && tasks !== null && !empty;
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [tab, heading?.title]);
  useLayoutEffect(() => { if (heading?.detail) pageHeading.current?.focus({ preventScroll: true }); }, [heading?.detail]);

  return (
    <main className="chat tasks-view" aria-labelledby="tasks-heading">
      <div className="tasks-view__scroll" ref={scroll} tabIndex={0} role="region" aria-labelledby="tasks-heading">
        <Page type="list" className="tasks-view__inner work-ui">
          <div className="work-heading"><h1 id="tasks-heading" ref={pageHeading} tabIndex={-1}>{title === workTabLabel(tab) ? `${scope}${title}` : title}</h1>
            {tab === 'Tasks' && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', justifyContent: 'flex-end' }}><TaskLoopsLink /><button type="button" className="btn btn--primary" onClick={() => { const bot = selectedBot ?? bots.find(b => b.isPrimary) ?? bots[0]; if (bot) { prefillComposer(bot.id, 'Create a task: '); openConversation(bot.id); } }} disabled={!bots.length}>Add task</button></div>}
          </div>
          {tab === 'Tasks' && counts.needs_input > 0 && <Card tone="warning" className="tasks-needs-input" role="status" data-testid="tasks-needs-input">
            <span>{counts.needs_input} {counts.needs_input === 1 ? 'task needs' : 'tasks need'} your input</span>
            <button type="button" className="link-btn" onClick={() => setFilter('needs_input')}>Review</button>
          </Card>}
          {!heading?.detail && <nav className="work-tabs" aria-label="Work sections">{TABS.map(item => <button key={item} type="button" aria-current={item === tab ? 'page' : undefined} onClick={() => updateContext({ tab: item })}>{workTabLabel(item)}</button>)}</nav>}
          <RosterFeedback />
          {!rosterUnavailable && <>
          {tab !== 'Tasks' && unavailable && <p role="status">This Bot is no longer available. Return to Tasks to choose another scope.</p>}
          {!unavailable && tab === 'Team' && <TeamBoard key={`${userId}:${workBotKey(selectedBot)}`} botId={botFilter} onGoals={() => updateContext({ tab: 'Goals' })} />}
          {!unavailable && tab === 'Goals' && <WorkflowsPanel key={`${userId}:${workBotKey(selectedBot)}`} botId={botFilter} workspace onHeading={setHeading} onTeam={() => updateContext({ tab: 'Team' })} />}
          {!unavailable && tab === 'Reports' && <WorkReports key={`${userId}:${workBotKey(selectedBot)}`} botId={botFilter} location={context.report} onLocation={report => updateContext({ report })} onHeading={setHeading} />}
          {tab === 'Tasks' && <div className={`tasks-board-area${board ? ' is-board' : ''}`}>
          {selectedBot && <div className="tasks-scope" role="status"><span>Showing tasks for {selectedBot.name}</span><button type="button" className="work-button" aria-label={`Show all Bots: clear the ${selectedBot.name} filter`} onClick={() => updateContext({ botId: undefined })}>Show all Bots</button></div>}
          <div className="tasks-toolbar">
            <div className="task-filters" role="group" aria-label="Filter tasks by status">
              {(['open', 'done', 'all'] as const).map(state => <button key={state} type="button" aria-pressed={filter === state} className={`task-filter is-${state}${filter === state ? ' is-selected' : ''}`} onClick={() => setFilter(state)}>{state === 'open' ? 'Open' : state === 'done' ? 'Done' : 'All'}{state === 'all' && countLabel('all')}</button>)}
            </div>
            <label className="work-field"><span className="sr-only">Filter by Bot</span><select className="tasks-bot-filter" aria-label="Filter tasks by bot" value={botFilter ?? 'all'} onChange={(event) => updateContext({ botId: event.currentTarget.value === 'all' ? undefined : event.currentTarget.value })}>
              <option value="all">All Bots</option>{unavailable && <option value={botFilter}>Bot unavailable</option>}{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select></label>
          </div>
          {error && <TaskError retry={retry} stale={tasks !== null} />}
          {!unavailable && <AttentionStatus attention={attention} />}
          {unavailable ? <Card role="status">Bot unavailable</Card> : tasks === null ? (!error && <Card role="status">Loading tasks...</Card>) : <>
            {empty && <h2 className="tasks-empty-title" aria-live="polite">{filter === 'needs_input' ? 'No pending tasks' : filter === 'done' ? 'Nothing finished yet' : 'No tasks yet'}</h2>}
            <div className={`task-board${filter !== 'all' ? ' is-filtered' : ''}`}>
              {shownColumns.map(column => <Section key={column.key} className={`task-column is-${column.key}`} title={column.key === 'todo' ? column.title : <button type="button" className={`task-filter task-column__filter is-${column.key}`} aria-pressed={filter === column.key} onClick={() => setFilter(column.key)}><span>{column.title}</span>{countLabel(column.key)}</button>} aria-label={column.title}>
                {column.key === 'needs_input' && waitingItems.map(item => <NeedsYouCard key={`${item.type}:${item.id}`} item={item} bot={byId.get(item.botId)} />)}
                {scoped.filter(task => task.state === column.key).map(task => <TaskCard key={task.id} task={task} bot={byId.get(task.botId)} />)}
              </Section>)}
            </div>
          </>}
          </div>}
          </>}
        </Page>
      </div>
    </main>
  );
}

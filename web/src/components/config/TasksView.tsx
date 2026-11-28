import { prefillComposer } from '../Composer';
import { openConversation } from '../../configStore';
import { TaskCount } from './TaskCount';
import { taskCountState } from '../../lib/taskCount';
import { Page, Section, Card } from '../layout';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, CircleAlert, Plus, Search, X } from 'lucide-react';
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
const FILTERS = [{ key: 'all', label: 'All tasks' }, { key: 'needs_input', label: 'Needs input' }, { key: 'working', label: 'In progress' }, { key: 'done', label: 'Done' }] as const;

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
  const [query, setQuery] = useState('');
  const [childHeading, setHeading] = useState<{ title: string; subtitle: string; detail?: boolean }>();
  const scroll = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
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
  const needsInput = scoped.filter(t => t.state === 'needs_input').length + waitingItems.length;
  const search = query.trim().toLocaleLowerCase();
  const matches = (title: string, botId: string, note = '') => `${title} ${byId.get(botId)?.name ?? ''} ${note}`.toLocaleLowerCase().includes(search);
  const matchedTasks = scoped.filter(t => matches(t.title, t.botId, t.note));
  const matchedWaiting = waitingItems.filter(item => matches(item.title, item.botId, item.botName));
  const counts = { all: matchedTasks.length + matchedWaiting.length, needs_input: matchedTasks.filter(t => t.state === 'needs_input').length + matchedWaiting.length, working: matchedTasks.filter(t => t.state === 'working').length, done: matchedTasks.filter(t => t.state === 'done').length };
  const columns = [{ key: 'needs_input', title: 'Needs input', empty: 'Nothing waiting on you.' }, { key: 'working', title: 'In progress', empty: 'No tasks in progress.' }, { key: 'done', title: 'Done', empty: 'Completed work will appear here.' }] as const;
  const shownColumns = columns.filter(column => filter === 'all' || (filter === 'open' ? column.key !== 'done' : column.key === filter));
  const matchingCount = filter === 'open' ? counts.all - counts.done : counts[filter];
  const resultsKnown = tasks !== null && !error && (attentionKnown || filter === 'working' || filter === 'done');
  const empty = resultsKnown && matchingCount === 0;
  const countLabel = (state: Exclude<Filter, 'open'>) => <TaskCount className="task-filter__count" count={counts[state]} name={state === 'needs_input' ? 'Pending input count' : 'Task count'} label={`${counts[state]} tasks`} state={taskCountState([
    { known: tasks !== null, error },
    ...(state === 'all' || state === 'needs_input' ? [{ known: attention.items !== null, ...attention }] : []),
  ])} />;
  const clearSearch = () => { setQuery(''); searchInput.current?.focus(); };
  const review = () => { setQuery(''); setFilter('needs_input'); };
  useLayoutEffect(() => { if (scroll.current) scroll.current.scrollTop = 0; }, [tab, heading?.title]);
  useLayoutEffect(() => { if (heading?.detail) pageHeading.current?.focus({ preventScroll: true }); }, [heading?.detail]);

  return (
    <main className="chat tasks-view" aria-labelledby="tasks-heading">
      <div className="tasks-view__scroll" ref={scroll} tabIndex={0} role="region" aria-labelledby="tasks-heading">
        <Page type="wide" className="tasks-view__inner work-ui">
          <div className="work-heading"><div className="work-heading__copy"><h1 id="tasks-heading" ref={pageHeading} tabIndex={-1}>{title === workTabLabel(tab) ? `${scope}${title}` : title}</h1>{tab === 'Tasks' && <p>Keep your team’s work moving.</p>}</div>
            {tab === 'Tasks' && <div className="tasks-heading-actions"><TaskLoopsLink /><button type="button" className="btn btn--primary" onClick={() => { const bot = selectedBot ?? bots.find(b => b.isPrimary) ?? bots[0]; if (bot) { prefillComposer(bot.id, 'Create a task: '); openConversation(bot.id); } }} disabled={!bots.length}><Plus size={16} aria-hidden />Add task</button></div>}
          </div>
          {!heading?.detail && <nav className="work-tabs" aria-label="Work sections">{TABS.map(item => <button key={item} type="button" aria-current={item === tab ? 'page' : undefined} onClick={() => updateContext({ tab: item })}>{workTabLabel(item)}</button>)}</nav>}
          <RosterFeedback />
          {!rosterUnavailable && <>
          {tab !== 'Tasks' && unavailable && <p role="status">This Bot is no longer available. Return to Tasks to choose another scope.</p>}
          {!unavailable && tab === 'Team' && <TeamBoard key={`${userId}:${workBotKey(selectedBot)}`} botId={botFilter} onGoals={() => updateContext({ tab: 'Goals' })} />}
          {!unavailable && tab === 'Goals' && <WorkflowsPanel key={`${userId}:${workBotKey(selectedBot)}`} botId={botFilter} workspace onHeading={setHeading} onTeam={() => updateContext({ tab: 'Team' })} />}
          {!unavailable && tab === 'Reports' && <WorkReports key={`${userId}:${workBotKey(selectedBot)}`} botId={botFilter} location={context.report} onLocation={report => updateContext({ report })} onHeading={setHeading} />}
          {tab === 'Tasks' && <div className="tasks-board-area">
          {needsInput > 0 && <Card tone="warning" className="tasks-needs-input" role="status" data-testid="tasks-needs-input">
            <CircleAlert size={18} aria-hidden /><span>{needsInput} {needsInput === 1 ? 'task needs' : 'tasks need'} your input</span>
            <button type="button" className="link-btn" onClick={review}>Review<ArrowRight size={16} aria-hidden /></button>
          </Card>}
          {selectedBot && <div className="tasks-scope" role="status"><span>Showing tasks for {selectedBot.name}</span><button type="button" className="work-button" aria-label={`Show all Bots: clear the ${selectedBot.name} filter`} onClick={() => updateContext({ botId: undefined })}>Show all Bots</button></div>}
          <div className="tasks-toolbar">
            <div className="task-filters" role="group" aria-label="Filter tasks by status">
              {FILTERS.map(({ key, label }) => <button key={key} type="button" aria-pressed={filter === key} className={`task-filter is-${key}${filter === key ? ' is-selected' : ''}`} onClick={() => setFilter(key)}><span>{label}</span>{countLabel(key)}</button>)}
            </div>
            <div className="tasks-toolbar__tools">
            <div className="tasks-search"><Search size={16} aria-hidden /><label className="sr-only" htmlFor="task-search">Search tasks</label><input ref={searchInput} id="task-search" type="search" placeholder="Search tasks…" value={query} onChange={event => setQuery(event.currentTarget.value)} />{query && <button type="button" aria-label="Clear task search" onClick={clearSearch}><X size={14} aria-hidden /></button>}</div>
            <label className="tasks-owner"><span className="sr-only">Filter by Bot</span><select className="tasks-bot-filter" aria-label="Filter tasks by bot" value={botFilter ?? 'all'} onChange={(event) => updateContext({ botId: event.currentTarget.value === 'all' ? undefined : event.currentTarget.value })}>
              <option value="all">All Bots</option>{unavailable && <option value={botFilter}>Bot unavailable</option>}{bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select></label>
            </div>
          </div>
          {error && <TaskError retry={retry} stale={tasks !== null} />}
          {!unavailable && <AttentionStatus attention={attention} />}
          {unavailable ? <Card role="status">Bot unavailable</Card> : tasks === null ? (!error && <Card role="status">Loading tasks...</Card>) : <>
            {search && <p className="tasks-search-result" role="status">{resultsKnown ? `${matchingCount} matching ${matchingCount === 1 ? 'task' : 'tasks'}` : 'Search results may be incomplete.'}</p>}
            {empty && <div className="tasks-empty" aria-live="polite"><Search size={24} aria-hidden /><h2 className="tasks-empty-title">{search ? 'No matching tasks' : filter === 'needs_input' ? 'No pending tasks' : filter === 'done' ? 'Nothing finished yet' : filter === 'working' ? 'No tasks in progress' : 'No tasks yet'}</h2><p>{search ? 'Try a different task name or Bot.' : filter === 'needs_input' ? 'You’re all caught up. Your team can keep moving.' : 'Ask a Bot to take on a task to see its progress here.'}</p>{search && <button type="button" className="link-btn" onClick={clearSearch}>Clear search</button>}</div>}
            {!empty && <div className={`task-board${filter !== 'all' ? ' is-filtered' : ''}`}>
              {shownColumns.map(column => <Section key={column.key} className={`task-column is-${column.key}`} title={<button type="button" className={`task-column__filter is-${column.key}`} aria-pressed={filter === column.key} onClick={() => setFilter(column.key)}><span className="task-column__label"><span className="task-column__dot" aria-hidden />{column.title}</span>{countLabel(column.key)}</button>} aria-label={column.title}>
                {column.key === 'needs_input' && matchedWaiting.map(item => <NeedsYouCard key={`${item.type}:${item.id}`} item={item} bot={byId.get(item.botId)} />)}
                {matchedTasks.filter(task => task.state === column.key).map(task => <TaskCard key={task.id} task={task} bot={byId.get(task.botId)} />)}
                {counts[column.key] === 0 && !error && (column.key !== 'needs_input' || attentionKnown) && <p className="task-column__empty">{column.empty}</p>}
              </Section>)}
            </div>}
          </>}
          </div>}
          </>}
        </Page>
      </div>
    </main>
  );
}

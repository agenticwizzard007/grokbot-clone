import { useStore } from '../../store';
import { navigation, useConfigUI } from '../../configStore';
import { Glyph } from './glyphs';
import { useNeedsYou, useTasks } from './taskData';
import { taskCountState } from '../../lib/taskCount';
import { TaskCount } from './TaskCount';

/** Sidebar entry with the number of tasks waiting on the user. */
export function TasksIsland() {
  const view = useConfigUI((s) => s.view);
  const settingsOpen = useConfigUI((s) => s.appSettings !== null);
  const tab = useConfigUI(s => s.workRoute.tab);
  const modal = useStore(s => s.modal);
  const collapsed = useStore(s => !s.mobile && s.sidebarCollapsed);
  const active = view === 'tasks' && tab !== 'Reports' && !settingsOpen && !modal;
  const { tasks, error } = useTasks();
  const attention = useNeedsYou();
  const waiting = (tasks?.filter((t) => t.state === 'needs_input').length ?? 0) + (attention.items?.length ?? 0);
  const countState = taskCountState([{ known: tasks !== null, error }, { known: attention.items !== null, ...attention }]);
  return (
    <button type="button" className={`sidebar-island${active ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().requestLeaveBotSettings(() => {
      navigation.navigate({ kind: 'work', route: { tab: 'Tasks' } });
    })} title={countState !== 'ready' ? `Pending input count ${countState}` : waiting ? `${waiting} ${waiting === 1 ? 'item needs' : 'items need'} your input` : 'Tasks'} aria-label={collapsed ? 'Tasks' : undefined} aria-pressed={active}>
      <span className="sidebar-island__icon"><Glyph name="tasks" size={18} /></span><span className="sidebar-island__label">Tasks</span>
      <TaskCount className="sidebar-island__count" state={countState} count={waiting} label={`${waiting} waiting on you`} quietZero />
    </button>
  );
}


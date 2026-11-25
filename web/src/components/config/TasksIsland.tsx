import { navigation, useConfigUI } from '../../configStore';
import { Glyph } from './glyphs';
import { useNeedsYou, useTasks } from './taskData';

/** Sidebar entry with the number of tasks waiting on the user. */
export function TasksIsland() {
  const view = useConfigUI((s) => s.view);
  const settingsOpen = useConfigUI((s) => s.appSettings !== null);
  const active = view === 'tasks' && !settingsOpen;
  const { tasks } = useTasks();
  const attention = useNeedsYou();
  const waiting = (tasks?.filter((t) => t.state === 'needs_input').length ?? 0) + (attention.items?.length ?? 0);
  const attentionKnown = attention.items !== null && !attention.error;
  return (
    <button type="button" className={`sidebar-island${active ? ' is-active' : ''}`} onClick={() => useConfigUI.getState().requestLeaveBotSettings(() => {
      navigation.navigate({ kind: 'work', route: { tab: 'Tasks' } });
    })} title={!attentionKnown ? 'Pending input count unavailable' : waiting ? `${waiting} ${waiting === 1 ? 'item needs' : 'items need'} your input` : 'Tasks'} aria-label="Tasks" aria-pressed={active}>
      <span className="sidebar-island__icon"><Glyph name="tasks" size={18} /></span><span className="sidebar-island__label">Tasks</span>
      {!attentionKnown ? <span className="sidebar-island__count" aria-label="Pending input count unavailable">?</span> : waiting > 0 && <span className="sidebar-island__count" aria-label={`${waiting} waiting on you`}>{waiting}</span>}
    </button>
  );
}


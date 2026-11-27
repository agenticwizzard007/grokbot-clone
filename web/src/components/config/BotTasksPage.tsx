import { useState } from 'react';
import type { Bot } from '@shared/types';
import { Row, Section } from '../layout';
import { useTasks, useNeedsYou } from './taskData';
import { openNeedsYou } from './TaskCards';
import { openConversation } from '../../configStore';
import { prefillComposer } from '../Composer';
import { Segmented } from './ui';

export function BotTasksPage({ bot }: { bot: Bot }) {
  const tasks = useTasks(bot.id), attention = useNeedsYou(bot.id);
  const [filter, setFilter] = useState('open');
  const visible = tasks.tasks?.filter(task => filter === 'all' || (filter === 'done') === (task.state === 'done'));
  const showAttention = filter !== 'done';
  const empty = tasks.tasks !== null && (filter === 'done' || attention.items !== null) && !visible?.length && (!showAttention || !attention.items?.length);
  return <Section title="Tasks" action={<button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => { prefillComposer(bot.id, 'Please add a task: '); openConversation(bot.id); }}>Add task</button>}>
    <Segmented label="Task filter" value={filter} options={[{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }, { value: 'all', label: 'All' }]} onChange={setFilter} />
    {(tasks.error || attention.error) && <Row title="Could not refresh" trailing={<button className="cfg-btn cfg-btn--secondary" onClick={() => { tasks.retry(); attention.retry(); }}>Retry</button>} />}
    {showAttention && attention.items?.map(item => <Row key={item.id} title={item.title} trailing={<button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => openNeedsYou(item)}>Review</button>} />)}
    {visible?.map(task => <Row key={task.id} title={task.title} subtitle={<span className="pb-pill">{task.state === 'done' ? 'Done' : task.state === 'working' ? 'Doing' : 'Needs you'}</span>} trailing={<button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => openConversation(bot.id)}>Open chat</button>} />)}
    {!tasks.error && !attention.error && (tasks.tasks === null || showAttention && attention.items === null) && <p role="status">Loading tasks...</p>}
    {empty && !tasks.error && (!showAttention || !attention.error) && <p>No tasks yet.</p>}
  </Section>;
}

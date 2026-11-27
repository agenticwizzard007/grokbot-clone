import { useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { Card, Row, Section } from '../layout';
import { configApi, type BotAnalytics } from '../../lib/configApi';
import { useNeedsYou, useTasks } from './taskData';
import { openNeedsYou } from './TaskCards';
import { navigation, openConversation, useConfigUI } from '../../configStore';
import { MembersCard } from '../MembersCard';
import { VoiceSettings } from '../VoiceSettings';
import { fmtHours } from './BotAnalyticsTab';
import { HandoffList } from '../../handoffs/HandoffList';

export function BotActivity({ bot }: { bot: Bot }) {
  const tasks = useTasks(bot.id);
  const attention = useNeedsYou(bot.id);
  const [runs, setRuns] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/jobs', { credentials: 'include', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Runs unavailable');
      const { jobs } = await response.json() as { jobs?: { bot_id: string; created_at: number }[] };
      if (!jobs || controller.signal.aborted) return;
      const since = Date.now() - 7 * 86400000;
      const count = jobs.filter(job => job.bot_id === bot.id && job.created_at >= since).length;
      setRuns(`${count}${jobs.length >= 200 && jobs[jobs.length - 1].created_at >= since ? '+' : ''}`);
    }).catch(() => {});
    return () => controller.abort();
  }, [bot.id]);
  const [analytics, setAnalytics] = useState<BotAnalytics | null>(null);
  useEffect(() => { let current = true; configApi.botAnalytics(bot.id, '7d').then(value => { if (current) setAnalytics(value); }).catch(() => {}); return () => { current = false; }; }, [bot.id]);
  return <>
    <Section><div className="pb-activity-stats">
      <Card><span>Runs this week</span><strong>{runs ?? '-'}</strong></Card>
      <Card><span>Approvals</span><strong>{attention.items ? attention.items.filter(item => item.type === 'approval').length : '-'}</strong><small>Pending</small></Card>
      <Card><span>Time saved</span><strong>{analytics?.totals ? fmtHours(analytics.totals.minutesSaved) : '-'}</strong><small>Estimated</small></Card>
    </div></Section>
    <Section title="Activity">
      {(tasks.error || attention.error) && <Row title="Could not refresh" trailing={<button className="cfg-btn cfg-btn--secondary" onClick={() => { tasks.retry(); attention.retry(); }}>Retry</button>} />}
      {attention.items?.map(item => <Row key={`${item.type}:${item.id}`} title={item.title} trailing={<button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => openNeedsYou(item)}>Review</button>} />)}
      {tasks.tasks?.slice(0, 5).map(task => <Row key={task.id} title={task.title} trailing={<button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => openConversation(bot.id)}>{task.state === 'done' ? 'View result' : 'Open chat'}</button>} />)}
      {!tasks.error && !attention.error && (tasks.tasks === null || attention.items === null) && <p role="status">Loading activity...</p>}
      {!tasks.error && !attention.error && tasks.tasks !== null && attention.items !== null && !tasks.tasks.length && !attention.items.length && <p>No activity yet.</p>}
    </Section>
    {bot.kind !== 'room' && <HandoffList key={bot.id} botId={bot.id} />}
    {bot.kind === 'room' ? <Section title="Members"><MembersCard room={bot} /></Section> : <details className="pb-disclosure"><summary>More</summary>
      <Row title="Routines" trailing={<button className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openBotSettings(bot.id, 'routines')}>Manage routines</button>} />
      <Row title="Computer" trailing={<button className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openAppSettings('computer')}>Computer settings</button>} />
      <Row title="Goals" trailing={<button className="cfg-btn cfg-btn--secondary" onClick={() => navigation.navigate({ kind: 'work', route: { tab: 'Goals' } })}>Open goals</button>} />
      <VoiceSettings bot={bot} compact />
    </details>}
  </>;
}

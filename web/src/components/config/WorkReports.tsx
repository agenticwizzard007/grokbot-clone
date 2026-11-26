import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { useConfigUI } from '../../configStore';
import { DeliverablesPanel, type DeliveryReviewHeading } from './DeliverablesPanel';
import { SynopsesPanel } from './SynopsesPanel';
import { WorkRoutines } from './WorkRoutines';
import { workBotKey } from './workScope';

type ReportPage = 'reports' | 'synopses' | 'routines';
/** `picked` is true once the user chose the Report Bot themselves (R2F-014 names a Bot only then). */
export type ReportLocation = { botId: string; page: ReportPage; picked?: boolean };

export function WorkReports({ botId, location, onLocation, onHeading }: { botId?: string; location?: ReportLocation; onLocation: (location: ReportLocation) => void; onHeading: (heading?: { title: string; subtitle: string; detail?: boolean }) => void }) {
  const [review, setReview] = useState<DeliveryReviewHeading>();
  const bots = useStore(state => state.bots).filter(bot => bot.kind !== 'room');
  const contextBotId = useConfigUI(state => state.workBotId);
  const ownerId = botId ?? contextBotId ?? location?.botId ?? '';
  const page = location?.botId === ownerId ? location.page : 'reports';
  const picked = !!botId || (location?.botId === ownerId && !!location.picked);
  const setPage = (next: ReportPage) => onLocation({ botId: ownerId, page: next, picked });
  const bot = bots.find(item => item.id === ownerId);
  const activePage = page === 'synopses' && !bot?.isPrimary ? 'reports' : page;
  const name = bot?.name;
  useEffect(() => {
    if (!name) { onHeading(undefined); return; }
    // R2F-014: fixed titles; the Bot is named only after the user picked it.
    const scope = picked ? `${name} · ` : '';
    if (activePage === 'reports') onHeading(review ?? { title: 'Files', subtitle: `${scope}View and download files saved by this Bot, or review where to send them.` });
    else if (activePage === 'synopses') onHeading({ title: 'Daily synopses', subtitle: 'Scheduled summaries are saved in Files.' });
    else onHeading({ title: 'Routines', subtitle: `${scope}See what runs automatically and what happened on earlier runs.` });
  }, [name, activePage, onHeading, review, picked]);
  return <>
    {!review && (!botId || !bot) && <label className="work-field work-reports-owner">Bot<select value={ownerId} disabled={!!botId} onChange={event => {
      useConfigUI.getState().rememberWorkBot(event.currentTarget.value);
      onLocation({ botId: event.currentTarget.value, page: 'reports', picked: true });
    }}><option value="" disabled>Choose a Bot</option>{ownerId && !bot && <option value={ownerId} disabled>Bot unavailable</option>}{bots.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    {!bot && <p role="status">Choose an available Bot to see its saved work.</p>}
    {bot && activePage === 'reports' && <>
      <DeliverablesPanel key={workBotKey(bot)} botId={bot.id} workspace onReview={setReview} onSynopses={bot.isPrimary ? () => setPage('synopses') : undefined} />
      {!review && <>
        {bot.isPrimary && <div className="work-row"><div className="work-row__body"><div><h3>Daily synopses</h3><p className="work-meta">Summaries and coverage history.</p></div><button className="work-button" type="button" onClick={() => setPage('synopses')}>Daily synopses</button></div></div>}
        <div className="work-row"><div className="work-row__body"><div><h3>Routines</h3><p className="work-meta">Scheduled work and recent runs.</p></div><button className="work-button" type="button" onClick={() => setPage('routines')}>Routines</button></div></div>
      </>}
    </>}
    {bot && activePage === 'synopses' && <SynopsesPanel key={workBotKey(bot)} workspace onReports={() => setPage('reports')} />}
    {bot && activePage === 'routines' && <WorkRoutines key={workBotKey(bot)} bot={bot} onReports={() => setPage('reports')} />}
  </>;
}

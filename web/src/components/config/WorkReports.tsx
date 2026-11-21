import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { DeliverablesPanel, type DeliveryReviewHeading } from './DeliverablesPanel';
import { SynopsesPanel } from './SynopsesPanel';
import { WorkRoutines } from './WorkRoutines';
import { workBotKey } from './workScope';

type ReportPage = 'reports' | 'synopses' | 'routines';
export type ReportLocation = { botId: string; page: ReportPage };

export function WorkReports({ botId, location, onLocation, onHeading }: { botId?: string; location?: ReportLocation; onLocation: (location: ReportLocation) => void; onHeading: (heading?: { title: string; subtitle: string; detail?: boolean }) => void }) {
  const [review, setReview] = useState<DeliveryReviewHeading>();
  const bots = useStore(state => state.bots).filter(bot => bot.kind !== 'room');
  const primary = bots.find(bot => bot.isPrimary);
  const ownerId = botId ?? location?.botId ?? primary?.id ?? bots[0]?.id ?? '';
  const page = location?.botId === ownerId ? location.page : 'reports';
  const setPage = (next: ReportPage) => onLocation({ botId: ownerId, page: next });
  const bot = bots.find(item => item.id === ownerId);
  const activePage = page === 'synopses' && !bot?.isPrimary ? 'reports' : page;
  const name = bot?.name;
  useEffect(() => {
    if (!name) onHeading(undefined);
    else if (activePage === 'reports') onHeading(review ?? { title: 'Saved reports', subtitle: `${name} · Download saved reports, save in Library or review where they will be sent.` });
    else if (activePage === 'synopses') onHeading({ title: 'Daily synopses', subtitle: `${name}’s scheduled summaries are saved in Library.` });
    else onHeading({ title: `${name} · Routines`, subtitle: 'See what runs automatically and what happened on earlier runs.' });
  }, [name, activePage, onHeading, review]);
  return <>
    {!review && (!botId || !bot) && <label className="work-field work-reports-owner">Report bot<select value={ownerId} disabled={!!botId} onChange={event => onLocation({ botId: event.currentTarget.value, page: 'reports' })}><option value="" disabled>Choose a bot</option>{ownerId && !bot && <option value={ownerId} disabled>Bot unavailable</option>}{bots.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    {!bot && <p role="status">Choose an available agent to see its saved work.</p>}
    {bot && activePage === 'reports' && <>
      <DeliverablesPanel key={workBotKey(bot)} botId={bot.id} workspace onReview={setReview} />
      {!review && <>
        {bot.isPrimary && <div className="work-row"><div className="work-row__body"><div><h3>Daily synopses</h3><p className="work-meta">{bot.name}’s summaries and coverage history.</p></div><button className="work-button" type="button" onClick={() => setPage('synopses')}>Daily synopses</button></div></div>}
        <div className="work-row"><div className="work-row__body"><div><h3>Routines</h3><p className="work-meta">Scheduled work and recent runs for {bot.name}.</p></div><button className="work-button" type="button" onClick={() => setPage('routines')}>Routines</button></div></div>
      </>}
    </>}
    {bot && activePage === 'synopses' && <SynopsesPanel key={workBotKey(bot)} workspace onReports={() => setPage('reports')} />}
    {bot && activePage === 'routines' && <WorkRoutines key={workBotKey(bot)} bot={bot} onReports={() => setPage('reports')} />}
  </>;
}

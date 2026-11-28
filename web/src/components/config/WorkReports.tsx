import { useEffect } from 'react';
import { ArrowUpRight, CalendarClock, FileClock } from 'lucide-react';
import { useStore } from '../../store';
import { ArtifactLibrary } from '../../artifacts/ArtifactLibrary';
import { SynopsesPanel } from './SynopsesPanel';
import { WorkRoutines } from './WorkRoutines';
import { workBotKey } from './workScope';

type ReportPage = 'reports' | 'synopses' | 'routines';
export type ReportLocation = { botId: string; page: ReportPage; picked?: boolean };
export function WorkReports({ botId, location, onLocation, onHeading }: { botId?: string; location?: ReportLocation; onLocation: (location: ReportLocation) => void; onHeading: (heading?: { title: string; subtitle: string; detail?: boolean }) => void }) {
  const bots = useStore(state => state.bots).filter(bot => bot.kind !== 'room');
  const ownerId = botId ?? location?.botId;
  const bot = bots.find(item => item.id === ownerId) ?? bots.find(item => item.isPrimary) ?? bots[0];
  const page = location?.page ?? 'reports';
  const setPage = (next: ReportPage) => { if (bot) onLocation({ botId: bot.id, page: next, picked: !!botId }); };
  useEffect(() => {
    onHeading({ title: page === 'synopses' ? 'Daily synopses' : page === 'routines' ? 'Routines' : 'Artifacts', subtitle: 'Create, share, and collaborate on your team’s work.' });
  }, [page, onHeading]);
  return <>
    {page === 'reports' && <>
      <ArtifactLibrary botId={botId} />
      {bot && <div className="artifact-related"><span>Keep the work flowing</span>{bot.isPrimary && <button type="button" onClick={() => setPage('synopses')}><FileClock size={15} aria-hidden />Daily synopses<ArrowUpRight size={13} aria-hidden /></button>}<button type="button" onClick={() => setPage('routines')}><CalendarClock size={15} aria-hidden />Routines<ArrowUpRight size={13} aria-hidden /></button></div>}
    </>}
    {bot && page === 'synopses' && <SynopsesPanel key={workBotKey(bot)} workspace onReports={() => setPage('reports')} />}
    {bot && page === 'routines' && <WorkRoutines key={workBotKey(bot)} bot={bot} onReports={() => setPage('reports')} />}
  </>;
}

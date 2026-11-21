import { useEffect, useState, type ReactNode } from 'react';
import type { Bot, ComputerState, Routine } from '@shared/types';
import { api, openPopup } from '../lib/api';
import { clearImportedSetup, hasImportedSetup } from '../lib/setupApi';
import { displayName, useSelectedBot, useStore } from '../store';
import { SetupPaperHeader } from './SetupPaperHeader';
import { VoiceSettings } from './VoiceSettings';
import { MembersCard } from './MembersCard';
import { useConfigUI } from '../configStore';
import { LibraryTab } from './config/LibraryTab';
import { DeliverablesPanel } from './config/DeliverablesPanel';
import { BotTasks } from './config/TasksView';
import { AgentConfiguration } from './config/AgentConfiguration';
import '../styles/setup-paper.css';

export function computerStatusText(computer: ComputerState | null): string {
  if (computer?.provider === 'local') return computer.status === 'running' ? 'Connected' : 'Not connected';
  switch (computer?.status) {
    case 'running': return 'Awake';
    case 'starting': case 'resuming': case 'creating': return 'Agent waking up';
    case 'suspending': return 'Going to sleep…';
    case 'error': return 'Unreachable';
    default: return 'Asleep';
  }
}

function DetailRow({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return <div className="details-page__row"><div><strong>{title}</strong>{description && <p>{description}</p>}</div>{children}</div>;
}

function RoutineRow({ routine }: { routine: Routine }) {
  const userId = useStore(state => state.user?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toggle = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const { routine: next } = await api.setRoutine(routine.id, !routine.enabled);
      const state = useStore.getState();
      if (state.user?.id === userId && state.routines[routine.botId]) state.set({
        routines: { ...state.routines, [routine.botId]: state.routines[routine.botId].map(item => item.id === next.id ? next : item) },
      });
    }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  return <>
    <DetailRow title={routine.name} description={routine.enabled ? routine.description || routine.schedule : 'Paused'}>
      <button type="button" role="switch" aria-checked={routine.enabled} aria-label={routine.name} className={`toggle${routine.enabled ? ' is-on' : ''}`} onClick={() => void toggle()} disabled={busy}><span className="toggle__knob" /></button>
    </DetailRow>
    {error && <p className="cfg-error" role="alert">{error}</p>}
  </>;
}

function ComputerRow() {
  const computer = useStore(state => state.computer);
  const [waking, setWaking] = useState(false);
  const [error, setError] = useState('');
  const wake = async () => {
    setWaking(true); setError('');
    try { await api.ensureComputer(); }
    catch (failure) { setError((failure as Error).message); }
    finally { setWaking(false); }
  };
  const offline = !computer || ['absent', 'stopped', 'suspended', 'error'].includes(computer.status);
  return <>
    <DetailRow title="Computer" description={computerStatusText(computer)}>
      <div className="setup-paper__actions">
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useStore.getState().set({ viewerOpen: true })}>Open computer</button>
        {offline && (computer?.provider === 'local'
          ? <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openAppSettings('computer')}>Connect your PC</button>
          : <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void wake()} disabled={waking}>{waking ? 'Waking…' : 'Wake computer'}</button>)}
      </div>
    </DetailRow>
    {(error || computer?.error) && <p className="cfg-error" role="alert">{error || computer?.error}</p>}
  </>;
}

const sections = [
  { id: 'activity', label: 'Activity' }, { id: 'tasks', label: 'Tasks' }, { id: 'library', label: 'Files' }, { id: 'configuration', label: 'Setup' },
] as const;
type DetailTab = typeof sections[number]['id'];

export function DetailsPanel() {
  const bot = useSelectedBot();
  const userId = useStore(state => state.user?.id);
  return bot ? <ConversationDetails key={JSON.stringify([userId, bot.id])} bot={bot} userId={userId} /> : null;
}

function ConversationDetails({ bot, userId }: { bot: Bot; userId?: string }) {
  const routines = useStore(state => state.routines[bot.id]);
  const [tab, setTab] = useState<DetailTab>(() => hasImportedSetup(userId, bot.id) ? 'configuration' : 'activity');
  const [reports, setReports] = useState(false);
  const [voice, setVoice] = useState(false);
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackError, setSlackError] = useState('');
  const [hideSuggested, setHideSuggested] = useState(() => { try { return localStorage.getItem('swarm.hideSuggested') === '1'; } catch { return false; } });
  useEffect(() => { clearImportedSetup(userId, bot.id); }, [userId, bot.id]);
  const close = () => useStore.getState().set({ detailsOpen: false });
  const addSlack = async () => {
    if (slackBusy) return;
    setSlackBusy(true); setSlackError('');
    const popup = openPopup('about:blank');
    try {
      const { redirectUrl } = await api.connect('slack');
      if (useStore.getState().user?.id !== userId || useStore.getState().selectedBotId !== bot.id) { popup?.close(); return; }
      if (popup && !popup.closed) popup.location.href = redirectUrl;
      else if (!window.open(redirectUrl, '_blank', 'noopener')) setSlackError('Allow pop-ups, then try again.');
    } catch (failure) { popup?.close(); setSlackError((failure as Error).message); }
    finally { setSlackBusy(false); }
  };
  const hideSuggestion = () => {
    setHideSuggested(true);
    try { localStorage.setItem('swarm.hideSuggested', '1'); } catch { return; }
  };
  const openSettings = () => useConfigUI.getState().openBotSettings(bot.id);
  const openRoutines = () => useConfigUI.getState().openBotSettings(bot.id, 'routines');
  const title = displayName(bot);
  const label = reports ? 'Saved reports' : sections.find(section => section.id === tab)?.label;
  const navigation = <nav className="setup-paper__tabs details-page__tabs" aria-label="Conversation details sections">
    {sections.filter(section => bot.kind !== 'room' || section.id !== 'configuration').map(section =>
      <button key={section.id} type="button" aria-current={tab === section.id || undefined} onClick={() => { setTab(section.id); setReports(false); }}>{section.label}</button>)}
  </nav>;
  return <main className={`details details--page setup-paper${tab === 'configuration' ? ' details--configuration' : ''}`} aria-label="Conversation details">
    <SetupPaperHeader backLabel={reports ? 'Back to files' : 'Back to chat'} title={label} onBack={reports ? () => setReports(false) : close} onClose={close} closeLabel="Close details" />
    <div className="setup-paper__column details-page__column">
      {tab !== 'configuration' && <div><h1>{reports ? 'Saved reports' : tab === 'activity' ? title : `${title} · ${label}`}</h1>
        <p className="setup-paper__subtitle">{reports ? 'Review immutable saved artifacts and delivery attempts.' : tab === 'activity' ? 'Activity for this conversation.' : tab === 'library' ? `Files saved by ${title}` : 'Work assigned to this conversation.'}</p></div>}
      {tab !== 'configuration' && navigation}
      {tab === 'activity' && <>
        <section aria-label="Upcoming activity" className="details-page__activity">
          <h2>Upcoming</h2>
          {routines?.length ? routines.map(routine => <RoutineRow key={routine.id} routine={routine} />) : <p className="setup-paper__subtitle">Nothing scheduled. Ask in chat or manage routines.</p>}
          <DetailRow title="Routines"><button type="button" className="cfg-btn cfg-btn--secondary" onClick={openRoutines}>Manage routines</button></DetailRow>
          {bot.kind === 'room' ? <section><h2>Members</h2><MembersCard room={bot} /></section> : <>
            {!hideSuggested && <><DetailRow title="Suggested"><button type="button" className="cfg-btn cfg-btn--secondary" onClick={hideSuggestion}>Hide suggestion</button></DetailRow>
              <DetailRow title="Slack"><button type="button" className="cfg-btn cfg-btn--secondary" disabled={slackBusy} onClick={() => void addSlack()}>{slackBusy ? 'Opening…' : 'Add to Slack'}</button></DetailRow></>}
            {slackError && <p className="cfg-error" role="alert">{slackError}</p>}
            <ComputerRow />
            <DetailRow title="Voice chat"><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setVoice(!voice)} aria-expanded={voice}>{voice ? 'Hide voice settings' : 'Voice settings'}</button></DetailRow>
            {voice && <VoiceSettings bot={bot} />}
          </>}
          <DetailRow title="Bot settings" description="General, analytics, and bot configuration."><button type="button" className="cfg-btn cfg-btn--secondary" onClick={openSettings}>Bot settings</button></DetailRow>
        </section>
        <div className="setup-paper__actions"><button type="button" className="cfg-btn cfg-btn--primary" onClick={close}>Close details</button></div>
      </>}
      {tab === 'tasks' && <BotTasks bot={bot} />}
      {tab === 'configuration' && <AgentConfiguration bot={bot} navigation={navigation} />}
      {tab === 'library' && (reports ? <DeliverablesPanel botId={bot.id} /> : <>
        <DetailRow title="Saved reports"><button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => setReports(true)}>Saved reports</button></DetailRow>
        <LibraryTab bot={bot} onClose={close} />
      </>)}
    </div>
  </main>;
}

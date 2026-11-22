import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Clock3, Monitor, Settings } from 'lucide-react';
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
import { BotAvatarFor } from '../avatar/BotAvatar';
import { userFacingLive } from '../lib/audience';
import { hasOpenModal } from './modals/Modal';
import { detailsReplaceChat } from '../lib/useDetailsLayout';
import '../styles/setup-paper.css';
import '../styles/bot-details.css';

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
  return <section className="bot-detail-section" aria-label="Computer">
    <h2>Computer</h2>
    <div className="bot-detail-card">
      <button type="button" className="bot-detail-link" aria-label="Open computer" onClick={() => useStore.getState().set({ viewerOpen: true })}>
        <Monitor size={20} aria-hidden /><span><strong>Bot’s computer</strong><small>{computerStatusText(computer)}</small></span><ChevronRight size={18} aria-hidden />
      </button>
        {offline && (computer?.provider === 'local'
          ? <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => useConfigUI.getState().openAppSettings('computer')}>Connect your PC</button>
          : <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void wake()} disabled={waking}>{waking ? 'Waking…' : 'Wake computer'}</button>)}
    </div>
    {(error || computer?.error) && <p className="cfg-error" role="alert">{error || computer?.error}</p>}
  </section>;
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
  const panel = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const routines = useStore(state => state.routines[bot.id]);
  const live = userFacingLive(useStore(state => state.live[bot.id]));
  const [tab, setTab] = useState<DetailTab>(() => hasImportedSetup(userId, bot.id) ? 'configuration' : 'activity');
  const [reports, setReports] = useState(false);
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackError, setSlackError] = useState('');
  const [hideSuggested, setHideSuggested] = useState(() => { try { return localStorage.getItem('swarm.hideSuggested') === '1'; } catch { return false; } });
  useEffect(() => { clearImportedSetup(userId, bot.id); }, [userId, bot.id]);
  const close = () => {
    useStore.getState().set({ detailsOpen: false });
    requestAnimationFrame(() => {
      // Do not override focus already restored by cleanup or moved by the user.
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && active.isConnected && active.getClientRects().length) return;
      const target = returnFocus.current;
      if (target?.isConnected && target.getClientRects().length && !target.closest('[inert]')) target.focus({ preventScroll: true });
    });
  };
  useLayoutEffect(() => {
    const element = panel.current;
    const previous = document.activeElement as HTMLElement | null;
    returnFocus.current = previous;
    element?.querySelector<HTMLButtonElement>('.setup-paper__close')?.focus({ preventScroll: true });
    return () => {
      if (element?.contains(document.activeElement) && previous?.isConnected && previous.getClientRects().length) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || hasOpenModal() || !panel.current?.getClientRects().length) return;
      event.preventDefault(); close();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
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
  return <aside id="bot-details" ref={panel} className={`details details--page details--sidebar setup-paper${tab === 'configuration' ? ' details--configuration' : ''}`} aria-label="Conversation details">
    <SetupPaperHeader backLabel={reports ? 'Back to files' : 'Back to chat'} title={label} onBack={reports ? () => setReports(false) : close} onClose={close} closeLabel="Close details" />
    <div className="setup-paper__column details-page__column">
      <div className="bot-detail-identity">
        <BotAvatarFor bot={bot} size={64} />
        <h1>{bot.name}</h1>
        {bot.label && <p>{bot.label}</p>}
        {live?.awaiting ? <span className="bot-detail-status is-waiting">Needs your reply</span> : live?.isRunning ? <span className="bot-detail-status">Working…</span> : null}
      </div>
      {navigation}
      {tab === 'activity' && <>
        <div className="details-page__activity">
          <section aria-label="Upcoming activity" className="bot-detail-section">
            <div className="bot-detail-section__heading"><h2>Upcoming</h2><button type="button" className="link-btn" onClick={openRoutines}>Manage routines</button></div>
            <div className="bot-detail-card">
              {routines?.length ? routines.map(routine => <RoutineRow key={routine.id} routine={routine} />) : <div className="bot-detail-empty"><Clock3 size={20} aria-hidden /><p>Nothing scheduled.<br /><span>Ask in chat or add a routine.</span></p></div>}
            </div>
          </section>
          <BotTasks bot={bot} />
          {bot.kind === 'room' ? <section className="bot-detail-section"><h2>Members</h2><div className="bot-detail-card"><MembersCard room={bot} /></div></section> : <>
            {!hideSuggested && <section className="bot-detail-section">
              <div className="bot-detail-section__heading"><h2>Suggested</h2><button type="button" className="link-btn" onClick={hideSuggestion}>Hide suggestion</button></div>
              <div className="bot-detail-card"><DetailRow title="Slack"><button type="button" className="cfg-btn cfg-btn--secondary" disabled={slackBusy} onClick={() => void addSlack()}>{slackBusy ? 'Opening…' : 'Add to Slack'}</button></DetailRow></div>
            </section>}
            {slackError && <p className="cfg-error" role="alert">{slackError}</p>}
            <ComputerRow />
            <VoiceSettings bot={bot} compact onStartCall={() => { if (detailsReplaceChat()) close(); }} />
          </>}
          <div className="bot-detail-card"><button type="button" className="bot-detail-link" aria-label="Bot settings" onClick={openSettings}><Settings size={20} aria-hidden /><span><strong>Bot settings</strong><small>General, analytics, and configuration</small></span><ChevronRight size={18} aria-hidden /></button></div>
        </div>
      </>}
      {tab === 'tasks' && <BotTasks bot={bot} />}
      {tab === 'configuration' && <AgentConfiguration bot={bot} />}
      {tab === 'library' && (reports ? <DeliverablesPanel botId={bot.id} /> : <>
        <p className="setup-paper__subtitle">Files saved by {title}</p>
        <DetailRow title="Saved reports"><button className="cfg-btn cfg-btn--secondary" type="button" onClick={() => setReports(true)}>Saved reports</button></DetailRow>
        <LibraryTab bot={bot} onClose={close} />
      </>)}
    </div>
  </aside>;
}

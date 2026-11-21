import { userFacingLive } from '../lib/audience';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Bot } from '@shared/types';
import { ChevronDown, ChevronLeft } from 'lucide-react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { backToList, sortedRows, useSelectedBot, useStore } from '../store';
import { useConfigUI } from '../configStore';
import { Composer } from './Composer';
import { Menu } from './Menu';
import { Transcript } from './Transcript';
import { VoiceCallBar } from './VoiceCallBar';

export function ChatView() {
  const bot = useSelectedBot();
  const accountId = useStore(s => s.user?.id);
  const mobile = useStore(s => s.mobile);
  if (!bot || !accountId) return <main className="chat chat--empty"><div className="empty-chat"><div className="empty-chat__sub">No Bot selected.</div><button type="button" className="btn btn--secondary" onClick={() => mobile ? backToList() : useConfigUI.getState().setView('bots')}>Your bots</button></div></main>;
  return <BotChat key={`${accountId}:${bot.id}`} accountId={accountId} bot={bot} />;
}

function BotChat({ accountId, bot }: { accountId: string; bot: Bot }) {
  const transcript = useStore(s => s.transcripts[bot.id]);
  const currentTranscript = transcript && transcript.generation >= (bot.generation ?? 0) ? transcript : undefined;
  const generation = currentTranscript?.generation ?? bot.generation;
  const live = userFacingLive(useStore(s => s.live[bot.id]));
  const detailsOpen = useStore(s => s.detailsOpen);
  const mobile = useStore(s => s.mobile);
  const otherUnread = useStore(s => s.bots.reduce((n, b) => n + (b.id !== s.selectedBotId ? b.unread || 0 : 0), 0));
  const set = useStore(s => s.set);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const freshRequest = useRef<symbol>();
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  useLayoutEffect(() => () => { freshRequest.current = undefined; clearTimeout(toastTimer.current); }, []);
  const rows = useMemo(() => sortedRows(currentTranscript), [currentTranscript]);
  const back = () => mobile ? backToList() : useConfigUI.getState().setView('bots');
  const flash = (message: string) => { clearTimeout(toastTimer.current); setToast(message); toastTimer.current = setTimeout(() => setToast(null), 3000); };
  const fresh = async () => {
    if (freshRequest.current) return;
    const request = Symbol();
    freshRequest.current = request;
    let notice: string;
    try { await api.fresh(bot.id); notice = 'Started a new conversation'; }
    catch (error) { notice = (error as Error).message; }
    if (freshRequest.current !== request) return;
    freshRequest.current = undefined;
    const state = useStore.getState();
    const ui = useConfigUI.getState();
    if (state.user?.id === accountId && state.selectedBotId === bot.id && !state.modal && !state.detailsOpen
      && ui.view === 'chat' && !ui.appSettings && !ui.botSettings && (!state.mobile || state.mobilePane === 'chat')) flash(notice);
  };
  return <main className="chat">
    <div className="chat__context">
      <button type="button" className="chat__back" onClick={back} aria-label={mobile ? otherUnread ? `All Bots, ${otherUnread} unread` : 'All Bots' : 'Back to bots'}>
        <ChevronLeft size={18} aria-hidden /><span>{mobile ? 'All Bots' : 'Back to bots'}</span>
        {mobile && otherUnread > 0 && <span className="chat__back-badge">{otherUnread > 99 ? '99+' : otherUnread}</span>}
      </button><span>Bots</span>
    </div>
    <header className="chat__header">
      <BotAvatarFor bot={bot} size={32} />
      <span className="chat__pill-anchor">
        <button type="button" className="chat__pill" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
          <span className="chat__pill-name">{bot.name}</span><ChevronDown size={14} aria-hidden />
        </button>
        <span className="chat__subtitle">{bot.label || (bot.isPrimary ? 'Your primary bot' : bot.kind === 'room' ? 'Group conversation' : bot.description || 'Your teammate')}</span>
        {menu && <Menu onClose={() => setMenu(false)} items={[
          { label: detailsOpen ? 'Hide details' : 'Show details', hint: '⇧⌘,', onSelect: () => set({ detailsOpen: !detailsOpen }) },
          { label: 'Open computer', onSelect: () => set({ viewerOpen: true }) },
          { label: 'New conversation', onSelect: fresh },
          { label: 'Bot settings', onSelect: () => useConfigUI.getState().openBotSettings(bot.id) },
        ]} />}
      </span>
      <div className="chat__header-right">
        <button type="button" className="chat__details" onClick={() => set({ detailsOpen: !detailsOpen })} aria-label={detailsOpen ? 'Hide details' : 'Show details'}>Details</button>
        <button type="button" className="share-btn" onClick={() => flash('Sharing isn’t available in Swarm yet')}>Share</button>
      </div>
    </header>
    <Transcript key={generation} bot={bot} generation={generation} rows={rows} live={live} loaded={!!currentTranscript?.loaded} />
    <VoiceCallBar />
    <Composer bot={bot} running={!!live?.isRunning} />
    {toast && <div className="toast" role="status">{toast}</div>}
  </main>;
}

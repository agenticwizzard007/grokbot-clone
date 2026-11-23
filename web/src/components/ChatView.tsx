import { userFacingLive } from '../lib/audience';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bot } from '@shared/types';
import { ChevronDown, ChevronLeft } from 'lucide-react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { backToList, sortedRows, useSelectedBot, useStore } from '../store';
import { useConfigUI } from '../configStore';
import { Composer } from './Composer';
import { Menu } from './Menu';
import { Transcript } from './Transcript';
import { VoiceCallBar } from './VoiceCallBar';
import { useFreshConversation } from '../lib/useFreshConversation';
import { shortcutLabel } from '../lib/shortcuts';
import { RosterFeedback } from './LoadFeedback';
import { SetupBanner } from './SetupBanner';

/** PD-03: no Share control until a real share feature exists. */
const FEATURE_SHARE = false;

export function ChatView() {
  const bot = useSelectedBot();
  const accountId = useStore(s => s.user?.id);
  const mobile = useStore(s => s.mobile);
  if (!bot || !accountId) return <main className="chat chat--empty"><div className="empty-chat"><RosterFeedback /><div className="empty-chat__sub">No Bot selected.</div><button type="button" className="btn btn--secondary" onClick={() => mobile ? backToList() : useConfigUI.getState().setView('bots')}>Your Bots</button></div></main>;
  return <BotChat key={`${accountId}:${bot.id}`} accountId={accountId} bot={bot} />;
}

function BotChat({ bot }: { accountId: string; bot: Bot }) {
  const transcript = useStore(s => s.transcripts[bot.id]);
  const currentTranscript = transcript && transcript.generation >= (bot.generation ?? 0) ? transcript : undefined;
  const generation = currentTranscript?.generation ?? bot.generation;
  useEffect(() => {
    const current = useStore.getState().transcripts[bot.id];
    if (!current || current.generation < bot.generation) void useStore.getState().loadRows(bot.id);
  }, [bot.id, bot.generation]);
  const live = userFacingLive(useStore(s => s.live[bot.id]));
  const detailsOpen = useStore(s => s.detailsOpen);
  const mobile = useStore(s => s.mobile);
  const otherUnread = useStore(s => s.bots.reduce((n, b) => n + (b.id !== s.selectedBotId ? b.unread || 0 : 0), 0));
  const set = useStore(s => s.set);
  const [menu, setMenu] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const rows = useMemo(() => sortedRows(currentTranscript), [currentTranscript]);
  const back = () => mobile ? backToList() : useConfigUI.getState().setView('bots');
  const fresh = useFreshConversation(bot.id);
  return <main className="chat">
    <div className="chat__context">
      <button type="button" className="chat__back" onClick={back} aria-label={mobile ? otherUnread ? `All Bots, ${otherUnread} unread` : 'All Bots' : 'Back to Bots'}>
        <ChevronLeft size={18} aria-hidden /><span>{mobile ? 'All Bots' : 'Back to Bots'}</span>
        {mobile && otherUnread > 0 && <span className="chat__back-badge">{otherUnread > 99 ? '99+' : otherUnread}</span>}
      </button><span>Bots</span>
    </div>
    <header className="chat__header">
      <button type="button" className="chat__bot-details" aria-label={`Open ${bot.name} details`} aria-expanded={detailsOpen} aria-controls={detailsOpen ? 'bot-details' : undefined} onClick={() => set({ detailsOpen: !detailsOpen })}>
        <BotAvatarFor bot={bot} size={32} working={!!live?.isRunning && !live.awaiting} />
      </button>
      <span className="chat__pill-anchor">
        <button ref={menuTrigger} type="button" className="chat__pill" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
          <span className="chat__pill-name">{bot.name}</span><ChevronDown size={14} aria-hidden />
        </button>
        <span className="chat__subtitle">{bot.label || (bot.isPrimary ? 'Your primary Bot' : bot.kind === 'room' ? 'Group conversation' : bot.description || (bot.mode === 'personal' ? 'Personal assistant' : 'Your teammate'))}</span>
        {menu && <Menu triggerRef={menuTrigger} onClose={() => setMenu(false)} items={[
          { label: detailsOpen ? 'Hide details' : 'Show details', hint: shortcutLabel('details'), onSelect: () => {
            // Details must capture the persistent trigger, not the departing menu item.
            menuTrigger.current?.focus({ preventScroll: true });
            set({ detailsOpen: !detailsOpen });
          } },
          { label: 'Open computer', onSelect: () => set({ viewerOpen: true }) },
          { label: 'New conversation', onSelect: fresh },
          { label: 'Bot settings', onSelect: () => useConfigUI.getState().openBotSettings(bot.id) },
        ]} />}
      </span>
      <div className="chat__header-right">
        <button type="button" className="chat__details" onClick={() => set({ detailsOpen: !detailsOpen })} aria-label={detailsOpen ? 'Hide details' : 'Show details'} aria-expanded={detailsOpen} aria-controls={detailsOpen ? 'bot-details' : undefined}>Details</button>
        {FEATURE_SHARE && <button type="button" className="share-btn">Share</button>}
      </div>
    </header>
    <RosterFeedback />
    <Transcript key={generation} bot={bot} generation={generation} rows={rows} live={live} loaded={!!currentTranscript?.loaded} />
    <VoiceCallBar />
    <SetupBanner bot={bot} />
    <Composer bot={bot} running={!!live?.isRunning} />
  </main>;
}

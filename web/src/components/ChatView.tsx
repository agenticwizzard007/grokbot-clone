import { RoomMembersHeader } from './MembersCard';
import { Page, Card } from './layout';
import { Mic } from 'lucide-react';
import { startCall, endCall, useVoice } from '../voice/call';
import { ShellHeaderSlot } from './ShellHeaderSlot';
import { userFacingLive } from '../lib/audience';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Bot } from '@shared/types';
import { ChevronDown } from 'lucide-react';
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
  if (!bot || !accountId) return <main className="chat chat--empty"><Page type="chat"><Card className="empty-chat"><RosterFeedback /><div className="empty-chat__sub">No Bot selected.</div><button type="button" className="btn btn--secondary" onClick={() => mobile ? backToList() : useConfigUI.getState().setView('bots')}>Your Bots</button></Card></Page></main>;
  return <BotChat key={`${accountId}:${bot.id}`} accountId={accountId} bot={bot} />;
}

function BotChat({ bot }: { accountId: string; bot: Bot }) {
  const transcript = useStore(s => s.transcripts[bot.id]);
  const currentTranscript = transcript && transcript.generation >= (bot.generation ?? 0) ? transcript : undefined;
  const generation = currentTranscript?.generation ?? bot.generation;
  useEffect(() => {
    const current = useStore.getState().transcripts[bot.id];
    if (!current || current.generation < bot.generation) void useStore.getState().loadRows(bot.id).catch(() => {});
  }, [bot.id, bot.generation]);
  const live = userFacingLive(useStore(s => s.live[bot.id]));
  const detailsOpen = useStore(s => s.detailsOpen);
  const mobile = useStore(s => s.mobile);
  const set = useStore(s => s.set);
  const [menu, setMenu] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const rows = useMemo(() => sortedRows(currentTranscript), [currentTranscript]);
  const voice = useVoice();
  const fresh = useFreshConversation(bot.id);
  return <main className="chat">
    <ShellHeaderSlot><header className="chat__header">
      <button type="button" className="chat__bot-details" aria-label={mobile ? detailsOpen ? 'Hide details' : 'Show details' : `Open ${bot.name} details`} aria-expanded={detailsOpen} aria-controls={detailsOpen ? 'bot-details' : undefined} onClick={() => set({ detailsOpen: !detailsOpen })}>
        <BotAvatarFor bot={bot} size={32} working={!!live?.isRunning && !live.awaiting} />
      </button>
      <span className="chat__pill-anchor">
        <button ref={menuTrigger} type="button" className="chat__pill" aria-label={bot.name} onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
          <span className="chat__pill-name" title={bot.name}>{bot.name.split(/\s+/).some(word => word.length > 12) ? 'Bot' : bot.name}</span><ChevronDown size={14} aria-hidden />
        </button>
        <span className="chat__subtitle">{bot.label || (bot.isPrimary ? 'Primary' : bot.kind === 'room' ? 'Group conversation' : (bot.mode === 'personal' ? 'Personal assistant' : 'Your teammate'))}</span>
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
        <button type="button" className="chat__voice icon-btn" aria-label={voice.botId === bot.id && voice.status === 'live' ? 'End call' : 'Start voice call'} disabled={voice.status === 'connecting'} onClick={() => voice.botId === bot.id && voice.status === 'live' ? endCall() : void startCall(bot.id)}><Mic size={18} aria-hidden /></button>
        {!mobile && <button type="button" className="chat__details" onClick={() => set({ detailsOpen: !detailsOpen })} aria-label={detailsOpen ? 'Hide details' : 'Show details'} aria-expanded={detailsOpen} aria-controls={detailsOpen ? 'bot-details' : undefined}>Details</button>}
        {FEATURE_SHARE && <button type="button" className="share-btn">Share</button>}
      </div>
    </header></ShellHeaderSlot>
    {bot.kind === 'room' && <RoomMembersHeader room={bot} />}
    <RosterFeedback />
    <Transcript key={generation} bot={bot} generation={generation} rows={rows} live={live} loaded={!!currentTranscript?.loaded} />
    <Page type="chat" className="chat-dock">
      <VoiceCallBar />
      <SetupBanner bot={bot} />
      <Composer bot={bot} running={!!live?.isRunning} />
    </Page>
  </main>;
}

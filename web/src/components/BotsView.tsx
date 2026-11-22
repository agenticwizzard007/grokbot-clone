import { ChevronRight, Plus, Search } from 'lucide-react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { openConversation, useConfigUI } from '../configStore';
import { displayName, useStore } from '../store';
import { userFacingLive } from '../lib/audience';

export function BotsView() {
  const bots = useStore(s => s.bots);
  const live = useStore(s => s.live);
  const open = openConversation;
  return <main className="bots-view"><div className="bots-view__inner">
    <h1>Your Bots</h1><p className="bots-view__intro">Pick up where you left off.</p>
    <div className="bots-view__actions">
      <button type="button" className="btn btn--secondary" onClick={() => useStore.getState().setModal('search')}><Search size={18} aria-hidden /> Search Bots</button>
      <button type="button" className="btn btn--primary" onClick={() => useStore.getState().setModal('create')}><Plus size={18} aria-hidden /> Create a Bot</button>
      <button type="button" className="btn btn--secondary" onClick={() => useConfigUI.getState().setView('tasks')}>All tasks</button>
    </div>
    <div className="bots-view__list">{[...bots].sort((a,b) => Number(!!b.isPrimary) - Number(!!a.isPrimary) || b.lastActivityAt - a.lastActivityAt).map(bot => {
      const state = userFacingLive(live[bot.id]);
      return <button type="button" className="bots-view__item" key={bot.id} onClick={() => open(bot.id)}>
        <BotAvatarFor bot={bot} size={36} /><span><strong>{displayName(bot)}</strong><small>{state?.awaiting ? `Waiting for you: ${state.awaiting.reason}` : state?.isRunning ? 'Working…' : bot.lastPreview || bot.description || 'No messages yet'}</small></span><ChevronRight size={18} aria-hidden />
      </button>;
    })}</div>
    {!bots.length && <p className="bots-view__intro">Create a Bot to get started.</p>}
  </div></main>;
}

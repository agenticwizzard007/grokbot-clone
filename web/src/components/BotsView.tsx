import { useComponentVisible } from '../customization';
import { RosterFeedback } from './LoadFeedback';
import { Plus, Users } from 'lucide-react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { openConversation } from '../configStore';
import { displayName, useStore } from '../store';
import { isInSetup } from '../lib/botSetupState';
import { userFacingLive } from '../lib/audience';
import { ButtonGroup, Card, Page, Section } from './layout';
import '../styles/bot-details.css';

export function BotsView() {
  const statusChips = useComponentVisible('bots.statusChips');
  const roomsSection = useComponentVisible('bots.roomsSection');
  const ready = useStore(s => s.botsLoaded && !s.botsError && !s.botsLoading);
  const bots = useStore(s => s.bots);
  const live = useStore(s => s.live);
  const create = () => useStore.getState().setModal('create');
  const rooms = bots.filter(bot => bot.kind === 'room');
  const roster = bots.filter(bot => bot.kind !== 'room').sort((a, b) => Number(!!b.isPrimary) - Number(!!a.isPrimary) || b.lastActivityAt - a.lastActivityAt);
  return <main className="bots-view pb-bots" data-ui-id="bots.statusChips" data-ui-visibility={statusChips}><Page type="list">
    <header className="pb-bots__heading"><h1>Your Bots</h1><ButtonGroup>
      <button type="button" className="btn btn--secondary" onClick={() => useStore.getState().setModal('group')}><Users size={16} aria-hidden />New room</button>
      <button type="button" className="btn btn--primary" onClick={create}><Plus size={16} aria-hidden />Create a Bot</button>
    </ButtonGroup></header>
    <RosterFeedback />
    <Section className="pb-bots__section" title={<span className="pb-bots__phone-title">Bots</span>}>
      <div className="pb-bots__grid">{roster.map(bot => {
        const state = userFacingLive(live[bot.id]);
        const setup = isInSetup(bot);
        const status = state?.awaiting ? 'Needs you' : state?.isRunning ? 'Working' : setup ? 'Setup' : 'Ready';
        return <Card key={bot.id} className="pb-bot-card">
          <button type="button" className="pb-bot-card__open" onClick={() => openConversation(bot.id)} aria-label={`Open ${displayName(bot)}`}>
            <span className="pb-bot-card__identity"><BotAvatarFor bot={bot} size={44} /><span className="pb-bot-card__name"><strong>{displayName(bot)}</strong>{bot.isPrimary && <span className="pb-pill">Primary</span>}<small>{bot.label || (bot.mode === 'personal' ? 'Personal assistant' : 'Teammate')}</small></span><span className={`pb-pill pb-pill--${state?.awaiting ? 'warn' : state?.isRunning ? 'success' : 'neutral'}`}>{status}</span></span>
            <span className="pb-bot-card__status">{state?.awaiting ? 'Needs approval' : state?.isRunning ? 'Working' : setup ? 'Continue setup' : 'Idle'}</span>
          </button>
        </Card>;
      })}</div>
      {ready && !roster.length && <p>Create your first Bot.</p>}
    </Section>
    {roomsSection !== 'hide' && <Section data-ui-id="bots.roomsSection" title="Rooms" action={<button type="button" className="link-btn pb-bots__phone-room" onClick={() => useStore.getState().setModal('group')}>New room</button>}>
      {rooms.map(room => <Card key={room.id}><button type="button" className="pb-room-card" onClick={() => openConversation(room.id)}><Users size={24} aria-hidden /><strong>{room.name}</strong>{!!room.unread && <span className="pb-pill">{room.unread} new</span>}</button></Card>)}
      {ready && !rooms.length && <p>No rooms yet.</p>}
    </Section>}
    <button type="button" className="btn btn--primary pb-bots__phone-create" onClick={create}>Create a Bot</button>
  </Page></main>;
}

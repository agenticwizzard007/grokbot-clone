import { useCallback, useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api, type RoomMember } from '../lib/api';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Card, Page } from './layout';
import { Modal } from './modals/Modal';
import { userFacingLive } from '../lib/audience';
import '../styles/bot-details.css';
import { ACTIVATE_FIRST, activateBeforeGroup, isInSetup } from '../lib/botSetupState';

/** Members of a group chat, with add/remove. Shown in the details panel for rooms. */
export function MembersCard({ room, startAdding = false }: { room: Bot; startAdding?: boolean }) {
  const bots = useStore((s) => s.bots);
  const [members, setMembers] = useState<RoomMember[] | null>(null);
  const [adding, setAdding] = useState(startAdding);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.roomMembers(room.id).then((r) => { if (!Array.isArray(r.members)) throw new Error('Could not load members.'); setMembers(r.members); }).catch((e) => setError((e as Error).message));
  }, [room.id]);
  useEffect(load, [load]);

  const save = async (ids: string[]) => {
    setError(null);
    try { await api.setRoomMembers(room.id, ids); load(); } catch (e) { setError((e as Error).message); }
  };

  const ids = members?.map((m) => m.id) ?? [];
  // Every Bot not already here is listed; Bots still in setup show as disabled until activated (MF-034).
  const candidates = bots.filter((b) => b.kind !== 'room' && !ids.includes(b.id));
  const minimum = ids.length <= 2;

  return (
    <Card className="members">
      {members === null ? <div className="panel-empty">Loading...</div> : members.length === 0 ? (
        <div className="panel-empty">No members yet.</div>
      ) : members.map((m) => {
        const bot = bots.find((b) => b.id === m.id);
        return (
          <div key={m.id} className="panel-row members__row">
            {bot ? <BotAvatarFor bot={bot} size={24} /> : <span className="members__dot" />}
            <span className="members__text">
              <span className="members__name">{m.name}</span>
              {m.label && <span className="members__label">{m.label}</span>}
            </span>
            <button
              type="button"
              className="icon-btn members__remove"
              aria-label={minimum ? `Remove ${m.name}. A group needs at least 2 Bots.` : `Remove ${m.name}`}
              title={minimum ? 'A group needs at least 2 Bots.' : `Remove ${m.name}`}
              onClick={() => save(ids.filter((x) => x !== m.id))}
              disabled={minimum}
            >
              <Icon name="close" size={10} opacity={0.56} />
            </button>
          </div>
        );
      })}
      {adding ? (
        <div className="members__add">
          {candidates.length ? candidates.map((b) => {
            const locked = isInSetup(b);
            return (
              <button key={b.id} type="button" className="panel-row panel-row--link" disabled={locked} aria-disabled={locked || undefined}
                title={locked ? activateBeforeGroup(b.name) : undefined}
                onClick={() => { if (locked) return; setAdding(false); save([...ids, b.id]); }}>
                <BotAvatarFor bot={b} size={20} />
                <span className="panel-row__title" style={{ flex: 1 }}>{b.name}</span>
                {locked && <span className="members__label">{ACTIVATE_FIRST}</span>}
              </button>
            );
          }) : <div className="panel-empty">Every Bot is already here.</div>}
        </div>
      ) : (
        <button type="button" className="panel-row panel-row--action" onClick={() => setAdding(true)}>
          <Icon name="plus" size={12} opacity={0.56} /> Add Bot
        </button>
      )}
      {error && <div className="card__error">{error}</div>}
    </Card>
  );
}


export function RoomMembersHeader({ room }: { room: Bot }) {
  const bots = useStore(state => state.bots);
  const live = userFacingLive(useStore(state => state.live[room.id]));
  const transcript = useStore(state => state.transcripts[room.id]);
  const streaming = Object.values(transcript?.bySeq ?? {}).findLast(row => row.body.type === 'message' && row.body.streaming);
  const writer = streaming?.body.type === 'message' ? streaming.body.from?.name : undefined;
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { let active = true; api.roomMembers(room.id).then(value => { if (active) { if (!Array.isArray(value.members)) { setError(true); return; } setMembers(value.members); setError(false); } }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [room.id, editing, attempt]);
  return <>
    <Page type="chat" className="pb-room-header"><div className="pb-room-members" aria-label="Room members">
      <div className="pb-room-members__list">{members.map(member => {
        const bot = bots.find(bot => bot.id === member.id);
        return <span key={member.id} className="pb-room-member">
          {bot && <BotAvatarFor bot={bot} size={24} />}<span>{member.name}</span>
        </span>;
      })}</div>
      <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setEditing(true)}>Add Bot</button>
      {error && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setAttempt(value => value + 1)}>Retry members</button>}
      {(streaming || live?.isRunning && !live.awaiting) && <p className="pb-room-typing" role="status">{writer ? `${writer} is typing...` : streaming ? 'Writing a reply...' : 'Working...'}</p>}
    </div></Page>
    {editing && <Modal label="Room members" onClose={() => setEditing(false)} className="pb-members-modal"><Page type="form" title="Members"><MembersCard room={room} startAdding /><button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setEditing(false)}>Done</button></Page></Modal>}
  </>;
}

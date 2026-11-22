import { useCallback, useEffect, useState } from 'react';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { api, type RoomMember } from '../lib/api';
import { useStore } from '../store';
import { Icon } from './Icon';

/** Members of a group chat, with add/remove. Shown in the details panel for rooms. */
export function MembersCard({ room }: { room: Bot }) {
  const bots = useStore((s) => s.bots);
  const [members, setMembers] = useState<RoomMember[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.roomMembers(room.id).then((r) => setMembers(r.members)).catch((e) => setError((e as Error).message));
  }, [room.id]);
  useEffect(load, [load]);

  const save = async (ids: string[]) => {
    setError(null);
    try { await api.setRoomMembers(room.id, ids); load(); } catch (e) { setError((e as Error).message); }
  };

  const ids = members?.map((m) => m.id) ?? [];
  // Every Bot not already here is listed; Bots still in setup show as disabled until activated (MF-034).
  const candidates = bots.filter((b) => b.kind !== 'room' && !ids.includes(b.id));
  const configuring = (b: Bot) => !!(b as Bot & { onboarding?: { status: string } }).onboarding && (b as Bot & { onboarding?: { status: string } }).onboarding!.status !== 'active';
  const minimum = ids.length <= 2;

  return (
    <div className="panel-card members">
      {members === null ? <div className="panel-empty">Loading…</div> : members.length === 0 ? (
        <div className="panel-empty">No Bots in this group yet.</div>
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
            const locked = configuring(b);
            return (
              <button key={b.id} type="button" className="panel-row panel-row--link" disabled={locked} aria-disabled={locked || undefined}
                title={locked ? `Activate ${b.name} before adding it to a group.` : undefined}
                onClick={() => { if (locked) return; setAdding(false); save([...ids, b.id]); }}>
                <BotAvatarFor bot={b} size={20} />
                <span className="panel-row__title" style={{ flex: 1 }}>{b.name}</span>
                {locked && <span className="members__label">Activate first</span>}
              </button>
            );
          }) : <div className="panel-empty">Every Bot is already here.</div>}
        </div>
      ) : (
        <button type="button" className="panel-row panel-row--action" onClick={() => setAdding(true)}>
          <Icon name="plus" size={12} opacity={0.56} /> Add a Bot
        </button>
      )}
      {minimum && members !== null && members.length > 0 && <div className="members__hint">A group needs at least 2 Bots.</div>}
      {error && <div className="card__error">{error}</div>}
      <div className="members__hint">@mention a Bot to ask just them; otherwise the group answers.</div>
    </div>
  );
}

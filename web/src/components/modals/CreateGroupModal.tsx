import { useCallback, useEffect, useRef, useState } from 'react';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { api } from '../../lib/api';
import { openConversation, useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import { Page, Card, ButtonGroup } from '../layout';
import '../../styles/bot-details.css';
import { hasOpenModal, Modal } from './Modal';
import { ACTIVATE_FIRST, activateBeforeGroup, isInSetup } from '../../lib/botSetupState';
import '../../styles/setup-paper.css';

/** New room, backed by the existing account-scoped room API. */
export function CreateGroupModal({ inline = false }: { inline?: boolean } = {}) {
  const setModal = useStore(s => s.setModal);
  const allBots = useStore(s => s.bots);
  const accountId = useStore(s => s.user?.id);
  const bots = allBots.filter(bot => bot.kind !== 'room');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = useRef(false), submitting = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, [accountId]);
  const close = useCallback(() => { if (!submitting.current) setModal(null); }, [setModal]);
  useEffect(() => {
    if (!inline) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || useConfigUI.getState().appSettings || hasOpenModal()) return;
      event.preventDefault(); close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [inline, close]);
  // R2F-008: Bots still in setup are listed but cannot be picked, as in the members card.
  const available = picked.filter(id => bots.some(bot => bot.id === id && !isInSetup(bot)));
  const canCreate = (!!createdId || (name.trim().length > 0 && available.length >= 2)) && !busy;
  const toggle = (id: string) => setPicked(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]);
  const create = async () => {
    if (!canCreate || submitting.current || !accountId) return;
    submitting.current = true; setBusy(true); setError(null);
    const current = () => {
      const state = useStore.getState();
      return active.current && state.user?.id === accountId && state.modal === 'group';
    };
    let id = createdId;
    try {
      if (!id) {
        const result = await api.createRoom(name.trim(), available);
        id = result.id;
        if (current()) setCreatedId(id);
      }
      if (!current()) return;
      const { bots: all } = await api.bots();
      if (!current()) return;
      if (!all.some(bot => bot.id === id)) throw new Error('The new group is not in the refreshed list yet.');
      useStore.getState().set({ bots: all });
      openConversation(id);
    } catch (failure) { if (current()) setError(`${id ? 'Group created. Could not open it yet: ' : ''}${(failure as Error).message}`); }
    finally { submitting.current = false; if (current()) setBusy(false); }
  };
  const cancel = close;
  const content = <>
    <Page type="form" title="New room"><form className="group-create pb-group" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label className="group-create__field">Room name<input className="text-input" placeholder="Give this conversation a name" maxLength={100} value={name} onChange={event => setName(event.target.value)} autoFocus disabled={busy || !!createdId} /></label>
      <Card><fieldset className="group-create__members"><legend>Members</legend>
        {bots.map(bot => {
          const locked = isInSetup(bot);
          return <label className={`group-create__member${locked ? ' is-locked' : ''}`} key={bot.id} title={locked ? activateBeforeGroup(bot.name) : undefined}>
            <BotAvatarFor bot={bot} size={28} /><span><strong>{bot.name}</strong><small>{locked ? ACTIVATE_FIRST : (bot.description || bot.label || bot.instructions).trim().split(/\r?\n/)[0] || (bot.isPrimary ? 'Primary Bot' : 'Bot')}</small></span>
            <input type="checkbox" checked={!locked && picked.includes(bot.id)} onChange={() => { if (!locked) toggle(bot.id); }} disabled={locked || busy || !!createdId} aria-label={locked ? `${bot.name}, ${ACTIVATE_FIRST.toLowerCase()}` : bot.name} />
          </label>;
        })}
      </fieldset></Card>
      {bots.length < 2 && <p role="status">Create another Bot before starting a room.</p>}
      {error && <p className="cfg-error" role="alert">{error}</p>}
      <ButtonGroup stack>
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!canCreate}>{createdId ? (busy ? 'Opening...' : 'Open created group') : busy ? 'Creating...' : 'Create room'}</button>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={cancel} disabled={busy}>Cancel</button>
      </ButtonGroup>
    </form></Page>
  </>;
  return inline ? <main className="setup-paper pb-group-page" aria-label="New room">{content}</main>
    : <Modal onClose={close} className="setup-paper setup-paper--dialog" label="New room">{content}</Modal>;
}

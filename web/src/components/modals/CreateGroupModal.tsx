import { useCallback, useEffect, useRef, useState } from 'react';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { api } from '../../lib/api';
import { openConversation, useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { hasOpenModal, Modal } from './Modal';
import '../../styles/setup-paper.css';

/** New group chat, backed by the existing account-scoped room API. */
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
  const available = picked.filter(id => bots.some(bot => bot.id === id));
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
  const cancel = () => {
    if (submitting.current) return;
    close();
    if (!useStore.getState().mobile) {
      useConfigUI.getState().setView('bots');
      useStore.getState().set({ detailsOpen: false });
    }
  };
  const content = <>
    <header className="setup-paper__bar">
      <button type="button" className="setup-paper__back" onClick={() => { if (!submitting.current) setModal('create'); }} disabled={busy}><Icon name="chev_left" size={16} />Back to create a Bot</button>
      <span>Bots</span><button type="button" className="setup-paper__close" onClick={close} aria-label="Close" disabled={busy}><Icon name="close" /></button>
    </header>
    <form className="setup-paper__column group-create" onSubmit={event => { event.preventDefault(); void create(); }}>
      <h1>New group chat</h1><p className="setup-paper__subtitle">Choose at least two Bots to work together.</p>
      <label className="group-create__field">Group name<input className="text-input" placeholder="Give this conversation a name" maxLength={100} value={name} onChange={event => setName(event.target.value)} autoFocus disabled={busy || !!createdId} /></label>
      <fieldset className="group-create__members"><legend>Bots in this group</legend>
        {bots.map(bot => <label className="group-create__member" key={bot.id}>
          <BotAvatarFor bot={bot} size={28} /><span><strong>{bot.name}</strong><small>{bot.isPrimary ? 'Primary Bot' : bot.label || bot.description}</small></span>
          <input type="checkbox" checked={picked.includes(bot.id)} onChange={() => toggle(bot.id)} disabled={busy || !!createdId} aria-label={bot.name} />
        </label>)}
      </fieldset>
      {bots.length < 2 && <p role="status">Create another Bot before starting a group chat.</p>}
      {error && <p className="cfg-error" role="alert">{error}</p>}
      <div className="setup-paper__actions">
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!canCreate}>{createdId ? (busy ? 'Opening…' : 'Open created group') : busy ? 'Creating…' : 'Create group'}</button>
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={cancel} disabled={busy}>Cancel</button>
      </div>
    </form>
  </>;
  return inline ? <main className="setup-paper" aria-label="New group chat">{content}</main>
    : <Modal onClose={close} className="setup-paper setup-paper--dialog" label="New group chat">{content}</Modal>;
}

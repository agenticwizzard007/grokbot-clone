import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AvatarColor, AvatarShape, Bot } from '@shared/types';
import { PICKER_SHAPES } from '../../avatar/BotAvatar';
import { api } from '../../lib/api';
import { COLOR_ORDER } from '../../lib/colors';
import { openConversation, useConfigUI } from '../../configStore';
import { queueImportedSetup, readSetupManifest, setupApi } from '../../lib/setupApi';
import { useStore } from '../../store';
import { SetupPaperHeader } from '../SetupPaperHeader';
import { Modal } from './Modal';
import '../../styles/setup-paper.css';

const choiceLabel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const maxFileSize = 2 * 1024 * 1024;

export function CreateBotModal({ inline = false }: { inline?: boolean } = {}) {
  const userId = useStore(s => s.user?.id);
  return <CreateBotForm key={userId} userId={userId} inline={inline} />;
}

function CreateBotForm({ inline, userId }: { inline: boolean; userId: string | undefined }) {
  const setModal = useStore(s => s.setModal);
  const returnsToBots = useConfigUI(state => state.view === 'bots');
  const bots = useStore(s => s.bots);
  const [flow, setFlow] = useState<'create' | 'import'>('create');
  const [name, setName] = useState('');
  const [shape, setShape] = useState<AvatarShape>('heart');
  const [color, setColor] = useState<AvatarColor>('orange');
  const [mode, setMode] = useState<Bot['mode']>('personal');
  const [selection, setSelection] = useState<{ file: string; manifest: unknown } | null>(null);
  const [importName, setImportName] = useState('');
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [completedImport, setCompletedImport] = useState<{ botId: string; name: string } | null>(null);
  const active = useRef(false);
  const submission = useRef<'idle' | 'pending' | 'imported'>('idle');
  const fileVersion = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; fileVersion.current += 1; };
  }, []);
  const close = useCallback(() => { if (submission.current !== 'pending') setModal(null); }, [setModal]);
  useEffect(() => {
    if (!inline) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || useConfigUI.getState().appSettings || document.querySelector('.modal-root')) return;
      event.preventDefault(); close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, inline]);
  const duplicate = flow === 'import' && !!selection && bots.some(bot =>
    bot.kind !== 'room' && bot.name.trim().toLowerCase() === importName.trim().toLowerCase());
  const switchFlow = (next: typeof flow) => { fileVersion.current += 1; setReading(false); setFlow(next); setError(''); };

  const chooseFile = async (file?: File) => {
    const request = ++fileVersion.current;
    setSelection(null); setImportName(''); setError(''); setReading(false);
    if (!file) return;
    if (file.size > maxFileSize) { setError('Choose a setup manifest smaller than 2 MB.'); return; }
    setReading(true);
    try {
      const parsed = readSetupManifest(await file.text());
      if (request !== fileVersion.current) return;
      setSelection({ file: file.name, manifest: parsed.manifest }); setImportName(parsed.name);
    } catch (failure) {
      if (request === fileVersion.current) setError((failure as Error).message);
    } finally {
      if (request === fileVersion.current) setReading(false);
    }
  };

  const isCurrent = () => active.current && useStore.getState().user?.id === userId && useStore.getState().modal === 'create';
  const openImportedSetup = (botId: string) => {
    if (!isCurrent() || useConfigUI.getState().appSettings) return;
    openConversation(botId);
    useStore.getState().set({ detailsOpen: true });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!userId || !isCurrent() || useConfigUI.getState().appSettings || submission.current !== 'idle' || (flow === 'import' ? !selection || !importName.trim() || duplicate : !name.trim())) return;
    submission.current = 'pending'; setBusy(true); setError('');
    try {
      const { bot } = flow === 'import' && selection
        ? await setupApi.importManifest(selection.manifest, importName.trim(), userId)
        : await api.createBot({ name: name.trim(), avatarShape: shape, avatarColor: color, mode });
      if (!isCurrent()) return;
      if (!bot) throw new Error('No imported bot was returned. Check your bot list before retrying.');
      const state = useStore.getState();
      state.set({ bots: state.bots.some(item => item.id === bot.id) ? state.bots : [...state.bots, bot] });
      if (flow === 'import') {
        submission.current = 'imported';
        queueImportedSetup(userId, bot.id);
        setCompletedImport({ botId: bot.id, name: bot.name });
        openImportedSetup(bot.id);
      } else {
        openConversation(bot.id);
        state.set({ detailsOpen: false });
      }
    } catch (failure) {
      if (isCurrent()) setError((failure as Error).message);
    } finally {
      if (submission.current === 'pending') submission.current = 'idle';
      if (isCurrent()) setBusy(false);
    }
  };

  const title = flow === 'create' ? 'Create a bot' : 'Import a saved setup';
  const content = <>
    <SetupPaperHeader backLabel={returnsToBots ? 'Back to bots' : 'Back to chat'} title="Bots" onBack={close} onClose={close} disabled={busy} />
    <div className="setup-paper__column setup-create__column">
      <h1>{title}</h1>
      {!completedImport && <p className="setup-paper__subtitle">{flow === 'create' ? 'Give your bot a name and a look.' : 'Choose a bot-setup.json exported from Configuration files.'}</p>}
      {completedImport ? <div className="setup-create__form">
        <div className="setup-create__description" role="status"><strong>Setup imported</strong><p>{completedImport.name} is in your bots.</p></div>
        <div className="setup-paper__actions"><button type="button" className="cfg-btn cfg-btn--primary" onClick={() => openImportedSetup(completedImport.botId)}>Open imported setup</button></div>
      </div> : <form onSubmit={submit} className="setup-create__form">
        <fieldset disabled={busy}>
          {flow === 'create' ? <>
            <label>Bot name<input className="text-input" placeholder="Give your Bot a name" value={name} maxLength={60} onChange={event => setName(event.target.value)} autoFocus /><small>Up to 60 characters</small></label>
            <label>Shape<select value={shape} onChange={event => setShape(event.target.value as AvatarShape)}>{PICKER_SHAPES.map(value => <option key={value} value={value}>{choiceLabel(value)}</option>)}</select><small>Choose a character shape</small></label>
            <label>Color<select value={color} onChange={event => setColor(event.target.value as AvatarColor)}>{COLOR_ORDER.map(value => <option key={value} value={value}>{choiceLabel(value)}</option>)}</select><small>Choose a character color</small></label>
            <div className="setup-paper__tabs" role="group" aria-label="Bot type">
              <button type="button" aria-pressed={mode === 'personal'} onClick={() => setMode('personal')}>Personal assistant</button>
              <button type="button" aria-pressed={mode === 'teammate'} onClick={() => setMode('teammate')}>Teammate</button>
            </div>
            <div className="setup-create__description"><strong>{mode === 'personal' ? 'Personal assistant' : 'Teammate'}</strong><p>{mode === 'personal' ? 'Works for you, with your apps.' : 'Works with your team on an agreed role and responsibilities.'}</p></div>
          </> : <>
            <label>Setup file<input type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void chooseFile(file); }} /></label>
            {reading && <p role="status">Reading setup file…</p>}
            {selection && <><p className="setup-paper__subtitle">Selected: {selection.file}</p><label>Bot name<input className="text-input" value={importName} maxLength={60} onChange={event => { setImportName(event.target.value); setError(''); }} /><small>Choose a unique name in this account.</small></label></>}
            {duplicate && <p className="cfg-error" role="alert">A bot with this name already exists. Choose a different name.</p>}
            <div className="setup-create__description"><strong>Setup only</strong><p>Imports the role and saved setup, not tasks, schedules, sessions, or learned history. Review the new bot’s setup before activating it.</p></div>
          </>}
        </fieldset>
        {error && <p className="cfg-error" role="alert">{error}</p>}
        <div className="setup-paper__actions">
          <button type="submit" className="cfg-btn cfg-btn--primary" disabled={busy || reading || (flow === 'import' ? !selection || !importName.trim() || duplicate : !name.trim())}>{busy ? flow === 'create' ? 'Creating…' : 'Importing…' : flow === 'create' ? 'Create' : 'Import setup'}</button>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={close} disabled={busy}>Cancel</button>
          {flow === 'create' && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setModal('group')} disabled={busy}>New group chat instead</button>}
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => switchFlow(flow === 'create' ? 'import' : 'create')} disabled={busy}>{flow === 'create' ? 'Import saved setup' : 'Create a bot instead'}</button>
        </div>
      </form>}
    </div>
  </>;
  return inline ? <main className="setup-paper setup-create" aria-label={title}>{content}</main>
    : <Modal onClose={close} className="setup-paper setup-paper--dialog setup-create create-modal" label={title}>{content}</Modal>;
}

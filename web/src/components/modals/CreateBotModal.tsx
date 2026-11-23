import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AvatarColor, AvatarShape, Bot } from '@shared/types';
import { DEFAULT_AVATAR_SHAPE } from '@shared/avatar-shapes';
import { BirdPicker } from '../../avatar/BirdPicker';
import { api } from '../../lib/api';
import { COLOR_ORDER } from '../../lib/colors';
import { openConversation, useConfigUI } from '../../configStore';
import { queueImportedSetup, readSetupManifest, setupApi } from '../../lib/setupApi';
import { useStore } from '../../store';
import { SetupPaperHeader } from '../SetupPaperHeader';
import { Modal } from './Modal';
import { holdComposerFocus } from '../../lib/typingGuard';
import '../../styles/setup-paper.css';

const choiceLabel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
const maxFileSize = 2 * 1024 * 1024;
const NO_BOTS: Bot[] = [];
/** R2F-005: Create waits until the name field has been quiet this long, so late keystrokes are included. */
const INPUT_SETTLE_MS = 150;
// Same wording as the server's 413 responses, also used when a proxy answers 413 without a JSON body.
const TOO_LARGE_SETUP = 'This setup file is too large (max 2 MB).';
const TOO_LONG_MESSAGE = 'Message is too long (max 32,000 characters).';

export function CreateBotModal({ inline = false }: { inline?: boolean } = {}) {
  const userId = useStore(s => s.user?.id);
  return <CreateBotForm key={userId} userId={userId} inline={inline} />;
}

function CreateBotForm({ inline, userId }: { inline: boolean; userId: string | undefined }) {
  const setModal = useStore(s => s.setModal);
  const returnsToBots = useConfigUI(state => state.view === 'bots');
  const [flow, setFlow] = useState<'create' | 'import'>('create');
  // Only the import flow needs the roster (duplicate names); typing a new name must not re-render on Bot updates.
  const bots = useStore(s => flow === 'import' ? s.bots : NO_BOTS);
  const [name, setName] = useState('');
  const [shape, setShape] = useState<AvatarShape>(DEFAULT_AVATAR_SHAPE);
  const [color, setColor] = useState<AvatarColor>('blue');
  const [mode, setMode] = useState<Bot['mode']>('personal');
  const [selection, setSelection] = useState<{ file: string; manifest: unknown } | null>(null);
  const [importName, setImportName] = useState('');
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [completedImport, setCompletedImport] = useState<{ botId: string; name: string } | null>(null);
  const active = useRef(false);
  // MF-059: submit reads the live input value, and Create waits while an IME composition is open.
  const nameInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastInputAt = useRef(0);
  // Resolves once the field has been quiet for INPUT_SETTLE_MS, counting from the click at the earliest.
  const inputSettled = () => new Promise<void>(resolve => {
    const clickedAt = performance.now();
    const check = () => {
      const age = performance.now() - Math.max(lastInputAt.current, clickedAt);
      if (age >= INPUT_SETTLE_MS) resolve(); else setTimeout(check, Math.ceil(INPUT_SETTLE_MS - age));
    };
    check();
  });
  const [composing, setComposing] = useState(false);
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
    if (file.size > maxFileSize) { setError(TOO_LARGE_SETUP); return; }
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
    const readName = () => (nameInput.current?.value ?? name).trim();
    if (composing || !userId || !isCurrent() || useConfigUI.getState().appSettings || submission.current !== 'idle' || (flow === 'import' ? !selection || !importName.trim() || duplicate : !readName())) return;
    submission.current = 'pending';
    // Keystrokes still being delivered when Create is clicked land in the name field (focus stays there), then we read it.
    if (flow === 'create') await inputSettled();
    const typedName = readName();
    if (!isCurrent() || (flow === 'create' && !typedName)) { submission.current = 'idle'; return; }
    setBusy(true); setError('');
    try {
      const { bot } = flow === 'import' && selection
        ? await setupApi.importManifest(selection.manifest, importName.trim(), userId)
        : await api.createBot({ name: typedName, avatarShape: shape, avatarColor: color, mode });
      if (!isCurrent()) return;
      if (!bot) throw new Error('No imported Bot was returned. Check your Bot list before retrying.');
      const state = useStore.getState();
      state.set({ bots: state.bots.some(item => item.id === bot.id) ? state.bots : [...state.bots, bot] });
      if (flow === 'import') {
        submission.current = 'imported';
        queueImportedSetup(userId, bot.id);
        setCompletedImport({ botId: bot.id, name: bot.name });
        openImportedSetup(bot.id);
      } else {
        holdComposerFocus();
        openConversation(bot.id);
        state.set({ detailsOpen: false });
      }
    } catch (failure) {
      const { status, message } = failure as Error & { status?: number };
      const shown = status === 413 && !/too (large|long)/i.test(message) ? (flow === 'import' ? TOO_LARGE_SETUP : TOO_LONG_MESSAGE) : message;
      if (isCurrent()) setError(shown);
    } finally {
      if (submission.current === 'pending') submission.current = 'idle';
      if (isCurrent()) setBusy(false);
    }
  };

  const title = flow === 'create' ? 'Create a Bot' : 'Import a saved setup';
  const content = <>
    <SetupPaperHeader backLabel={returnsToBots ? 'Back to Bots' : 'Back to chat'} title="Bots" onBack={close} onClose={close} disabled={busy} />
    <div className="setup-paper__column setup-create__column">
      <h1>{title}</h1>
      {!completedImport && <p className="setup-paper__subtitle">{flow === 'create' ? 'Give your Bot a name and a look.' : 'Choose a bot-setup.json exported from Details > Setup > Files.'}</p>}
      {completedImport ? <div className="setup-create__form">
        <div className="setup-create__description" role="status"><strong>Setup imported</strong><p>{completedImport.name} is in your Bots.</p></div>
        <div className="setup-paper__actions"><button type="button" className="cfg-btn cfg-btn--primary" onClick={() => openImportedSetup(completedImport.botId)}>Open imported setup</button></div>
      </div> : <form onSubmit={submit} className="setup-create__form">
        <fieldset disabled={busy}>
          {flow === 'create' ? <>
            <label>Bot name<input className="text-input" placeholder="Give your Bot a name" ref={nameInput} value={name} maxLength={60} onChange={event => { lastInputAt.current = performance.now(); setName(event.target.value); }}
              onCompositionStart={() => setComposing(true)} onCompositionEnd={event => { setComposing(false); setName(event.currentTarget.value); }} autoFocus /><small>Up to 60 characters</small></label>
            <div><p>Choose a bird</p><BirdPicker shape={shape} color={color} onShape={setShape} /></div>
            <label>Color<select value={color} onChange={event => setColor(event.target.value as AvatarColor)}>{COLOR_ORDER.map(value => <option key={value} value={value}>{choiceLabel(value)}</option>)}</select><small>Choose a character color</small></label>
            <div className="setup-paper__tabs" role="group" aria-label="Bot type">
              <button type="button" aria-pressed={mode === 'personal'} onClick={() => setMode('personal')}>Personal assistant</button>
              <button type="button" aria-pressed={mode === 'teammate'} onClick={() => setMode('teammate')}>Teammate</button>
            </div>
            <div className="setup-create__description"><strong>{mode === 'personal' ? 'Personal assistant' : 'Teammate'}</strong><p>{mode === 'personal' ? 'Works for you, with your apps.' : 'Works with your team on an agreed role and responsibilities.'}</p></div>
          </> : <>
            <div className="setup-create__file"><span>Setup file</span>
              <input ref={fileInput} type="file" hidden aria-label="Setup file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void chooseFile(file); }} />
              <div className="setup-create__chosen">{selection && <p className="setup-paper__subtitle">Selected: {selection.file}</p>}<button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => fileInput.current?.click()}>{selection ? 'Choose another file' : 'Choose setup file'}</button></div>
            </div>
            {reading && <p role="status">Reading setup file…</p>}
            {selection && <label>Bot name<input className="text-input" value={importName} maxLength={60} onChange={event => { setImportName(event.target.value); setError(''); }} /><small>Choose a unique name in this account.</small></label>}
            {/* The imported Bot can reach the roster before the import response arrives. */}
            {duplicate && !busy && <p className="cfg-error" role="alert">A Bot with this name already exists. Choose a different name.</p>}
            <div className="setup-create__description"><strong>Setup only</strong><p>Imports the role and saved setup, not tasks, schedules, sessions, or learned history. Review the new Bot's setup before activating it.</p></div>
          </>}
        </fieldset>
        {error && <p className="cfg-error" role="alert">{error}</p>}
        <div className="setup-paper__actions">
          <button type="submit" className="cfg-btn cfg-btn--primary" onMouseDown={event => { if (flow === 'create') event.preventDefault(); }} disabled={busy || reading || (flow === 'create' && composing) || (flow === 'import' ? !selection || !importName.trim() || duplicate : !name.trim())}>{busy ? flow === 'create' ? 'Creating…' : 'Importing…' : flow === 'create' ? 'Create' : 'Import setup'}</button>
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={close} disabled={busy}>Cancel</button>
          {flow === 'create' && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setModal('group')} disabled={busy}>New group chat instead</button>}
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => switchFlow(flow === 'create' ? 'import' : 'create')} disabled={busy}>{flow === 'create' ? 'Import saved setup' : 'Create a Bot instead'}</button>
        </div>
      </form>}
    </div>
  </>;
  return inline ? <main className="setup-paper setup-create" aria-label={title}>{content}</main>
    : <Modal onClose={close} className="setup-paper setup-paper--dialog setup-create create-modal" label={title}>{content}</Modal>;
}

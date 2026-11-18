import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PhoneOff, TextCursorInput } from 'lucide-react';
import type { Bot } from '@shared/types';
import { api } from '../lib/api';
import { displayName, useStore } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { ComposerModelMenu, cycleEffort, toggleFast } from './ComposerModelMenu';
import { modelSelection, useModels } from '../lib/models';
import { UsageModeBubble } from './UsageModeBubble';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { useDictation } from '../voice/dictation';

const MAX_H = 200;
const drafts = new Map<string, string>();

export function Composer({ bot, running }: { bot: Bot; running: boolean }) {
  // Phones: the short name keeps the placeholder on one line.
  const mobile = useStore((s) => s.mobile);
  // Phones hide the chat while the Bot list is showing; the box can only be measured once it's on screen.
  const onScreen = useStore((s) => !s.mobile || s.mobilePane === 'chat');
  const [text, setText] = useState(() => drafts.get(bot.id) ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const dictationCancelRef = useRef<HTMLButtonElement>(null);
  const dictationRange = useRef<{ text: string; start: number; end: number } | null>(null);
  const setModal = useStore((s) => s.setModal);

  // Per-bot drafts.
  // Phones don't take focus on open: it would raise the keyboard over the conversation.
  useEffect(() => { setText(drafts.get(bot.id) ?? ''); setError(null); if (!useStore.getState().mobile) ref.current?.focus(); }, [bot.id]);
  useEffect(() => { drafts.set(bot.id, text); }, [bot.id, text]);

  // Auto-grow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Hidden (display: none) measures 0; leave the natural one-line height until it's shown.
    if (!el.offsetParent) { el.style.height = ''; return; }
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX_H)}px`;
    el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden';
  }, [text, onScreen, mobile]);

  // The Paper ring reflects the supported, selected effort in either billing mode.
  const catalog = useModels();
  const { effort } = modelSelection(bot, catalog);
  const animated = effort !== null && effort !== 'none';
  const ultra = effort === 'ultracode';
  const [flare, setFlare] = useState(false);
  const previousEffort = useRef({ botId: bot.id, effort });
  useEffect(() => {
    const changed = animated && previousEffort.current.botId === bot.id && previousEffort.current.effort !== effort;
    previousEffort.current = { botId: bot.id, effort };
    setFlare(changed);
    if (changed) { const timer = setTimeout(() => setFlare(false), 1400); return () => clearTimeout(timer); }
  }, [bot.id, effort, animated]);

  // ⌘⇧/ cycles the effort, ⌘⇧F toggles Fast (while the composer has focus).
  const area = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || !area.current?.contains(document.activeElement)) return;
      const m = modelSelection(bot, useModels.getState()).current;
      if (e.code === 'Slash') { e.preventDefault(); cycleEffort(bot, m); }
      else if (e.code === 'KeyF' && useModels.getState().canFast) { e.preventDefault(); toggleFast(bot); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [bot]);

  // ⌘I focuses the prompt.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); ref.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true); setError(null);
    try {
      await api.send(bot.id, t);
      setText('');
      drafts.delete(bot.id);
    } catch (e) {
      setError((e as Error).message || 'Message failed to send');
    } finally {
      setSending(false);
      ref.current?.focus();
    }
  };

  const stop = () => api.interrupt(bot.id).catch((e) => setError(e.message));
  const fresh = () => api.fresh(bot.id).catch((e) => setError(e.message));

  // Dictation: insert the transcript at the cursor.
  const insertText = (t: string) => {
    const el = ref.current;
    const range = dictationRange.current;
    dictationRange.current = null;
    setText((cur) => {
      const start = range?.text === cur ? range.start : el && document.activeElement === el ? el.selectionStart : cur.length;
      const end = range?.text === cur ? range.end : el && document.activeElement === el ? el.selectionEnd : cur.length;
      const before = cur.slice(0, start);
      const after = cur.slice(end);
      const pre = before && !/\s$/.test(before) ? ' ' : '';
      const post = after && !/^\s/.test(after) ? ' ' : '';
      requestAnimationFrame(() => { if (el) { const pos = before.length + pre.length + t.length; if (!mobile) el.focus(); else moreRef.current?.focus(); el.setSelectionRange(pos, pos); } });
      return before + pre + t + post + after;
    });
  };
  const anyCall = useVoice((s) => isCallActive(s));
  const callBotId = useVoice((s) => s.botId);
  const inCall = anyCall && callBotId === bot.id;
  const switchingCall = anyCall && !inCall;
  const dictation = useDictation(insertText, setError, bot.voiceLanguage, {
    contextKey: `${bot.id}:${bot.generation}`, enabled: !anyCall,
  });
  const voiceLabel = inCall ? `End call with ${bot.name}` : switchingCall ? `Switch call to ${bot.name}` : `Start live voice with ${bot.name}`;
  const wasDictating = useRef(false);
  useEffect(() => {
    const active = dictation.state !== 'idle';
    if (active && (!wasDictating.current || document.activeElement === document.body)) dictationCancelRef.current?.focus();
    // Only restore focus when the removed dictation controls held it. A new call
    // or another chat may already have placed focus where the user needs it.
    if (!active && wasDictating.current && document.activeElement === document.body) moreRef.current?.focus();
    wasDictating.current = active;
  }, [dictation.state]);
  const dictate = () => {
    const el = ref.current;
    dictationRange.current = el ? { text: el.value, start: el.selectionStart, end: el.selectionEnd } : null;
    setError(null);
    dictation.start();
  };
  const voice = () => {
    // Keep AudioContext creation inside the user gesture; cancellation is synchronous.
    dictation.cancel();
    setError(null);
    try { if (inCall) endCall(); else startCall(bot.id); }
    catch (e) { setError((e as Error).message || 'Could not start live voice'); }
  };

  const hasText = text.trim().length > 0;
  const multiline = text.includes('\n') || (ref.current?.scrollHeight ?? 0) > 44;

  return (
    <div className="composer-area" ref={area}>
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
      <UsageModeBubble />
      {dictation.state !== 'idle' && (
        <div className="composer__dictation">
          <span role="status">{dictation.state === 'starting' ? 'Opening microphone…' : dictation.state === 'recording' ? 'Dictating a message…' : 'Transcribing message…'}</span>
          <div className="composer__dictation-actions">
            {dictation.state === 'recording' && <button type="button" className="link-btn" onClick={dictation.stop} aria-label="Use transcript · stop dictation">Use transcript</button>}
            <button ref={dictationCancelRef} type="button" className="link-btn" onClick={dictation.cancel} aria-label="Cancel dictation">Cancel</button>
          </div>
        </div>
      )}
      <div className={`composer-shell effort-motion${flare ? ' is-flaring' : ''}`} data-effort={effort ?? undefined}>
      {animated && <span className="composer__glow" aria-hidden />}
      <div className={`composer${multiline ? ' is-multiline' : ''}${animated ? ' has-effort' : ''}${ultra ? ' is-ultracode' : ''}`}>
        <textarea
          ref={ref}
          className="composer__input"
          rows={1}
          value={text}
          placeholder={`Message ${mobile ? bot.name : displayName(bot)}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
          }}
          aria-label={`Message ${bot.name}`}
        />
        <div className="composer__bar">
        <div className="composer__left">
          <span className="composer__plus-anchor">
            <button ref={moreRef} type="button" className="composer__btn" onClick={() => setMenu(!menu)} aria-label="More actions" aria-expanded={menu}>
              <Icon name="composer_plus" opacity={0.56} />
            </button>
            {menu && (
              <Menu
                placement="above"
                onClose={() => setMenu(false)}
                items={[
                  { label: 'New conversation', onSelect: fresh },
                  { label: 'Connect apps', onSelect: () => setModal('apps') },
                  ...(!anyCall && dictation.state === 'idle' ? [{ label: 'Dictate a message', hint: 'Text only', icon: TextCursorInput, onSelect: dictate }] : []),
                ]}
              />
            )}
          </span>
          <ComposerModelMenu bot={bot} />
        </div>
        <div className="composer__right">
          <button
            type="button"
            className={`${hasText || running ? 'composer__btn' : 'composer__cta'} composer__voice${inCall ? ' is-in-call' : ''}`}
            aria-label={voiceLabel}
            aria-pressed={inCall}
            title={switchingCall ? `End the current call and talk to ${bot.name}` : inCall ? 'End the call; agent work continues in chat' : `Talk to ${bot.name} live to coordinate work and hear results`}
            onClick={voice}
          >
            {inCall ? <PhoneOff size={16} aria-hidden /> : <Icon name="mic" />}
            <span>{inCall ? 'End call' : switchingCall ? 'Switch call' : 'Live voice'}</span>
          </button>
          {running && !hasText ? (
            <button type="button" className="composer__cta" onClick={stop} aria-label="Stop" title="Stop">
              <Icon name="stop" size={14} />
            </button>
          ) : hasText ? (
            <button
              type="button"
              className="composer__cta"
              onClick={send}
              disabled={sending}
              aria-label="Send"
              title="Send (Enter)"
            >
              <Icon name="arrow_up" size={16} />
            </button>
          ) : null}
        </div>
        </div>
      </div>
      </div>
    </div>
  );
}

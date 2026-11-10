import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Bot } from '@shared/types';
import { api } from '../lib/api';
import { displayName, useStore } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { ComposerModelMenu, cycleEffort, toggleFast } from './ComposerModelMenu';
import { useModels } from '../lib/models';
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

  // Ultracode: a one-off flare when it's switched on.
  const ultra = bot.effort === 'ultracode';
  const [flare, setFlare] = useState(false);
  const wasUltra = useRef(ultra);
  useEffect(() => {
    if (ultra && !wasUltra.current) { setFlare(true); const t = setTimeout(() => setFlare(false), 1400); wasUltra.current = ultra; return () => clearTimeout(t); }
    wasUltra.current = ultra;
  }, [ultra]);

  // ⌘⇧/ cycles the effort, ⌘⇧F toggles Fast (while the composer has focus).
  const area = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || !area.current?.contains(document.activeElement)) return;
      const m = bot.model ? useModels.getState().byId.get(bot.model) : undefined;
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
    setText((cur) => {
      const start = el && document.activeElement === el ? el.selectionStart : cur.length;
      const end = el && document.activeElement === el ? el.selectionEnd : cur.length;
      const before = cur.slice(0, start);
      const after = cur.slice(end);
      const pre = before && !/\s$/.test(before) ? ' ' : '';
      const post = after && !/^\s/.test(after) ? ' ' : '';
      requestAnimationFrame(() => { if (el) { const pos = before.length + pre.length + t.length; el.focus(); el.setSelectionRange(pos, pos); } });
      return before + pre + t + post + after;
    });
  };
  const dictation = useDictation(insertText, setError, bot.voiceLanguage);
  const inCall = useVoice((s) => isCallActive(s) && s.botId === bot.id);

  const hasText = text.trim().length > 0;
  const multiline = text.includes('\n') || (ref.current?.scrollHeight ?? 0) > 44;

  return (
    <div className="composer-area" ref={area}>
      {error && <div className="composer__error">{error} <button type="button" className="link-btn" onClick={() => setError(null)}>Dismiss</button></div>}
      <div className={`composer-shell${flare ? ' is-flaring' : ''}`}>
      {ultra && <span className="composer__glow" aria-hidden />}
      <div className={`composer${multiline ? ' is-multiline' : ''}${ultra ? ' is-ultracode' : ''}`}>
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
            <button type="button" className="composer__btn" onClick={() => setMenu(!menu)} aria-label="More actions" aria-expanded={menu}>
              <Icon name="composer_plus" opacity={0.56} />
            </button>
            {menu && (
              <Menu
                placement="above"
                onClose={() => setMenu(false)}
                items={[
                  { label: 'New conversation', onSelect: fresh },
                  { label: 'Connect apps', onSelect: () => setModal('apps') },
                ]}
              />
            )}
          </span>
          <ComposerModelMenu bot={bot} />
        </div>
        <div className="composer__right">
          <button
            type="button"
            className={`composer__btn${dictation.state === 'recording' ? ' is-recording' : dictation.state === 'transcribing' ? ' is-transcribing' : ''}`}
            aria-label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
            aria-pressed={dictation.state === 'recording'}
            title={dictation.state === 'recording' ? 'Release or click to stop · Esc cancels' : dictation.state === 'transcribing' ? 'Transcribing…' : 'Hold to dictate, or click to start'}
            disabled={dictation.state === 'transcribing'}
            onPointerDown={dictation.onPointerDown}
            onPointerUp={dictation.onPointerUp}
            onKeyDown={dictation.onKeyDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Icon name="mic" opacity={0.56} />
          </button>
          {inCall && !hasText ? (
            <button type="button" className="composer__cta is-in-call" onClick={endCall} aria-label="End voice call" title="End voice call">
              <Icon name="voice_a" size={16} />
            </button>
          ) : running && !hasText ? (
            <button type="button" className="composer__cta" onClick={stop} aria-label="Stop" title="Stop">
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="composer__cta"
              onClick={hasText ? send : () => startCall(bot.id)}
              disabled={hasText && sending}
              aria-label={hasText ? 'Send' : `Start voice chat with ${bot.name}`}
              title={hasText ? 'Send (Enter)' : 'Start voice chat'}
            >
              <Icon name={hasText ? 'arrow_up' : 'voice_a'} size={16} />
            </button>
          )}
        </div>
        </div>
      </div>
      </div>
    </div>
  );
}

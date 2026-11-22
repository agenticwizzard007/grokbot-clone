import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PhoneOff, TextCursorInput } from 'lucide-react';
import type { Bot } from '@shared/types';
import { api } from '../lib/api';
import { useConfigUI } from '../configStore';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Menu } from './Menu';
import { ComposerModelMenu, cycleEffort, toggleFast } from './ComposerModelMenu';
import { isTopEffort, modelSelection, useModels } from '../lib/models';
import { endCall, isCallActive, startCall, useVoice } from '../voice/call';
import { useDictation } from '../voice/dictation';
import { hasOpenModal } from './modals/Modal';
import { detailsReplaceChat, useDetailsReplaceChat } from '../lib/useDetailsLayout';
import { useFreshConversation } from '../lib/useFreshConversation';
import { expectRowsAfterSend } from '../lib/sseWatchdog';
import { takeComposerHold, whenTypingIdle } from '../lib/typingGuard';

const MAX_H = 200;
const drafts = new Map<string, string>();
const pendingSends = new Map<string, symbol>();
const sendErrors = new Map<string, string>();
const draftListeners = new Set<(key: string) => void>();
const notifyDraft = (key: string) => draftListeners.forEach(listener => listener(key));
function isActiveComposer(accountId: string | undefined, botId: string) {
  const state = useStore.getState();
  const ui = useConfigUI.getState();
  return !!accountId && state.user?.id === accountId && state.selectedBotId === botId && !state.modal
    && !(state.detailsOpen && detailsReplaceChat()) && !state.viewerOpen
    && !hasOpenModal() && ui.view === 'chat' && !ui.appSettings && !ui.botSettings && (!state.mobile || state.mobilePane === 'chat');
}
useStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) { drafts.clear(); pendingSends.clear(); sendErrors.clear(); }
});

/** PD-R2-02: put a starting prompt in a Bot's composer draft (kept after any text already there). Nothing is sent. */
export function prefillComposer(botId: string, text: string) {
  const accountId = useStore.getState().user?.id;
  if (!accountId) return;
  const key = `${accountId}:${botId}`;
  const current = drafts.get(key)?.trimEnd() ?? '';
  if (current.includes(text.trim())) return;
  drafts.set(key, current ? `${current}\n${text}` : text);
  notifyDraft(key);
}

export function Composer({ bot, running }: { bot: Bot; running: boolean }) {
  const accountId = useStore(s => s.user?.id);
  const draftKey = `${accountId}:${bot.id}`;
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  // Phones: the short name keeps the placeholder on one line.
  const mobile = useStore((s) => s.mobile);
  // Phones hide the chat while the Bot list is showing; the box can only be measured once it's on screen.
  const paneVisible = useStore((s) => !s.mobile || s.mobilePane === 'chat');
  const detailsOpen = useStore(s => s.detailsOpen);
  const compactDetails = useDetailsReplaceChat();
  const onScreen = paneVisible && !(detailsOpen && compactDetails);
  const [text, setText] = useState(() => drafts.get(draftKey) ?? '');
  const [sending, setSending] = useState(() => pendingSends.has(draftKey));
  const [error, setError] = useState<string | null>(() => sendErrors.get(draftKey) ?? null);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const dictationCancelRef = useRef<HTMLButtonElement>(null);
  const dictationRange = useRef<{ text: string; start: number; end: number } | null>(null);
  const setModal = useStore((s) => s.setModal);

  // Per-bot drafts.
  // Phones don't take focus on open: it would raise the keyboard over the conversation.
  useEffect(() => {
    const sync = (key: string) => {
      if (key !== draftKey) return;
      setText(drafts.get(key) ?? ''); setSending(pendingSends.has(key)); setError(sendErrors.get(key) ?? null);
    };
    sync(draftKey);
    draftListeners.add(sync);
    let cancelFocus: (() => void) | undefined;
    if (!useStore.getState().mobile && isActiveComposer(accountId, bot.id)) {
      // R2F-005: right after Create, keys still meant for the create form must not land here.
      if (takeComposerHold()) cancelFocus = whenTypingIdle(() => {
        const current = document.activeElement;
        if (isActiveComposer(accountId, bot.id) && (!current || current === document.body)) ref.current?.focus();
      });
      else ref.current?.focus();
    }
    return () => { draftListeners.delete(sync); cancelFocus?.(); };
  }, [draftKey, accountId, bot.id]);
  useEffect(() => { drafts.set(draftKey, text); }, [draftKey, text]);

  // Auto-grow.
  const grow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Hidden (display: none) measures 0; leave the natural one-line height until it's shown.
    if (!el.offsetParent) { el.style.height = ''; return; }
    // R2F-023: CSS caps the height by the window height (short windows keep room for the conversation);
    // use that cap here too, or a draft between the two limits is clipped without a scrollbar.
    const max = Math.min(MAX_H, parseFloat(getComputedStyle(el).maxHeight) || MAX_H);
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, []);
  useLayoutEffect(grow, [text, onScreen, mobile, grow]);
  // Settings hide the chat pane without unmounting it; measure again when the window or the pane changes.
  const settingsOpen = useConfigUI(s => !!s.appSettings);
  useLayoutEffect(grow, [settingsOpen, grow]);
  useEffect(() => { window.addEventListener('resize', grow); return () => window.removeEventListener('resize', grow); }, [grow]);

  // The Paper ring reflects the supported, selected effort in either billing mode.
  const catalog = useModels();
  const { current, effort } = modelSelection(bot, catalog);
  const animated = effort !== null && effort !== 'none';
  const ultra = isTopEffort(effort, current);
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
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || !area.current?.contains(document.activeElement) || !isActiveComposer(accountId, bot.id)) return;
      const m = modelSelection(bot, useModels.getState()).current;
      if (e.code === 'Slash') { e.preventDefault(); cycleEffort(bot, m); }
      else if (e.code === 'KeyF' && useModels.getState().canFast) { e.preventDefault(); toggleFast(bot); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [accountId, bot]);

  // ⌘I focuses the prompt.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i' && isActiveComposer(accountId, bot.id)) { e.preventDefault(); ref.current?.focus(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [accountId, bot.id]);

  const send = async () => {
    const t = text.trim();
    if (!t || sending || pendingSends.has(draftKey) || !isActiveComposer(accountId, bot.id)) return;
    const request = Symbol();
    pendingSends.set(draftKey, request); sendErrors.delete(draftKey);
    const current = () => useStore.getState().user?.id === accountId && pendingSends.get(draftKey) === request;
    setSending(true); setError(null);
    const sentAt = Date.now();
    try {
      await api.send(bot.id, t);
      // MF-011: if the event stream stays silent for this Bot, reload its rows once.
      const botId = bot.id;
      expectRowsAfterSend(botId, () => { if (useStore.getState().user?.id === accountId) useStore.getState().loadRows(botId).catch(() => {}); }, { since: sentAt });
      // Notify any newly mounted composer for this bot, preserving drafts edited during the request.
      if (current() && drafts.get(draftKey) === text) drafts.delete(draftKey);
    } catch (e) {
      if (current()) sendErrors.set(draftKey, (e as Error).message || 'Message failed to send');
    } finally {
      if (current()) { pendingSends.delete(draftKey); notifyDraft(draftKey); }
      if (active.current && isActiveComposer(accountId, bot.id)) ref.current?.focus();
    }
  };

  const stop = () => api.interrupt(bot.id).catch((e) => setError(e.message));
  const fresh = useFreshConversation(bot.id);

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
    contextKey: `${bot.id}:${bot.generation}`, enabled: !anyCall && onScreen,
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
      {error && <div className="composer__error" role="alert">{error} <button type="button" className="link-btn" onClick={() => { sendErrors.delete(draftKey); setError(null); }}>Dismiss</button></div>}
      {dictation.state !== 'idle' && (
        <div className="composer__dictation">
          <span role="status">{dictation.state === 'starting' ? 'Opening microphone…' : dictation.state === 'recording' ? 'Dictating a message…' : 'Transcribing message…'}</span>
          <div className="composer__dictation-actions">
            {dictation.state === 'recording' && <button type="button" className="link-btn" onClick={dictation.stop} aria-label="Use transcript · stop dictation">Use transcript</button>}
            <button ref={dictationCancelRef} type="button" className="link-btn" onClick={dictation.cancel} aria-label="Cancel dictation">Cancel</button>
          </div>
        </div>
      )}
      <div className={`composer-shell effort-motion${ultra ? ' is-top-effort' : ''}${flare ? ' is-flaring' : ''}`} data-effort={effort ?? undefined}>
      {animated && <span className="composer__glow" aria-hidden />}
      <div className={`composer${multiline ? ' is-multiline' : ''}${animated ? ' has-effort' : ''}${ultra ? ' is-ultracode' : ''}`}>
        <textarea
          ref={ref}
          className="composer__input"
          rows={1}
          value={text}
          placeholder={`Message ${bot.name}`}
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

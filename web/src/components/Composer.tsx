import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { LoaderCircle, Mic, PhoneOff, TextCursorInput } from 'lucide-react';
import type { Bot } from '@shared/types';
import { api } from '../lib/api';
import { acknowledgeSubmission, beginSubmission, pendingSubmission } from '../lib/chatSubmission';
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
import { observeComposerInput, resetInputLatency } from '../lib/inputLatency';
import { useDisplayText } from '../lib/useDisplayText';

const MAX_H = 144;
const drafts = new Map<string, string>();
const prefilledDrafts = new Set<string>();
const pendingSends = new Map<string, symbol>();
const sendErrors = new Map<string, string>();
const draftListeners = new Set<(key: string) => void>();
const notifyDraft = (key: string) => draftListeners.forEach(listener => listener(key));
const draftText = (key: string) => drafts.get(key) ?? pendingSubmission(key)?.text ?? '';
function isActiveComposer(accountId: string | undefined, botId: string) {
  const state = useStore.getState();
  const ui = useConfigUI.getState();
  return !!accountId && state.user?.id === accountId && state.selectedBotId === botId && !state.modal
    && !(state.detailsOpen && detailsReplaceChat()) && !state.viewerOpen
    && !hasOpenModal() && ui.view === 'chat' && !ui.appSettings && !ui.botSettings && (!state.mobile || state.mobilePane === 'chat');
}
useStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) { resetInputLatency(); drafts.clear(); prefilledDrafts.clear(); pendingSends.clear(); sendErrors.clear(); }
});

/** PD-R2-02: put a starting prompt in a Bot's composer draft (kept after any text already there). Nothing is sent. */
export function prefillComposer(botId: string, text: string) {
  const accountId = useStore.getState().user?.id;
  if (!accountId) return;
  const key = `${accountId}:${botId}`;
  const current = drafts.get(key)?.trimEnd() ?? '';
  if (current.includes(text.trim())) return;
  drafts.set(key, current ? `${current}\n${text}` : text);
  prefilledDrafts.add(key);
  notifyDraft(key);
}

export const Composer = memo(function Composer({ bot, running }: { bot: Bot; running: boolean }) {
  const clean = useDisplayText();
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
  const [text, setText] = useState(() => draftText(draftKey));
  const [sending, setSending] = useState(() => pendingSends.has(draftKey));
  const [error, setError] = useState<string | null>(() => sendErrors.get(draftKey) ?? null);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current ? observeComposerInput(ref.current) : undefined, [accountId]);
  const measureRef = useRef<{ field: HTMLTextAreaElement; max?: number } | null>(null);
  const prefillPointerFocus = useRef(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const dictationCancelRef = useRef<HTMLButtonElement>(null);
  const dictationRange = useRef<{ text: string; start: number; end: number } | null>(null);
  const setModal = useStore((s) => s.setModal);

  // Per-bot drafts.
  // Phones don't take focus on open: it would raise the keyboard over the conversation.
  useEffect(() => {
    const sync = (key: string) => {
      if (key !== draftKey) return;
      setText(draftText(key)); setSending(pendingSends.has(key)); setError(sendErrors.get(key) ?? null);
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

  const placePrefillCaret = () => {
    const el = ref.current;
    if (el && prefilledDrafts.has(draftKey)) el.setSelectionRange(el.value.length, el.value.length);
  };
  useLayoutEffect(placePrefillCaret, [draftKey, text]);

  // Keep the measuring field mounted and isolated. Adding/removing it on each
  // key invalidates document styles, including a long conversation's markdown.
  useLayoutEffect(() => {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '0', height: '0', overflow: 'hidden', visibility: 'hidden', contain: 'strict', pointerEvents: 'none' });
    const field = document.createElement('textarea');
    field.tabIndex = -1;
    Object.assign(field.style, { height: '0px', minHeight: '0px', maxHeight: 'none', border: '0px', boxSizing: 'border-box', overflow: 'hidden' });
    host.append(field);
    document.body.append(host);
    measureRef.current = { field };
    return () => { measureRef.current = null; host.remove(); };
  }, []);

  // Auto-grow.
  const grow = useCallback((refreshGeometry = false) => {
    const el = ref.current;
    const measure = measureRef.current;
    if (!el || !measure) return;
    // Hidden (display: none) measures 0; leave the natural one-line height until it's shown.
    if (!el.offsetParent) { el.style.height = ''; return; }
    const composer = el.closest<HTMLElement>('.composer');
    if (!composer) return;
    // Geometry and fonts change on resize, pane/catalog changes or font load,
    // not on each keystroke. Keep their style writes out of the typing path.
    if (refreshGeometry || !measure.max) {
      const fieldStyle = getComputedStyle(el);
      // Mirror the rendered field, including fractional widths and padding.
      // A single isolated measure avoids resetting the visible field's height
      // on each key, which would also lay out the conversation above it.
      Object.assign(measure.field.style, { font: fieldStyle.font, letterSpacing: fieldStyle.letterSpacing,
        padding: fieldStyle.padding, width: `${el.getBoundingClientRect().width}px` });
      measure.max = MAX_H;
    }
    const max = measure.max;
    measure.field.value = el.value;
    const desired = measure.field.scrollHeight;
    const height = Math.max(24, Math.min(Math.ceil(desired / 24) * 24, max));
    el.style.height = `${height}px`;
    composer.style.setProperty('--composer-field-height', `${height}px`);
    el.style.overflowY = desired > max ? 'auto' : 'hidden';
  }, []);
  useLayoutEffect(() => grow(true), [onScreen, mobile, grow]);
  // Commit the controlled value immediately. Coalesce sizing into one frame
  // instead of forcing layout inside every discrete keyboard event.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => grow());
    return () => cancelAnimationFrame(frame);
  }, [text, grow]);
  // Settings hide the chat pane without unmounting it; measure again when the window or the pane changes.
  const settingsOpen = useConfigUI(s => !!s.appSettings);
  useLayoutEffect(() => grow(true), [settingsOpen, grow]);
  useEffect(() => {
    const resize = () => grow(true);
    window.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('resize', resize);
    document.fonts.addEventListener('loadingdone', resize);
    return () => {
      window.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('resize', resize);
      document.fonts.removeEventListener('loadingdone', resize);
    };
  }, [grow]);
  useEffect(() => {
    const composer = ref.current?.closest('.composer');
    if (!composer) return;
    const widths = new Map<Element, number>();
    const observer = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        if (widths.get(entry.target) !== entry.contentRect.width) changed = true;
        widths.set(entry.target, entry.contentRect.width);
      }
      if (changed) grow(true);
    });
    observer.observe(composer);
    // Catalog loads can change the chip width without resizing the outer composer.
    if (ref.current) observer.observe(ref.current);
    const chip = composer.querySelector('.model-pill-anchor');
    if (chip) observer.observe(chip);
    return () => observer.disconnect();
  }, [grow]);

  // The Paper ring reflects the supported, selected effort in either billing mode.
  const catalog = useModels(useShallow(({ provider, billing, defaultModel, byId }) => ({ provider, billing, defaultModel, byId })));
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
      const submission = beginSubmission(draftKey, t);
      await api.send(bot.id, t, submission.id);
      acknowledgeSubmission(draftKey, submission.id);
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

  const stop = async () => {
    const origin = document.activeElement;
    let moved = false;
    const trackFocus = (event: FocusEvent) => {
      if (event.target !== origin && event.target !== ref.current && event.target !== document.body) moved = true;
    };
    document.addEventListener('focusin', trackFocus);
    try {
      await api.interrupt(bot.id);
      if (!moved && active.current && isActiveComposer(accountId, bot.id)) ref.current?.focus({ preventScroll: true });
    } catch (e) {
      if (active.current && isActiveComposer(accountId, bot.id)) setError((e as Error).message);
    } finally { document.removeEventListener('focusin', trackFocus); }
  };
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
  const connecting = useVoice((s) => s.status === 'connecting');
  const callBotId = useVoice((s) => s.botId);
  const inCall = anyCall && !connecting && callBotId === bot.id;
  const switchingCall = anyCall && !connecting && !inCall;
  const dictation = useDictation(insertText, setError, bot.voiceLanguage, {
    contextKey: `${bot.id}:${bot.generation}`, enabled: !anyCall && onScreen,
  });
  const voiceLabel = connecting ? 'Connecting' : inCall ? `End call with ${bot.name}` : switchingCall ? `Switch call to ${bot.name}` : `Start live voice with ${bot.name}`;
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
    // Read the store at click time so repeated events cannot toggle pending setup.
    const call = useVoice.getState();
    if (call.status === 'connecting') return;
    // Keep AudioContext creation inside the user gesture; cancellation is synchronous.
    dictation.cancel();
    setError(null);
    try { if (call.status === 'live' && call.botId === bot.id) endCall(); else startCall(bot.id); }
    catch (e) { setError((e as Error).message || 'Could not start live voice'); }
  };

  const hasText = text.trim().length > 0;

  return (
    <div className="composer-area" ref={area}>
      {error && <div className="composer__error" role="alert">{clean(error)} <button type="button" className="link-btn" onClick={() => { sendErrors.delete(draftKey); setError(null); }}>Dismiss</button></div>}
      {dictation.state !== 'idle' && (
        <div className="composer__dictation">
          <span role="status">{dictation.state === 'starting' ? 'Opening microphone' : dictation.state === 'recording' ? 'Dictating a message' : 'Transcribing message'}</span>
          <div className="composer__dictation-actions">
            {dictation.state === 'recording' && <button type="button" className="link-btn" onClick={dictation.stop} aria-label="Use transcript · stop dictation">Use transcript</button>}
            <button ref={dictationCancelRef} type="button" className="link-btn" onClick={dictation.cancel} aria-label="Cancel dictation">Cancel</button>
          </div>
        </div>
      )}
      <div className={`composer-shell effort-motion${ultra ? ' is-top-effort' : ''}${flare ? ' is-flaring' : ''}`} data-effort={effort ?? undefined}>
      {animated && <span className="composer__glow" aria-hidden />}
      <div className={`composer${animated ? ' has-effort' : ''}${ultra ? ' is-ultracode' : ''}`}>

        <div className="composer__bar">
        <div className="composer__left">
          <span className="composer__plus-anchor">
            <button ref={moreRef} type="button" className="composer__btn" onClick={() => setMenu(!menu)} aria-label="More actions" aria-expanded={menu}>
              <Icon name="composer_plus" opacity={0.56} />
            </button>
            {menu && (
              <Menu
                triggerRef={moreRef}
                placement="above"
                onClose={() => setMenu(false)}
                items={[
                  { label: 'New conversation', onSelect: fresh },
                  { label: 'Connect apps', onSelect: () => setModal('apps') },
                  liveVoiceMenuItem(voice, inCall, switchingCall ? bot.name : undefined, connecting),
                  ...(!anyCall && dictation.state === 'idle' ? [{ label: 'Dictate a message', hint: 'Text only', icon: TextCursorInput, onSelect: dictate }] : []),
                ]}
              />
            )}
          </span>
        <textarea
          ref={ref}
          className="composer__input"
          rows={1}
          value={text}
          placeholder={mobile ? 'Message' : `Message ${bot.name}`}
          onChange={(e) => { prefilledDrafts.delete(draftKey); setText(e.target.value); }}
          onFocus={placePrefillCaret}
          onPointerDown={() => { prefillPointerFocus.current = document.activeElement !== ref.current && prefilledDrafts.has(draftKey); }}
          onClick={() => {
            // A pointer's native caret placement follows focus. Restore the initial prefill position
            // after that placement, while later clicks in the focused field can move the caret normally.
            if (prefillPointerFocus.current) placePrefillCaret();
            prefillPointerFocus.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
          }}
          aria-label={`Message ${bot.name}`}
        />
          <ComposerModelMenu bot={bot} />
        </div>
        <div className="composer__right">
          {!hasText && !running && <button
            type="button"
            className={`composer__cta composer__voice${inCall ? ' is-in-call' : ''}`}
            aria-label={voiceLabel}
            aria-pressed={inCall}
            aria-busy={connecting}
            disabled={connecting}
            title={connecting ? 'Connecting' : switchingCall ? `End the current call and talk to ${bot.name}` : inCall ? 'End the call; Bot work continues in chat' : `Talk to ${bot.name} live to coordinate work and hear results`}
            onClick={voice}
          >
            {connecting ? <LoaderCircle size={16} className="composer__voice-spinner" aria-hidden /> : inCall ? <PhoneOff size={16} aria-hidden /> : <Icon name="mic" />}
            </button>}
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
      <p className="composer__note">External actions ask first.</p>
    </div>
  );
}, (previous, next) => previous.running === next.running && composerBotKeys.every(key => previous.bot[key] === next.bot[key]));

// These are the Bot fields used by the composer, its model menu and dictation.
// Preview, unread and presence updates belong to the sidebar, not the draft.
const composerBotKeys = ['id', 'name', 'model', 'effort', 'fast', 'voiceLanguage', 'generation'] as const;

/** The same live-call action is always available, including with a saved draft. */
export function liveVoiceMenuItem(onSelect: () => void, inCall: boolean, switchTo?: string, connecting = false) {
  return { label: connecting ? 'Connecting' : inCall ? 'End live call' : 'Talk live', hint: switchTo ? `Switch to ${switchTo}` : undefined, icon: connecting ? LoaderCircle : inCall ? PhoneOff : Mic, onSelect };
}

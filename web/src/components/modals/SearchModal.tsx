import { useAdaptedNavigation } from '../AllSections';
import { Page } from '../layout';
import { configApi } from '../../lib/configApi';
import { deliverablesApi } from '../../lib/deliverablesApi';
import { navigation as appNavigation } from '../../configStore';
import { botSlug } from '../../lib/userRoutes';
import { FileText, ListTodo } from 'lucide-react';
import '../../styles/search.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { displayName, useStore } from '../../store';
import { Icon } from '../Icon';
import { openConversation } from '../../configStore';
import { api, type ConversationSearchHit } from '../../lib/api';
import { scrollToRow } from '../../lib/scrollToRow';
import { Modal } from './Modal';

type WorkHit = { id: string; botId: string; title: string; kind: 'file' | 'task' };
type Item = { kind: 'bot'; id: string } | { kind: 'message'; hit: ConversationSearchHit } | WorkHit;

function SearchText({ text, fallback, className }: { text: string; fallback: string; className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    const context = document.createElement('canvas').getContext('2d');
    if (!element || !context) return;
    let mounted = true;
    const measure = () => {
      if (!mounted) return;
      context.font = getComputedStyle(element).font;
      setCompact(text.split(/\s+/).some(word => context.measureText(word).width > element.clientWidth));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    void document.fonts.ready.then(measure);
    return () => { mounted = false; observer.disconnect(); };
  }, [text]);
  return <span ref={ref} className={className} title={text}>{compact ? <><span aria-hidden="true">{fallback}</span><span className="sr-only">{text}</span></> : text}</span>;
}

/** Search Bots by name and every Bot's visible conversation by message text (MF-028, PD-08 option B). */
export function SearchModal({ inline = false }: { inline?: boolean }) {
  const adapted = useAdaptedNavigation();
  const bots = useStore((s) => s.bots);
  const accountId = useStore((s) => s.user?.id);
  const setModal = useStore((s) => s.setModal);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [work, setWork] = useState<WorkHit[]>([]);
  const [workError, setWorkError] = useState(false);
  const [workLoading, setWorkLoading] = useState(false);
  const [messages, setMessages] = useState<ConversationSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const navigation = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setModal(null), [setModal]);

  const results = useMemo(() => {
    const ordered = [...bots].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || b.lastActivityAt - a.lastActivityAt);
    const needle = q.trim().toLowerCase();
    if (!needle) return ordered;
    return ordered.filter((b) => `${b.name} ${b.label} ${b.description}`.toLowerCase().includes(needle));
  }, [bots, q]);

  // Message search runs on the server across all Bots, debounced while typing.
  useEffect(() => {
    const needle = q.trim();
    setSearchError(null); setWork([]); setWorkError(false);
    if (needle.length < 2) { setMessages([]); setSearching(false); return; }
    let live = true;
    setSearching(true);
    const timer = setTimeout(() => {
      api.conversationSearch(needle)
        .then(r => { if (live && useStore.getState().user?.id === accountId) setMessages(r.results ?? []); })
        .catch(e => { if (live) { setMessages([]); setSearchError((e as Error).message || 'Message search is unavailable'); } })
        .finally(() => { if (live) setSearching(false); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [q, accountId]);

  useEffect(() => {
    const needle = q.trim().toLowerCase();
    if (needle.length < 2) { setWorkLoading(false); return; }
    setWorkLoading(true);
    let alive = true;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const records = await Promise.allSettled([configApi.tasks(), ...bots.filter(bot => bot.kind !== 'room').map(bot => deliverablesApi.list(bot.id, controller.signal))]);
      if (!alive || useStore.getState().user?.id !== accountId) return;
      const hits: WorkHit[] = [];
      for (const record of records) if (record.status === 'fulfilled') {
        if ('tasks' in record.value) hits.push(...record.value.tasks.map(task => ({ kind: 'task' as const, id: task.id, botId: task.botId, title: task.title })));
        else hits.push(...record.value.artifacts.map(file => ({ kind: 'file' as const, id: file.id, botId: file.botId, title: file.filename })));
      }
      setWork(hits.filter(hit => bots.some(bot => bot.id === hit.botId) && hit.title.toLowerCase().includes(needle)));
      setWorkError(records.some(record => record.status === 'rejected'));
      setWorkLoading(false);
    }, 250);
    return () => { alive = false; controller.abort(); clearTimeout(timer); };
  }, [q, accountId, bots]);

  const items: Item[] = useMemo(() => [
    ...results.map(b => ({ kind: 'bot' as const, id: b.id })),
    ...messages.filter(m => bots.some(b => b.id === m.botId)).map(hit => ({ kind: 'message' as const, hit })),
    ...work,
  ], [results, messages, bots, work]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    setOpening(false);
    setOpenError(null);
    return () => { navigation.current++; };
  }, [q, accountId]);
  useEffect(() => { setActive(a => Math.min(a, Math.max(0, items.length - 1))); }, [items.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = async (item: Item | undefined) => {
    if (!item || opening) return;
    if (item.kind === 'bot') { openConversation(item.id); return; }
    if (item.kind === 'file' || item.kind === 'task') {
      const bot = bots.find(bot => bot.id === item.botId);
      if (bot) appNavigation.navigate({ kind: 'work', route: { tab: item.kind === 'file' ? 'Reports' : 'Tasks', botSlug: botSlug(bot) } });
      return;
    }
    if (item.kind !== 'message') return;
    const request = ++navigation.current;
    setOpening(true);
    setOpenError(null);
    try {
      const { botId, generation, seq } = item.hit;
      const found = await useStore.getState().ensureRowLoaded(botId, generation, seq);
      if (request !== navigation.current || useStore.getState().user?.id !== accountId) return;
      if (!found) { setOpenError('This message is no longer available. Search again.'); return; }
      openConversation(botId);
      scrollToRow(seq, { botId, generation });
    } catch {
      if (request === navigation.current) setOpenError("Couldn't load this message. Try selecting it again.");
    } finally {
      if (request === navigation.current) setOpening(false);
    }
  };
  const botResults = results.length;
  const messageItems = items.filter(item => item.kind === 'message');
  const needle = q.trim();

  return (
    <Modal embedded={inline} onClose={close} className="search-modal" label="Search" passThrough=".sidebar">
      <Page type="list" className="search-page"><div className="search-modal__field">
        <span className="search-modal__icon"><Icon name="search" size={18} opacity={0.56} /></span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          aria-label="Search"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.max(0, Math.min(a + 1, items.length - 1))); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter' && items[active]) { e.preventDefault(); choose(items[active]); }
          }}
        />
        <button type="button" className="icon-btn" aria-label="Close search" onClick={close}><Icon name="close" size={20} /></button>
      </div>
      {adapted && <a href="#all" className="cfg-btn" style={{ minHeight: 44 }}>All sections</a>}
      <div className="search-modal__results" ref={listRef} role="listbox" aria-label="Search results">
        {botResults > 0 && <div className="search-modal__section">Bots</div>}
        {results.map((b, i) => (
          <button
            key={b.id}
            type="button"
            disabled={opening}
            role="option"
            aria-selected={i === active}
            data-idx={i}
            className={`search-row${i === active ? ' is-active' : ''}`}
            onMouseMove={() => setActive(i)}
            onClick={() => choose({ kind: 'bot', id: b.id })}
          >
            <BotAvatarFor bot={b} size={28} />
            <span className="search-row__text">
              <SearchText className="search-row__name" text={displayName(b)} fallback="Bot" />

            </span>
          </button>
        ))}
        {needle.length >= 2 && (messageItems.length > 0 || searching || searchError) && <div className="search-modal__section">Messages</div>}
        {messageItems.map((item, j) => {
          if (item.kind !== 'message') return null;
          const i = botResults + j;
          const bot = bots.find(b => b.id === item.hit.botId)!;
          return (
            <button
              key={`${item.hit.botId}:${item.hit.generation}:${item.hit.seq}`}
              type="button"
              disabled={opening}
              role="option"
              aria-selected={i === active}
              data-idx={i}
              className={`search-row${i === active ? ' is-active' : ''}`}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(item)}
            >
              <BotAvatarFor bot={bot} size={28} />
              <span className="search-row__text">
                <SearchText className="search-row__name" text={item.hit.role === 'user' ? `You to ${bot.name}` : bot.name} fallback="Message" />
                <SearchText className="search-row__sub" text={item.hit.text} fallback="Open message" />
              </span>
            </button>
          );
        })}
        {work.length > 0 && <div className="search-modal__section">Files and tasks</div>}
        {work.map((item, j) => {
          const index = botResults + messageItems.length + j;
          return <button key={`${item.kind}:${item.id}`} type="button" className={`search-row${index === active ? ' is-active' : ''}`} role="option" aria-selected={index === active} data-idx={index} onMouseMove={() => setActive(index)} onClick={() => void choose(item)}>
            {item.kind === 'file' ? <FileText size={20} aria-hidden /> : <ListTodo size={20} aria-hidden />}<span className="search-row__text"><SearchText className="search-row__name" text={item.title} fallback={item.kind === 'file' ? 'Saved file' : 'Task details'} /><SearchText className="search-row__sub" text={bots.find(bot => bot.id === item.botId)?.name ?? 'Bot'} fallback="Bot" /></span>
          </button>;
        })}
        {workError && <p role="status">Some files or tasks could not load.</p>}
        {opening && <div className="search-modal__empty" role="status">Loading the message...</div>}
        {openError && <div className="search-modal__empty" role="status">{openError}</div>}
        {needle.length >= 2 && searching && messageItems.length === 0 && <div className="search-modal__empty" role="status">Searching messages...</div>}
        {searchError && <div className="search-modal__empty" role="status">{searchError}</div>}
        {items.length === 0 && !searching && !workLoading && !searchError && !workError && <div className="search-modal__empty" role="status">No matches<p>Try another word.</p><button type="button" className="btn btn--secondary" onClick={() => setQ('')}>Clear search</button></div>}
      </div>
      </Page>
    </Modal>
  );
}

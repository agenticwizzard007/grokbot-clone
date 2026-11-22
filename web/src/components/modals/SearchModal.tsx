import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { displayName, useStore } from '../../store';
import { Icon } from '../Icon';
import { openConversation } from '../../configStore';
import { api, type ConversationSearchHit } from '../../lib/api';
import { scrollToRow } from '../../lib/scrollToRow';
import { Modal } from './Modal';

type Item = { kind: 'bot'; id: string } | { kind: 'message'; hit: ConversationSearchHit };

/** Search Bots by name and every Bot's visible conversation by message text (MF-028, PD-08 option B). */
export function SearchModal() {
  const bots = useStore((s) => s.bots);
  const accountId = useStore((s) => s.user?.id);
  const setModal = useStore((s) => s.setModal);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [messages, setMessages] = useState<ConversationSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
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
    setSearchError(null);
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

  const items: Item[] = useMemo(() => [
    ...results.map(b => ({ kind: 'bot' as const, id: b.id })),
    ...messages.filter(m => bots.some(b => b.id === m.botId)).map(hit => ({ kind: 'message' as const, hit })),
  ], [results, messages, bots]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => { setActive(a => Math.min(a, Math.max(0, items.length - 1))); }, [items.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    if (item.kind === 'bot') { openConversation(item.id); return; }
    openConversation(item.hit.botId);
    scrollToRow(item.hit.seq);
  };
  const botResults = results.length;
  const messageItems = items.slice(botResults);
  const needle = q.trim();

  return (
    <Modal onClose={close} className="search-modal" label="Search">
      <div className="search-modal__field">
        <span className="search-modal__icon"><Icon name="search" size={18} opacity={0.56} /></span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search Bots and messages"
          aria-label="Search"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.max(0, Math.min(a + 1, items.length - 1))); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === 'Enter' && items[active]) { e.preventDefault(); choose(items[active]); }
          }}
        />
      </div>
      <div className="search-modal__results" ref={listRef} role="listbox" aria-label="Search results">
        {botResults > 0 && <div className="search-modal__section">Bots</div>}
        {results.map((b, i) => (
          <button
            key={b.id}
            type="button"
            role="option"
            aria-selected={i === active}
            data-idx={i}
            className={`search-row${i === active ? ' is-active' : ''}`}
            onMouseMove={() => setActive(i)}
            onClick={() => choose({ kind: 'bot', id: b.id })}
          >
            <BotAvatarFor bot={b} size={28} />
            <span className="search-row__text">
              <span className="search-row__name">{displayName(b)}</span>
              <span className="search-row__sub">{b.lastPreview ?? (b.description || 'No messages yet')}</span>
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
              role="option"
              aria-selected={i === active}
              data-idx={i}
              className={`search-row${i === active ? ' is-active' : ''}`}
              onMouseMove={() => setActive(i)}
              onClick={() => choose(item)}
            >
              <BotAvatarFor bot={bot} size={28} />
              <span className="search-row__text">
                <span className="search-row__name">{item.hit.role === 'user' ? `You to ${bot.name}` : bot.name}</span>
                <span className="search-row__sub">{item.hit.text}</span>
              </span>
            </button>
          );
        })}
        {needle.length >= 2 && searching && messageItems.length === 0 && <div className="search-modal__empty" role="status">Searching messages...</div>}
        {searchError && <div className="search-modal__empty" role="status">{searchError}</div>}
        {items.length === 0 && !searching && !searchError && <div className="search-modal__empty" role="status">No Bots or messages match “{q}”<p>Try a different name or a word from the conversation.</p><button type="button" className="btn btn--secondary" onClick={() => setQ('')}>Clear search</button></div>}
      </div>
    </Modal>
  );
}

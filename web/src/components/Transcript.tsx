import { isInternalRow, userFacingLive } from '../lib/audience';
import { CoworkerSetupCards } from './CoworkerSetupCards';
import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Bot, LiveState, MessageBody, Row, ToolCallBody } from '@shared/types';
import { BotAvatar, BotAvatarFor } from '../avatar/BotAvatar';
import { clock, dividerLabel } from '../lib/time';
import { useStore } from '../store';
import { ActivityLine } from './ActivityLine';
import { FlockMark } from './FlockMark';
import { CardRow } from './cards/Cards';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { appToolLabel } from '@shared/tool-activity';
import { ElapsedTimer, fmtElapsed } from './BrailleSpinner';
import { AgentExchangeGroup } from './AgentExchangeGroup';
import { groupExchanges, type ExchangeGroup } from '../lib/agentExchanges';
import { useAgentExchanges } from '../lib/useAgentExchanges';

type Item =
  | { kind: 'exchange'; key: string; group: ExchangeGroup }
  | { kind: 'divider'; key: string; ts: number }
  | { kind: 'group'; key: string; side: 'left' | 'right'; from?: MessageBody['from']; rows: Row[] }
  | { kind: 'steps'; key: string; rows: Row[] }
  | { kind: 'row'; key: string; row: Row };

const DIVIDER_GAP = 60 * 60 * 1000;
const GROUP_GAP = 5 * 60 * 1000;

/** Turns rows into render items: date dividers, grouped bubbles, collapsed tool-call steps, cards, events. */
function buildItems(rows: Row[], exchanges: ExchangeGroup[]): Item[] {
  const items: Item[] = [];
  let prevTs = 0;
  const entries = [...rows.map(row => ({ at: row.createdAt, row, exchange: null as ExchangeGroup | null })), ...exchanges.map(exchange => ({ at: exchange.createdAt, row: null as Row | null, exchange }))].sort((a, b) => a.at - b.at);
  for (const entry of entries) {
    const key = entry.row ? `r${entry.row.seq}` : `e${entry.exchange!.id}`;
    if (!prevTs || entry.at - prevTs > DIVIDER_GAP) items.push({ kind: 'divider', key: `d${key}`, ts: entry.at });
    prevTs = entry.at;
    if (entry.exchange) { items.push({ kind: 'exchange', key, group: entry.exchange }); continue; }
    const row = entry.row!;
    const last = items[items.length - 1];
    const b = row.body;
    if (b.type === 'tool-call') {
      if (last?.kind === 'steps') last.rows.push(row);
      else items.push({ kind: 'steps', key: `s${row.seq}`, rows: [row] });
      continue;
    }
    if (b.type === 'message') {
      if (!b.text && !b.streaming) continue;
      const side = b.role === 'user' && (!b.from || b.from.kind === 'voice' || isText(b.from.kind)) ? 'right' : 'left';
      const sender = b.from ? `${b.from.kind}:${b.from.id}` : b.role;
      const lastRow = last?.kind === 'group' ? last.rows[last.rows.length - 1] : null;
      const lastBody = lastRow?.body as MessageBody | undefined;
      const lastSender = lastBody ? (lastBody.from ? `${lastBody.from.kind}:${lastBody.from.id}` : lastBody.role) : null;
      if (last?.kind === 'group' && lastSender === sender && row.createdAt - lastRow!.createdAt < GROUP_GAP) last.rows.push(row);
      else items.push({ kind: 'group', key: `g${row.seq}`, side, from: b.from, rows: [row] });
      continue;
    }
    items.push({ kind: 'row', key: `r${row.seq}`, row });
  }
  return items;
}

function cornerClass(i: number, n: number) {
  if (n < 2) return '';
  if (i === 0) return ' is-first';
  if (i === n - 1) return ' is-last';
  return ' is-mid';
}

const Bubble = memo(function Bubble({ row, side, pos, botName }: { row: Row; side: 'left' | 'right'; pos: string; botName: string }) {
  const b = row.body as MessageBody;
  return (
    <div className={`bubble-wrap is-${side}`} data-row-seq={row.seq}>
      <div className={`bubble is-${side === 'right' ? 'user' : 'agent'}${pos}${b.streaming ? ' is-streaming' : ''}`}>
        <div className="bubble__sender">{side === 'right' ? 'You' : b.from?.name || botName}</div>
        {side === 'right' ? <div className="bubble__plain">{b.text}</div> : <Markdown text={b.text || ' '} />}
        {b.citations && b.citations.length > 0 && (
          <div className="bubble__cites">
            {b.citations.slice(0, 6).map((c, i) => {
              let host = c.url;
              try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch { /* keep */ }
              return <a key={i} className="cite-chip" href={c.url} target="_blank" rel="noreferrer noopener" title={c.title ?? c.url}>{host}</a>;
            })}
          </div>
        )}
      </div>
      <span className="bubble__time">{clock(row.createdAt)}</span>
    </div>
  );
});

/** A small speech-bubble mark for messages that arrived by text. */
function TextMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden style={{ opacity: 0.56 }}>
      <path fill="currentColor" d="M12 3C6.5 3 2 6.7 2 11.3c0 2.5 1.3 4.7 3.4 6.2-.2 1.3-.8 2.6-1.8 3.5 1.9-.1 3.7-.8 5-1.9 1.1.3 2.2.5 3.4.5 5.5 0 10-3.7 10-8.3S17.5 3 12 3z" />
    </svg>
  );
}

const isText = (kind: NonNullable<MessageBody['from']>['kind']) => kind === 'imessage' || kind === 'sms' || kind === 'whatsapp';

function SenderLabel({ from }: { from: NonNullable<MessageBody['from']> }) {
  const bot = useStore((s) => (from.kind === 'bot' ? s.bots.find((b) => b.id === from.id) : undefined));
  return (
    <div className="sender-label">
      {bot ? <BotAvatarFor bot={bot} size={16} /> : from.kind === 'routine' ? <Icon name="clock" size={12} opacity={0.56} /> : from.kind === 'voice' ? <Icon name="voice_a" size={12} opacity={0.56} /> : isText(from.kind) ? <TextMark /> : <BotAvatar shape="blob" color="gray" size={16} />}
      <span>{from.kind === 'routine' ? `Routine · ${from.name}` : from.kind === 'voice' ? 'Asked on a voice call' : from.kind === 'imessage' ? 'Sent by iMessage' : from.kind === 'sms' ? 'Sent by SMS' : from.kind === 'whatsapp' ? 'Sent by WhatsApp' : `From ${from.name}`}</span>
    </div>
  );
}

function Steps({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState(false);
  // Keep execution visible even when the user collapses completed history.
  const visible = open ? rows : rows.filter(r => ['queued', 'running', 'awaiting-approval'].includes((r.body as ToolCallBody).status));
  const n = rows.length;
  return (
    <div className={`steps${open ? ' is-open' : ''}`}>
      <button type="button" className="steps__toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        {n} {n === 1 ? 'step' : 'steps'}
        <Icon name="chev_down" size={10} opacity={0.66} className="steps__chev" />
      </button>
      {visible.length > 0 && (
        <ul className="steps__list">
          {visible.map((r) => {
            const c = r.body as ToolCallBody;
            return <li key={c.callId} className={`step is-${c.status}`}>
              <span className="step__dot" />
              <span className="step__label">{appToolLabel(c.name, c.args) ?? c.label}</span>
              {c.status === 'running' && <span className="step__summary">Running · <ElapsedTimer since={c.startedAt ?? r.createdAt} /></span>}
              {c.status === 'queued' && <span className="step__summary">Queued</span>}
              {c.status === 'awaiting-approval' && <span className="step__summary">Waiting for approval</span>}
              {c.summary && c.summary !== 'done' && c.summary !== 'failed' && <span className="step__summary">{c.summary}</span>}
              {c.status === 'done' && <span className="step__summary">Done{c.startedAt !== undefined && c.completedAt !== undefined ? ` · ${fmtElapsed(c.completedAt - c.startedAt)}` : ''}</span>}
              {c.status === 'error' && <span className="step__summary">Failed</span>}
              {c.status === 'denied' && !c.summary && <span className="step__summary">Not allowed</span>}
              {c.screenshot && <img className="step__shot" src={c.screenshot} alt="" />}
            </li>;
          })}
        </ul>
      )}
    </div>
  );
}

function SystemRow({ row }: { row: Row }) {
  const b = row.body;
  if (b.type === 'event') return <div className="system-event" data-row-seq={row.seq}>{b.text}</div>;
  if (b.type === 'notice') return <div className={`notice is-${b.tone ?? 'info'}`} data-row-seq={row.seq}>{b.text}</div>;
  // display: contents keeps the card layout unchanged while giving deep links (search, Tasks) an anchor.
  if (b.type === 'card') return <div data-row-seq={row.seq} style={{ display: 'contents' }}><CardRow row={row} /></div>;
  return null;
}

interface Props { bot: Bot; generation: number; rows: Row[]; live: LiveState | undefined; loaded: boolean }

export const Transcript = memo(function Transcript({ bot, generation, rows, live, loaded }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const responseSlot = useRef<HTMLDivElement>(null);
  const responseHeight = useRef(0);
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const connected = useStore(s => s.sseConnected);
  const exchanges = useAgentExchanges(bot.id, generation, loaded && bot.kind !== 'room', connected);
  const visibleRows = useMemo(() => rows.filter(r => !isInternalRow(r)), [rows]);
  const groups = useMemo(() => groupExchanges(exchanges.exchanges, visibleRows), [exchanges.exchanges, visibleRows]);
  const items = useMemo(() => buildItems(visibleRows, groups), [visibleRows, groups]);
  live = userFacingLive(live);

  const running = !!live?.isRunning;
  const waiting = !running && (!!live?.awaiting || live?.activity?.kind === 'waiting_for_you');
  const last = visibleRows[visibleRows.length - 1];
  const streamingNow = last?.body.type === 'message' && last.body.role === 'assistant' && !!last.body.streaming;
  // A first response may delegate work before it starts streaming. Only exchange
  // history from before this turn disqualifies the default processing mark.
  const firstPrompt = visibleRows.find(r => r.body.type === 'message' && r.body.role === 'user' && r.body.from?.kind !== 'bot' && r.body.from?.kind !== 'routine');
  const firstTurnStartedAt = firstPrompt?.createdAt ?? live?.startedAt;
  const priorExchanges = groups.some(group => firstTurnStartedAt == null || group.createdAt < firstTurnStartedAt);
  const firstTurn = loaded && !priorExchanges && !visibleRows.some(r => r.body.type === 'message'
    && (r.body.role !== 'user' || r.body.from?.kind === 'bot' || r.body.from?.kind === 'routine'));
  const processing = firstTurn && running && !live?.awaiting && !streamingNow;
  const empty = loaded && visibleRows.length === 0 && groups.length === 0;
  const firstAssistant = items.find(it => it.kind === 'group' && it.rows.some(r => r.body.type === 'message' && r.body.role === 'assistant'));
  const showActivity = ((running && !streamingNow) || waiting)
    && (!firstTurn || !!live?.awaiting || waiting || visibleRows.some(r => r.body.type !== 'message'));

  // Keep the reservation through CSS reflow as well as state changes. The first
  // assistant row replaces this slot, so its last measured height must survive.
  useLayoutEffect(() => {
    const slot = responseSlot.current;
    if (!slot) return;
    const measure = () => {
      responseHeight.current = Math.max(responseHeight.current, slot.offsetHeight);
      slot.style.minHeight = `${responseHeight.current}px`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    return () => observer.disconnect();
  }, [firstTurn, empty, processing]);

  // Keep pinned to the bottom while new content arrives, unless the user scrolled up.
  useLayoutEffect(() => {
    // Hand the reserved space to the first response, including any tool status.
    // Keep it for this generation so a short reply or no-output finish cannot
    // collapse the scroll extent and move the user's message.
    if (responseSlot.current) responseHeight.current = Math.max(responseHeight.current, responseSlot.current.offsetHeight);
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [rows, live, loaded, bot.id, exchanges.exchanges]);
  // Jump to bottom when switching bots.
  useLayoutEffect(() => {
    stick.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bot.id]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return; // a scroll event can arrive after the chat unmounts (for example when Create opens a new Bot)
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = dist < 40;
    setShowJump(dist > 200);
  };

  const jump = () => {
    const el = scrollRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className="transcript-wrap">
    <div className="transcript" ref={scrollRef} onScroll={onScroll}>
      <div className="transcript__col">
        {empty && !processing && <EmptyChat bot={bot} />}
        {exchanges.more && <button type="button" className="agent-exchange__more" disabled={exchanges.loading} onClick={exchanges.loadMore}>Earlier agent conversations</button>}
        {exchanges.error && <p className="agent-exchange__error" role="status">Couldn’t refresh agent conversations. <button type="button" onClick={exchanges.retry}>Retry</button></p>}
        {items.map((it) => {
          switch (it.kind) {
            case 'exchange':
              return <AgentExchangeGroup key={`${bot.id}:${generation}:${it.key}`} group={it.group} botId={bot.id} generation={generation} />;
            case 'divider':
              return <div key={it.key} className="divider">{dividerLabel(it.ts)}</div>;
            case 'steps':
              return <Steps key={it.key} rows={it.rows} />;
            case 'row':
              return <SystemRow key={it.key} row={it.row} />;
            case 'group':
              return (
                <div key={it.key} className={`group is-${it.side}`} style={it === firstAssistant && responseHeight.current ? { minHeight: responseHeight.current } : undefined}>
                  {it.from && <SenderLabel from={it.from} />}
                  {it.rows.map((r, i) => (
                    <Fragment key={r.seq}><Bubble row={r} side={it.side} botName={bot.name} pos={cornerClass(i, it.rows.length)} /></Fragment>
                  ))}
                </div>
              );
          }
        })}
        {firstTurn && (!empty || processing) && (
          <div ref={responseSlot} className={`first-response${empty ? ' first-response--empty' : ''}`} style={{ minHeight: responseHeight.current || undefined }}>
            <div className="first-response__mark" role={processing ? 'status' : undefined} aria-label={processing ? 'Working' : undefined}>
              <FlockMark size={72} working={processing} />
            </div>
            {showActivity && live && <ActivityLine bot={bot} live={live} rows={visibleRows} />}
          </div>
        )}
        {bot.isPrimary && <CoworkerSetupCards key={bot.id} coordinator={bot} />}
        {!firstTurn && showActivity && live && <ActivityLine bot={bot} live={live} rows={visibleRows} />}
      </div>
    </div>
      {showJump && (
        <button type="button" className="jump-btn" onClick={jump} aria-label="Scroll to bottom">
          <Icon name="arrow_down" size={16} />
        </button>
      )}
    </div>
  );
});

function EmptyChat({ bot }: { bot: Bot }) {
  return (
    <div className="empty-chat">
      <BotAvatarFor bot={bot} size={72} />
      <div className="empty-chat__title">{bot.name}</div>
      <div className="empty-chat__sub">{bot.description || (bot.mode === 'teammate' ? 'A Bot for the whole team. Hand it a task and it will see it through.' : 'Your personal assistant. Hand it a task and it will see it through.')}</div>
    </div>
  );
}

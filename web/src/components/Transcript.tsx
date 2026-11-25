import { api } from '../lib/api';
import { LoadFeedback } from './LoadFeedback';
import { MessageSkeleton } from './ChatSkeleton';
import { useDisplayText } from '../lib/useDisplayText';
import { isInternalRow, userFacingLive } from '../lib/audience';
import { CoworkerSetupCards } from './CoworkerSetupCards';
import { Fragment, memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Bot, LiveState, MessageBody, Row, ToolCallBody } from '@shared/types';
import { BotAvatar, BotAvatarFor } from '../avatar/BotAvatar';
import { clock, dividerLabel } from '../lib/time';
import { useStore } from '../store';
import { ActivityLine } from './ActivityLine';
import { CardRow } from './cards/Cards';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { appToolLabel } from '@shared/tool-activity';
import { ElapsedTimer, fmtElapsed } from './BrailleSpinner';
import { AgentExchangeGroup } from './AgentExchangeGroup';
import { groupExchanges, type ExchangeGroup } from '../lib/agentExchanges';
import { useAgentExchanges } from '../lib/useAgentExchanges';
import { FlockMark } from './FlockMark';
import { CompletedReplyAnnouncer } from './CompletedReplyAnnouncer';
import { Copy } from 'lucide-react';
import { toast } from '../lib/toast';
import { stepApprovalOutcome } from '../lib/stepApproval';

type Item =
  | { kind: 'exchange'; key: string; group: ExchangeGroup }
  | { kind: 'divider'; key: string; ts: number }
  | { kind: 'group'; key: string; side: 'left' | 'right'; from?: MessageBody['from']; rows: Row[] }
  | { kind: 'steps'; key: string; rows: Row[] }
  | { kind: 'row'; key: string; row: Row };

const DIVIDER_GAP = 60 * 60 * 1000;
const GROUP_GAP = 5 * 60 * 1000;

/** Turns rows into render items: date dividers, grouped bubbles, collapsed tool-call steps, cards, events. */
function buildItems(rows: Row[], exchanges: ExchangeGroup[], separateReplies: Set<number>): Item[] {
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
      // Blank model deltas do not replace the processing flock with a bubble.
      if (b.role === 'assistant' ? !b.text.trim() : !b.text && !b.streaming) continue;
      const side = b.role === 'user' && (!b.from || b.from.kind === 'voice' || isText(b.from.kind)) ? 'right' : 'left';
      const sender = b.from ? `${b.from.kind}:${b.from.id}` : b.role;
      const lastRow = last?.kind === 'group' ? last.rows[last.rows.length - 1] : null;
      const lastBody = lastRow?.body as MessageBody | undefined;
      const lastSender = lastBody ? (lastBody.from ? `${lastBody.from.kind}:${lastBody.from.id}` : lastBody.role) : null;
      if (last?.kind === 'group' && lastSender === sender && lastRow?.body.jobId === row.body.jobId && !separateReplies.has(row.seq) && row.createdAt - lastRow!.createdAt < GROUP_GAP) last.rows.push(row);
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
  const clean = useDisplayText();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Measure before deferring layout, so prepended and searched history keeps
    // its exact space. A whole sender group can span hundreds of messages.
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.height <= 0) return;
      element.style.containIntrinsicHeight = `auto ${entry.contentRect.height}px`;
      element.style.contentVisibility = 'auto';
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className={`bubble-wrap is-${side}`} data-row-seq={row.seq}>
      <div className={`bubble is-${side === 'right' ? 'user' : 'agent'}${pos}${b.streaming ? ' is-streaming' : ''}`}>
        <div className="bubble__sender">{side === 'right' ? 'You' : clean(b.from?.name || botName)}</div>
        {side === 'right' ? <div className="bubble__plain">{b.text}</div> : <Markdown text={clean(b.text) || ' '} />}
        {b.interrupted && <div className="bubble__interrupted">Interrupted reply</div>}
        {b.citations && b.citations.length > 0 && (
          <div className="bubble__cites">
            {b.citations.slice(0, 6).map((c, i) => {
              let host = c.url;
              try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch { /* keep */ }
              return <a key={i} className="cite-chip" href={c.url} target="_blank" rel="noreferrer noopener" title={clean(c.title ?? c.url)}>{clean(host)}</a>;
            })}
          </div>
        )}
      </div>
      {!b.streaming && <button type="button" className="bubble__copy" aria-label="Copy message" title="Copy message" onClick={async () => {
        try { await navigator.clipboard.writeText(side === 'right' ? b.text : clean(b.text)); toast('Copied'); }
        catch { toast('Could not copy. Select the text and copy it.', { tone: 'error' }); }
      }}><Copy size={16} aria-hidden /></button>}
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
  const clean = useDisplayText();
  const bot = useStore((s) => (from.kind === 'bot' ? s.bots.find((b) => b.id === from.id) : undefined));
  return (
    <div className="sender-label">
      {bot ? <BotAvatarFor bot={bot} size={16} /> : from.kind === 'routine' ? <Icon name="clock" size={12} opacity={0.56} /> : from.kind === 'voice' ? <Icon name="voice_a" size={12} opacity={0.56} /> : isText(from.kind) ? <TextMark /> : <BotAvatar shape="blob" color="gray" size={16} />}
      <span>{from.kind === 'routine' ? `Routine · ${clean(from.name)}` : from.kind === 'voice' ? 'Asked on a voice call' : from.kind === 'imessage' ? 'Sent by iMessage' : from.kind === 'sms' ? 'Sent by SMS' : from.kind === 'whatsapp' ? 'Sent by WhatsApp' : `From ${clean(from.name)}`}</span>
    </div>
  );
}

function Steps({ rows }: { rows: Row[] }) {
  const clean = useDisplayText();
  const [open, setOpen] = useState(false);
  const decisions = useStore(s => s.approvalDecisions);
  // Keep execution visible even when the user collapses completed history.
  const visible = open ? rows : rows.filter(r => stepApprovalOutcome(r.body as ToolCallBody, decisions)
    || ['queued', 'running', 'awaiting-approval', 'uncertain', 'interrupted'].includes((r.body as ToolCallBody).status));
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
            const outcome = stepApprovalOutcome(c, decisions);
            return <li key={c.callId} className={`step is-${outcome?.status ?? c.status}`}>
              <span className="step__dot" />
              <span className="step__label">{clean(appToolLabel(c.name, c.args) ?? c.label)}</span>
              {outcome ? <span className="step__summary">{outcome.label}</span> : <>
              {c.status === 'running' && <span className="step__summary">Running · <ElapsedTimer since={c.startedAt ?? r.createdAt} /></span>}
              {c.status === 'queued' && <span className="step__summary">Queued</span>}
              {c.status === 'awaiting-approval' && <span className="step__summary">Waiting for approval</span>}
              {c.summary && c.summary !== 'done' && c.summary !== 'failed' && <span className="step__summary">{clean(c.summary)}</span>}
              {c.status === 'done' && <span className="step__summary">Done{c.startedAt !== undefined && c.completedAt !== undefined ? ` · ${fmtElapsed(c.completedAt - c.startedAt)}` : ''}</span>}
              {c.status === 'error' && <span className="step__summary">Failed</span>}
              {c.status === 'denied' && !c.summary && <span className="step__summary">Not allowed</span>}
              {c.status === 'uncertain' && <span className="step__summary">Result unknown</span>}
              {c.status === 'interrupted' && <span className="step__summary">Interrupted</span>}
              </>}
              {c.screenshot && <img className="step__shot" src={c.screenshot} alt="" />}
            </li>;
          })}
        </ul>
      )}
    </div>
  );
}

const SystemRow = memo(function SystemRow({ row }: { row: Row }) {
  const clean = useDisplayText();
  const b = row.body;
  const [retrying, setRetrying] = useState(false);
  const [retried, setRetried] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const submissionId = useRef<string>();
  const running = useStore(s => s.live[row.botId]?.isRunning);
  const retry = async () => {
    if (b.type !== 'notice' || !b.retry || retrying) return;
    setRetrying(true); setRetryError(null);
    submissionId.current ??= crypto.randomUUID();
    try {
      await api.send(row.botId, b.retry.text, submissionId.current);
      setRetried(true);
      await useStore.getState().loadRows(row.botId, { resync: true });
    } catch (error) { setRetryError((error as Error).message); }
    finally { setRetrying(false); }
  };
  if (b.type === 'event') return <div className="system-event" data-row-seq={row.seq}>{clean(b.text)}</div>;
  if (b.type === 'notice') return <div className={`notice is-${b.tone ?? 'info'}`} data-row-seq={row.seq} data-recovery-job={b.recovery?.jobId}>
    <div>{b.text === 'Stopped.' ? 'This request was interrupted before it finished. Send your request again to retry.' : clean(b.text)}</div>
    {b.credits && <div className="credit-notice">
      <p>{b.credits.provider} could not fund this request. Check your API balance or wait for other requests to finish, then retry.</p>
      {b.credits.billingUrl && <a href={b.credits.billingUrl} target="_blank" rel="noopener noreferrer">Manage {b.credits.provider} credits</a>}
      <details className="recovery-activity"><summary>Provider error details</summary><p>{b.credits.details}</p></details>
    </div>}
    {b.retry && <button type="button" className="btn btn--secondary" disabled={retrying || retried || running} onClick={() => void retry()}>{retrying ? 'Retrying...' : retried ? 'Retried' : 'Retry'}</button>}
    {retryError && <div role="alert">{retryError}</div>}
    {b.recovery && <details className="recovery-activity">
      <summary>Review activity</summary>
      {b.recovery.activity.length ? <ul>{b.recovery.activity.map((step, index) => <li key={index}>
        <strong>{clean(step.label)}</strong>: {recoveryStatus[step.status]}
        {step.summary && <div>{clean(step.summary)}</div>}
      </li>)}</ul> : <p>No tool actions were recorded for this request.</p>}
    </details>}
  </div>;
  // display: contents keeps the card layout unchanged while giving deep links (search, Tasks) an anchor.
  if (b.type === 'card') return <div data-row-seq={row.seq} style={{ display: 'contents' }}><CardRow row={row} /></div>;
  return null;
});

const recoveryStatus: Record<ToolCallBody['status'], string> = {
  done: 'Completed', error: 'Failed', denied: 'Not allowed', uncertain: 'Result unknown',
  interrupted: 'Interrupted before dispatch', queued: 'Queued', running: 'Running', 'awaiting-approval': 'Waiting for approval',
};

interface Props { bot: Bot; generation: number; rows: Row[]; live: LiveState | undefined; loaded: boolean }

// Card anchors use display: contents, so their child owns the visible rectangle.
const rowRect = (anchor: HTMLElement) => (anchor.style.display === 'contents' && anchor.firstElementChild ? anchor.firstElementChild : anchor).getBoundingClientRect();

export const Transcript = memo(function Transcript({ bot, generation, rows, live, loaded }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const readingPosition = useRef<{ seq: string; top: number } | null>(null);
  const transcript = useStore(s => s.transcripts[bot.id]);
  const paging = transcript?.generation === generation ? transcript : undefined;
  const responseSlot = useRef<HTMLDivElement>(null);
  const responseHeight = useRef(0);
  const responseHeights = useRef(new Map<number, number>());
  const responseTurn = useRef<{ startedAt: number | null; promptSeq: number }>({ startedAt: null, promptSeq: 0 });
  const stick = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const connected = useStore(s => s.sseConnected);
  const exchanges = useAgentExchanges(bot.id, generation, loaded && bot.kind !== 'room', connected);
  const visibleRows = useMemo(() => rows.filter(r => !isInternalRow(r)), [rows]);
  const groups = useMemo(() => groupExchanges(exchanges.exchanges, visibleRows), [exchanges.exchanges, visibleRows]);
  live = userFacingLive(live);

  const running = !!live?.isRunning;
  const waiting = !running && (!!live?.awaiting || live?.activity?.kind === 'waiting_for_you');
  const streamingNow = visibleRows.some(row => row.body.type === 'message' && row.body.role === 'assistant' && row.body.streaming && row.body.text.trim());
  const promptSeq = visibleRows.findLast(row => row.body.type === 'message' && row.body.role === 'user'
    && row.body.from?.kind !== 'bot' && row.body.from?.kind !== 'routine')?.seq ?? 0;
  // A queued prompt can precede the previous run's answer. Use the run boundary
  // once available, and retain it after stopping so a no-output finish stays put.
  const turn = running && live?.startedAt != null
    ? { startedAt: live.startedAt, promptSeq }
    : promptSeq !== responseTurn.current.promptSeq
      ? { startedAt: null, promptSeq }
      : responseTurn.current;
  const firstReply = visibleRows.find(row => row.body.type === 'message' && row.body.role === 'assistant' && row.body.text.trim()
    && (turn.startedAt != null ? row.createdAt >= turn.startedAt : row.seq > turn.promptSeq));
  const items = useMemo(() => {
    const separateReplies = new Set(responseHeights.current.keys());
    if (firstReply && responseHeight.current) separateReplies.add(firstReply.seq);
    return buildItems(visibleRows, groups, separateReplies);
  }, [visibleRows, groups, firstReply?.seq]);
  const interruptedTurn = !running && visibleRows.some(row => row.seq > promptSeq && row.body.type === 'notice' && (row.body.recovery || row.body.terminal || row.body.tone === 'error' || row.body.text === 'Stopped.'));
  const pendingResponse = loaded && !firstReply && !interruptedTurn;
  const processing = pendingResponse && running && !live?.awaiting && live?.activity?.kind !== 'waiting_for_you' && !streamingNow;
  const empty = loaded && !paging?.error && !paging?.loading && visibleRows.length === 0 && groups.length === 0;
  const activeTools = visibleRows.some(row => row.body.type === 'tool-call' && ['queued', 'running', 'awaiting-approval'].includes(row.body.status));
  const showActivity = ((running && !streamingNow) || waiting)
    && (!!live?.awaiting || waiting || activeTools);

  // Each reply inherits its own measured slot. Retain earlier reservations so a
  // later turn or a wrapped activity line cannot resize completed history.
  useLayoutEffect(() => {
    responseTurn.current = turn;
    if (firstReply && responseHeight.current) {
      responseHeights.current.set(firstReply.seq, responseHeight.current);
      responseHeight.current = 0;
    }
  }, [turn.startedAt, turn.promptSeq, firstReply?.seq]);
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
  }, [pendingResponse, turn.startedAt, turn.promptSeq, empty, processing]);

  const rememberPosition = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Following the bottom needs no history measurements. For a reader higher
    // up, ordered row anchors let us find the visible row in logarithmic reads.
    if (stick.current) { readingPosition.current = null; return; }
    const top = el.getBoundingClientRect().top;
    const anchors = el.querySelectorAll<HTMLElement>('[data-row-seq]');
    let low = 0, high = anchors.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (rowRect(anchors[mid]).bottom > top) high = mid;
      else low = mid + 1;
    }
    const anchor = anchors[low];
    readingPosition.current = anchor ? { seq: anchor.dataset.rowSeq!, top: rowRect(anchor).top - top } : null;
  }, []);

  // Row updates preserve the visible anchor, including prepends and streaming edits.
  // New content still follows the bottom unless the user has scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const previous = readingPosition.current;
    if (!stick.current && previous) {
      const anchor = el.querySelector<HTMLElement>(`[data-row-seq="${previous.seq}"]`);
      if (anchor) el.scrollTop += rowRect(anchor).top - el.getBoundingClientRect().top - previous.top;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
    rememberPosition();
    setShowJump(!stick.current && el.scrollHeight - el.scrollTop - el.clientHeight >= 40);
  }, [rows, loaded, bot.id, exchanges.exchanges, rememberPosition]);
  // Lazy markdown can change height after the rows commit. Keep the latest
  // message in view, or preserve the reader's anchor while older content formats.
  useLayoutEffect(() => {
    const el = scrollRef.current, column = el?.firstElementChild;
    if (!el || !column) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
      else {
        const position = readingPosition.current;
        const anchor = position && el.querySelector<HTMLElement>(`[data-row-seq="${position.seq}"]`);
        if (anchor) el.scrollTop += rowRect(anchor).top - el.getBoundingClientRect().top - position!.top;
      }
      rememberPosition();
      setShowJump(!stick.current && el.scrollHeight - el.scrollTop - el.clientHeight >= 40);
    });
    observer.observe(column);
    observer.observe(el);
    return () => observer.disconnect();
  }, [bot.id, rememberPosition]);
  // Jump to bottom when switching bots.
  useLayoutEffect(() => {
    stick.current = true;
    readingPosition.current = null;
    setShowJump(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [bot.id, generation]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return; // a scroll event can arrive after the chat unmounts (for example when Create opens a new Bot)
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = dist < 40;
    setShowJump(!stick.current);
    rememberPosition();
    // Fetch one earlier window when the reader reaches the top. Initial bottom
    // positioning and short transcripts must not walk the entire history.
    if (el.scrollTop < 80 && dist > 200 && paging?.olderCursor != null && !paging.loadingOlder && !paging.olderError) {
      void useStore.getState().loadOlderRows(bot.id).catch(() => {});
    }
  };

  const jump = () => {
    const el = scrollRef.current;
    stick.current = true;
    setShowJump(false);
    // Immediate movement also respects reduced motion and cannot race new deltas.
    el?.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    rememberPosition();
  };

  return (
    <div className="transcript-wrap">
    <CompletedReplyAnnouncer key={`${bot.id}:${generation}`} rows={visibleRows} loaded={loaded} botName={bot.name} />
    {(!loaded || paging?.error || paging?.loading) && <LoadFeedback label="messages" error={paging?.error} loading={!!paging?.loading || (!loaded && !paging?.error)} stale={loaded || rows.length > 0} onRetry={() => { void useStore.getState().loadRows(bot.id).catch(() => {}); }} />}
    <div className="transcript" ref={scrollRef} onScroll={onScroll} data-bot-id={bot.id} data-generation={generation}>
      <div className="transcript__col">
        {!loaded && !paging?.error && <MessageSkeleton />}
        {paging?.olderCursor != null && <button type="button" className="transcript__older" disabled={paging.loadingOlder} onClick={() => useStore.getState().loadOlderRows(bot.id).catch(() => {})}>{paging.loadingOlder ? 'Loading earlier messages...' : 'Earlier messages'}</button>}
        {paging?.olderError && <p className="transcript__error" role="status">{paging.olderError}</p>}
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
            case 'group': {
              const height = Math.max(0, ...it.rows.map(row => Math.max(responseHeights.current.get(row.seq) ?? 0, row.seq === firstReply?.seq ? responseHeight.current : 0)));
              return (
                <div key={it.key} className={`group is-${it.side}`} style={height ? { minHeight: height } : undefined}>
                  {it.from && <SenderLabel from={it.from} />}
                  {it.rows.map((r, i) => (
                    <Fragment key={r.seq}><Bubble row={r} side={it.side} botName={bot.name} pos={cornerClass(i, it.rows.length)} /></Fragment>
                  ))}
                </div>
              );
            }
          }
        })}
        {pendingResponse && (!empty || processing) && (
          <div ref={responseSlot} className={`first-response${empty ? ' first-response--empty' : ''}`} style={{ minHeight: responseHeight.current || undefined }}>
            {processing && <div className="first-response__mark" role="status" aria-label="Working">
              <FlockMark size={32} working />
            </div>}
            {showActivity && live && <ActivityLine bot={bot} live={live} rows={visibleRows} />}
          </div>
        )}
        {bot.isPrimary && <CoworkerSetupCards key={bot.id} coordinator={bot} />}
        {!pendingResponse && showActivity && live && <ActivityLine bot={bot} live={live} rows={visibleRows} />}
      </div>
    </div>
      {showJump && (
        <div className="transcript__jump">
          <button type="button" className="jump-btn" onClick={jump} aria-label="Jump to latest">
            <Icon name="arrow_down" size={16} /><span>Jump to latest</span>
          </button>
        </div>
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

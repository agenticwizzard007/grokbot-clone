import { useEffect, useId, useMemo, useState } from 'react';
import type { AgentExchangeMessage } from '@shared/coordination-types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { exchangeApi, type ExchangeGroup } from '../lib/agentExchanges';
import { clock, dividerLabel } from '../lib/time';
import { displayExchangeText } from '../lib/stripInternalIds';

const statuses = { queued: 'Queued', deferred: 'Waiting to send', admitted: 'In progress', completed: 'Finished', failed: 'Failed' };

export function AgentExchangeGroup({ group, botId, generation }: { group: ExchangeGroup; botId: string; generation: number }) {
  const [open, setOpen] = useState(false);
  const [pages, setPages] = useState(1);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState({ messages: [] as AgentExchangeMessage[], loading: false, error: false, more: false });
  const panelId = useId();
  const participants = useMemo(() => [...new Map(group.exchanges.flatMap(exchange => exchange.participants).map(bot => [bot.id, bot])).values()], [group]);
  const count = group.exchanges.reduce((total, exchange) => total + exchange.messageCount, 0);
  const label = `${count} ${count === 1 ? 'message' : 'messages'} with ${participants.length} ${participants.length === 1 ? 'Bot' : 'Bots'}`;
  const version = group.exchanges.map(e => `${e.id}:${e.version}:${e.lastSeq}`).join('|');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setState(old => ({ ...old, loading: true, error: false }));
    void Promise.all(group.exchanges.map(async exchange => {
      const messages: AgentExchangeMessage[] = [];
      let after: number | null = 0;
      for (let page = 0; page < pages; page++) {
        const result = await exchangeApi.messages(botId, generation, exchange, after, controller.signal);
        messages.push(...result.messages);
        after = result.nextAfter;
        if (after === null) break;
      }
      return { messages, more: after !== null };
    })).then(results => {
      if (!controller.signal.aborted) setState({ messages: results.flatMap(r => r.messages).sort((a, b) => a.seq - b.seq), more: results.some(r => r.more), loading: false, error: false });
    }).catch(() => { if (!controller.signal.aborted) setState(old => ({ ...old, loading: false, error: true })); });
    return () => controller.abort();
    // The version covers membership, message additions and status changes.
  }, [open, botId, generation, version, pages, retry]);
  const name = (id: string) => participants.find(p => p.id === id)?.name ?? 'Bot';
  return <section className={`agent-exchange${open ? ' is-open' : ''}`}>
    <button type="button" className="agent-exchange__toggle" aria-label={label} aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
      <span>{count} {count === 1 ? 'message' : 'messages'} with</span>
      <span className="agent-exchange__avatars" aria-hidden="true">
        {participants.slice(0, 3).map(bot => <BotAvatarFor key={bot.id} bot={bot} size={12} />)}
      </span>
      <span>{participants.length} {participants.length === 1 ? 'Bot' : 'Bots'}</span>
    </button>
    {open && <div id={panelId} className="agent-exchange__panel" role="region" aria-label="Agent conversation">
      <p className="agent-exchange__participants">{participants.map(p => p.name).join(', ')}</p>
      <ol className="agent-exchange__messages">
        {state.messages.map(message => {
          // R2F-002: results show a chip; the server sends clean text, the header strip is only a safety net.
          const shown = displayExchangeText(message.text, { botName: id => participants.find(p => p.id === id)?.name });
          return <li key={message.id}>
            <div className="agent-exchange__meta"><strong>{name(message.fromBotId)} → {name(message.toBotId)}</strong>{(message.kind === 'result' || shown.result) && <span className="agent-exchange__chip">Result</span>}<time dateTime={new Date(message.createdAt).toISOString()} title={dividerLabel(message.createdAt)}>{clock(message.createdAt)}</time><span>{statuses[message.status]}</span></div>
            <p>{shown.text}</p>
          </li>;
        })}
      </ol>
      {state.loading && <p role="status">Loading messages…</p>}
      {state.error && <p role="alert">Couldn’t refresh this conversation. <button type="button" onClick={() => setRetry(n => n + 1)}>Retry</button></p>}
      {state.more && <button type="button" className="agent-exchange__more" disabled={state.loading} onClick={() => setPages(n => n + 1)}>Show more messages</button>}
    </div>}
  </section>;
}

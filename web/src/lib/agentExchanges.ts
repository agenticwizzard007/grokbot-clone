import type { AgentExchange, AgentExchangesPage, AgentExchangeMessagesPage } from '@shared/coordination-types';
import type { Row } from '@shared/types';

async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/team/exchanges${path}`, { credentials: 'include', signal });
  if (!response.ok) throw new Error('Couldn’t load agent conversations.');
  return response.json();
}
export const exchangeApi = {
  list: (botId: string, generation: number, before: number | null, signal: AbortSignal) => read<AgentExchangesPage>(`?${new URLSearchParams({ botId, generation: String(generation), ...(before === null ? {} : { before: String(before) }) })}`, signal),
  messages: (botId: string, generation: number, exchange: AgentExchange, after: number, signal: AbortSignal) => read<AgentExchangeMessagesPage>(`/${encodeURIComponent(exchange.id)}?${new URLSearchParams({ botId, generation: String(generation), after: String(after), through: String(exchange.lastSeq) })}`, signal),
};

export interface ExchangeGroup { id: string; createdAt: number; exchanges: AgentExchange[] }

/** Combine adjacent conversations, but never cross a visible chat message. */
export function groupExchanges(exchanges: AgentExchange[], rows: Row[]): ExchangeGroup[] {
  const messages = rows.filter(row => row.body.type === 'message').map(row => row.createdAt);
  const groups: ExchangeGroup[] = [];
  for (const exchange of [...exchanges].sort((a, b) => a.createdAt - b.createdAt || a.firstSeq - b.firstSeq)) {
    const previous = groups.at(-1);
    const last = previous?.exchanges.at(-1);
    if (previous && last && exchange.createdAt - last.createdAt <= 5 * 60_000 && !messages.some(at => at > last.createdAt && at <= exchange.createdAt)) previous.exchanges.push(exchange);
    else groups.push({ id: exchange.id, createdAt: exchange.createdAt, exchanges: [exchange] });
  }
  return groups;
}

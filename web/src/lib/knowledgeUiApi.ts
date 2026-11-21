import type { MessageSource, SourceMessage } from './configApi';
import { nativeRequest } from './learningApi';

export type ConversationFilters = { query: string; role: '' | 'user' | 'assistant'; generation: string };
export type ConversationPage = { messages: SourceMessage[]; nextOffset: number | null };

export function conversationSearchPath(botId: string, filters: ConversationFilters, offset: number) {
  const params = new URLSearchParams({ q: filters.query.trim(), offset: String(offset), limit: '10' });
  if (filters.role) params.set('role', filters.role);
  if (filters.generation) {
    const generation = Number(filters.generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Enter a positive conversation number.');
    params.set('generation', String(generation));
  }
  return `/bots/${encodeURIComponent(botId)}/conversation-search?${params}`;
}

export function conversationSourcePath(source: MessageSource) {
  const params = new URLSearchParams();
  if (source.contentHash) params.set('contentHash', source.contentHash);
  if (source.kind === 'tool') params.set('kind', 'tool');
  return `/bots/${encodeURIComponent(source.botId)}/messages/${source.generation}/${source.seq}${params.size ? `?${params}` : ''}`;
}

export const knowledgeUiApi = {
  search: (botId: string, filters: ConversationFilters, offset: number, signal: AbortSignal) =>
    nativeRequest<ConversationPage>(conversationSearchPath(botId, filters, offset), 'GET', undefined, signal),
  source: (source: MessageSource, signal: AbortSignal) =>
    nativeRequest<{ messages: SourceMessage[] }>(conversationSourcePath(source), 'GET', undefined, signal),
};

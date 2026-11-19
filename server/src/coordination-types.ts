/** Read-only chat presentation of recorded agent-to-agent messages. */
export interface ExchangeParticipant { id: string; name: string; avatarShape: string; avatarColor: string }
export interface AgentExchange {
  id: string;
  firstSeq: number;
  lastSeq: number;
  createdAt: number;
  messageCount: number;
  version: number;
  participants: ExchangeParticipant[];
}
export interface AgentExchangeMessage {
  id: string; seq: number; fromBotId: string; toBotId: string; text: string;
  status: 'queued' | 'deferred' | 'admitted' | 'completed' | 'failed';
  kind: 'request' | 'result'; createdAt: number;
}
export interface AgentExchangesPage { exchanges: AgentExchange[]; nextBefore: number | null }
export interface AgentExchangeMessagesPage { messages: AgentExchangeMessage[]; nextAfter: number | null }

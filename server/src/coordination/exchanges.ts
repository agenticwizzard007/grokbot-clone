import './schema.js';
import { db } from '../db.js';
import { assertTenant } from '../deployment.js';
import { displayCoordinationText } from '../lib/redact.js';
import type { AgentExchange, AgentExchangeMessage, AgentExchangesPage, AgentExchangeMessagesPage, ExchangeParticipant } from '../coordination-types.js';

// Use the first participation in a thread, not a later reply, to bind it to a
// conversation. A delayed result must never restore a cleared conversation.
// Pre-binding records are safe only in generation 1 (a never-cleared chat).
const scope = `WITH request_events AS (
 SELECT source_id,MIN(seq),data FROM native_events WHERE user_id=@userId AND kind='coordination.requested' GROUP BY source_id
), owned AS (
 SELECT r.* FROM coordination_requests r
 JOIN bots f ON f.id=r.from_bot_id AND f.user_id=r.user_id
 JOIN bots t ON t.id=r.to_bot_id AND t.user_id=r.user_id WHERE r.user_id=@userId
), participation AS (
 SELECT r.correlation_id, ROW_NUMBER() OVER (PARTITION BY r.correlation_id ORDER BY r.seq) position,
 COALESCE(CASE WHEN r.from_bot_id=@botId THEN json_extract(e.data,'$.fromGeneration') ELSE json_extract(e.data,'$.toGeneration') END,1) generation
 FROM owned r LEFT JOIN request_events e ON e.source_id=r.id WHERE r.from_bot_id=@botId OR r.to_bot_id=@botId
), visible AS (
 SELECT r.* FROM owned r JOIN participation p ON p.correlation_id=r.correlation_id AND p.position=1 AND p.generation=@generation
)`;

export class ExchangeUnavailable extends Error {
  constructor() { super('Conversation not found.'); }
}

function binding(userId: string, botId: string, generation: number) {
  assertTenant(userId);
  if (!db.prepare('SELECT 1 FROM bots WHERE user_id=? AND id=? AND generation=?').get(userId, botId, generation)) throw new ExchangeUnavailable();
  return { userId, botId, generation };
}

export function listAgentExchanges(userId: string, botId: string, generation: number, before = Number.MAX_SAFE_INTEGER, limit = 30): AgentExchangesPage {
  const args = binding(userId, botId, generation);
  limit = Math.max(1, Math.min(50, limit));
  const rows = db.prepare(`${scope}
    SELECT correlation_id id, MIN(seq) firstSeq, MAX(seq) lastSeq, MIN(created_at) createdAt, COUNT(*) messageCount, SUM(revision) version
    FROM visible GROUP BY correlation_id HAVING MIN(seq)<@before ORDER BY firstSeq DESC LIMIT @limit
  `).all({ ...args, before, limit: limit + 1 }) as Omit<AgentExchange, 'participants'>[];
  const exchanges = rows.slice(0, limit).map(row => {
    const participants = db.prepare(`WITH members AS (
      SELECT from_bot_id id,seq FROM coordination_requests WHERE user_id=@userId AND correlation_id=@id
      UNION ALL SELECT to_bot_id,seq FROM coordination_requests WHERE user_id=@userId AND correlation_id=@id
    ) SELECT b.id,b.name,b.avatar_shape avatarShape,b.avatar_color avatarColor FROM members m
    JOIN bots b ON b.id=m.id AND b.user_id=@userId GROUP BY b.id ORDER BY MIN(m.seq),b.id`).all({ userId, id: row.id }) as ExchangeParticipant[];
    return { ...row, participants };
  });
  return { exchanges, nextBefore: rows.length > limit ? exchanges.at(-1)!.firstSeq : null };
}

export function readAgentExchange(userId: string, botId: string, generation: number, id: string, after = 0, through = Number.MAX_SAFE_INTEGER, limit = 20): AgentExchangeMessagesPage {
  const args = { ...binding(userId, botId, generation), id };
  if (!db.prepare(`${scope} SELECT 1 FROM visible WHERE correlation_id=@id LIMIT 1`).get(args)) throw new ExchangeUnavailable();
  limit = Math.max(1, Math.min(50, limit));
  const rows = db.prepare(`${scope} SELECT id,seq,from_bot_id fromBotId,to_bot_id toBotId,text,status,kind,created_at createdAt
    FROM visible WHERE correlation_id=@id AND seq>@after AND seq<=@through ORDER BY seq LIMIT @limit
  `).all({ ...args, after, through, limit: limit + 1 }) as AgentExchangeMessage[];
  // Display text: the machine header of a result is dropped (kind 'result' marks it) and internal ids
  // are replaced with names or neutral labels. The stored text keeps the header for the receiving model.
  const botName = (id: string) => (db.prepare('SELECT name FROM bots WHERE id=? AND user_id=?').get(id, userId) as { name: string } | undefined)?.name;
  const messages = rows.slice(0, limit).map(message => ({ ...message, text: displayCoordinationText(message.text, { botName }) }));
  return { messages, nextAfter: rows.length > limit ? messages.at(-1)!.seq : null };
}

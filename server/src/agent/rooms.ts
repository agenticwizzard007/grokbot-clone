import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { appendRow, emitBot } from '../store.js';
import { isConfiguring } from '../bot-setup.js';

/**
 * Group chats ("rooms"; Swarm: SwarmAgent kind=ROOM, member_agent_ids, server turn-taking).
 * A room is a bot row with kind='room' and a members list. It never runs its own agent loop:
 * a user message is dispatched to the members who should answer (@mentioned ones, else all,
 * capped), each member runs its normal loop with the group context and replies into the room
 * with post_to_group.
 */

const MAX_RESPONDERS = 3;

export function initRooms() {
  for (const col of ["kind TEXT NOT NULL DEFAULT 'agent'", 'members TEXT']) {
    try { db.exec(`ALTER TABLE bots ADD COLUMN ${col}`); } catch { /* exists */ }
  }
}

export const isRoom = (botId: string) => (db.prepare('SELECT kind FROM bots WHERE id=?').get(botId) as any)?.kind === 'room';

export function roomMembers(roomId: string): { id: string; name: string }[] {
  const r = db.prepare('SELECT members FROM bots WHERE id=?').get(roomId) as any;
  const ids: string[] = r?.members ? JSON.parse(r.members) : [];
  return ids.map((id) => db.prepare('SELECT id, name FROM bots WHERE id=?').get(id) as any).filter(Boolean);
}

export function createRoom(userId: string, name: string, memberIds: string[]) {
  const id = newId('room');
  db.prepare(
    `INSERT INTO bots(id,user_id,name,label,description,avatar_shape,avatar_color,kind,members,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'room',?,?,?)`,
  ).run(id, userId, name.slice(0, 60), 'Group', `Group chat with ${memberIds.length} Bots`, 'cloud', 'gray', JSON.stringify(memberIds), now(), now());
  hub.emit(userId, { type: 'roster' });
  return id;
}

/** The fixed answer when a group message asks a Bot to act in another app (R2F-001, PD-R2-05 B). */
export const GROUP_APPS_REFUSAL = "Group chats can't send to other apps. Ask me in my own chat.";

/** Shown in a group when a member cannot answer there yet. */
export const setupNotice = (name: string) => `${name} is still being set up and can't answer in groups yet.`;

/** Called instead of the agent loop when the user posts in a room. */
export function dispatchRoomMessage(roomId: string, text: string, enqueue: (botId: string, t: any) => void) {
  const room = db.prepare('SELECT * FROM bots WHERE id=?').get(roomId) as any;
  const members = roomMembers(roomId);
  if (!members.length) {
    appendRow(roomId, 'notice', { type: 'notice', text: 'This group has no Bots yet.', tone: 'warn' });
    return;
  }
  const lower = text.toLowerCase();
  const mentioned = members.filter((m) => lower.includes(`@${m.name.toLowerCase()}`));
  const addressed = (mentioned.length ? mentioned : members).slice(0, MAX_RESPONDERS);
  // A Bot in its setup interview has no group tools and must not answer privately or through apps.
  const configuring = addressed.filter((m) => isConfiguring(m.id));
  const responders = addressed.filter((m) => !isConfiguring(m.id));
  for (const m of configuring) appendRow(roomId, 'notice', { type: 'notice', text: setupNotice(m.name), tone: 'info' });
  const recent = (db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq DESC LIMIT 12").all(roomId, room.generation) as any[])
    .reverse()
    .map((r) => {
      const b = JSON.parse(r.body);
      return `${b.from?.name ?? (b.role === 'user' ? 'User' : 'Bot')}: ${String(b.text).slice(0, 600)}`;
    })
    .join('\n');
  for (const m of responders) {
    // roomId routes this turn's final reply into the group; internal keeps it out of the member's own chat.
    enqueue(m.id, {
      type: 'system',
      audience: 'internal',
      roomId: room.id,
      text:
        `[Group chat "${room.name}"] Members: ${members.map((x) => x.name).join(', ')}. ` +
        `${mentioned.length ? 'You were @mentioned.' : 'The user addressed the whole group.'}\n` +
        `Recent group messages:\n${recent}\n\n` +
        `Reply to the group with post_to_group (group_name "${room.name}"), or end with a short plain reply; your final reply is posted to the group for you. ` +
        `Answer from the group conversation and what you already know. Group chats can't use other apps: no connected apps, email, Slack, MCP tools, your computer or browser, and no approvals. ` +
        `If you are asked to send, post, read or check anything in another app, do not look it up; reply exactly: "${GROUP_APPS_REFUSAL}" ` +
        `Keep it short and don't repeat what other Bots already said. If you have nothing to add, call stay_silent.`,
    });
  }
}

/** Append a member's message to a group and refresh the group's sidebar row. */
export function postToRoomById(roomId: string, fromBotId: string, text: string) {
  const from = db.prepare('SELECT id, user_id, name FROM bots WHERE id=?').get(fromBotId) as any;
  const room = db.prepare("SELECT * FROM bots WHERE id=? AND kind='room'").get(roomId) as any;
  if (!from || !room || room.user_id !== from.user_id) return `No such group.`;
  const members: string[] = room.members ? JSON.parse(room.members) : [];
  if (!members.includes(fromBotId)) return `You're not a member of "${room.name}".`;
  appendRow(room.id, 'message', { type: 'message', role: 'assistant', text, audience: 'user', from: { kind: 'bot', id: from.id, name: from.name } });
  db.prepare('UPDATE bots SET unread = unread + 1 WHERE id=?').run(room.id);
  emitBot(room.id);
  return 'Posted to the group.';
}

export function postToRoom(fromBotId: string, roomName: string, text: string) {
  const from = db.prepare('SELECT id, user_id, name FROM bots WHERE id=?').get(fromBotId) as any;
  const room = db.prepare("SELECT * FROM bots WHERE user_id=? AND kind='room' AND lower(name)=lower(?)").get(from.user_id, roomName.trim()) as any;
  if (!room) return `No group named "${roomName}".`;
  return postToRoomById(room.id, fromBotId, text);
}

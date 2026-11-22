import { Hono } from 'hono';
import { db, now } from './db.js';
import { hub } from './lib/hub.js';
import { requireUser, type AuthVars } from './lib/auth.js';
import { appendRow } from './store.js';
import { roomMembers } from './agent/rooms.js';
import { isConfiguring } from './bot-setup.js';
import { readJson } from './lib/json.js';

/** /api/rooms: group chat membership. A room is a bot row with kind='room'. */
export const roomsApi = new Hono<AuthVars>();
roomsApi.use('*', requireUser);

/** Bots still in their setup interview can't answer in groups. */
function notActiveError(ids: string[]) {
  const pending = ids.filter((id) => isConfiguring(id)).map((id) => (db.prepare('SELECT name FROM bots WHERE id=?').get(id) as { name: string } | undefined)?.name ?? 'this Bot');
  return pending.length ? `Activate ${pending.join(', ')} before adding ${pending.length > 1 ? 'them' : 'it'} to a group.` : null;
}

const ownRoom = (userId: string, id: string) =>
  db.prepare("SELECT * FROM bots WHERE id=? AND user_id=? AND kind='room'").get(id, userId) as any;

roomsApi.get('/:id/members', (c) => {
  const room = ownRoom(c.get('user').id, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  const members = roomMembers(room.id).map((m) => {
    const b = db.prepare('SELECT id, name, label, avatar_shape, avatar_color FROM bots WHERE id=?').get(m.id) as any;
    return { id: b.id, name: b.name, label: b.label, avatarShape: b.avatar_shape, avatarColor: b.avatar_color };
  });
  return c.json({ members });
});

/** Create a group from the UI: { name, botIds[] }. */
roomsApi.post('/', async (c) => {
  const user = c.get('user');
  const body = await readJson<{ name?: unknown; botIds?: unknown }>(c);
  if (!body.ok) return body.response;
  const name = typeof body.data.name === 'string' ? body.data.name : '';
  const botIds = Array.isArray(body.data.botIds) ? body.data.botIds.filter((id): id is string => typeof id === 'string') : [];
  const valid = (botIds ?? []).filter((id) => db.prepare("SELECT 1 FROM bots WHERE id=? AND user_id=? AND COALESCE(kind,'agent')<>'room' AND COALESCE(hidden,0)=0").get(id, user.id));
  if (!name?.trim() || valid.length < 2) return c.json({ error: 'A group needs a name and at least 2 Bots.' }, 400);
  const notActive = notActiveError(valid);
  if (notActive) return c.json({ error: notActive }, 400);
  const { createRoom } = await import('./agent/rooms.js');
  const id = createRoom(user.id, name.trim(), [...new Set(valid)]);
  return c.json({ id });
});

roomsApi.put('/:id/members', async (c) => {
  const user = c.get('user');
  const room = ownRoom(user.id, c.req.param('id'));
  if (!room) return c.json({ error: 'not found' }, 404);
  const body = await readJson<{ botIds?: unknown }>(c);
  if (!body.ok) return body.response;
  const botIds = Array.isArray(body.data.botIds) ? body.data.botIds.filter((id): id is string => typeof id === 'string') : [];
  const before = new Set(roomMembers(room.id).map((m) => m.id));
  const next = [...new Set((botIds ?? []).filter((id) => db.prepare("SELECT 1 FROM bots WHERE id=? AND user_id=? AND COALESCE(kind,'agent')<>'room'").get(id, user.id)))];
  // Existing members stay removable; only newly added Bots must have finished setup.
  const notActive = notActiveError(next.filter((id) => !before.has(id)));
  if (notActive) return c.json({ error: notActive }, 400);
  db.prepare('UPDATE bots SET members=?, description=?, updated_at=? WHERE id=?').run(JSON.stringify(next), `Group chat with ${next.length} Bots`, now(), room.id);
  const name = (id: string) => (db.prepare('SELECT name FROM bots WHERE id=?').get(id) as any)?.name ?? id;
  const added = next.filter((id) => !before.has(id)).map(name);
  const removed = [...before].filter((id) => !next.includes(id)).map(name);
  if (added.length || removed.length) {
    appendRow(room.id, 'event', { type: 'event', event: 'bot-message', text: [added.length ? `${added.join(', ')} joined` : '', removed.length ? `${removed.join(', ')} left` : ''].filter(Boolean).join(' · ') });
  }
  hub.emit(user.id, { type: 'roster' });
  return c.json({ ok: true, members: next });
});

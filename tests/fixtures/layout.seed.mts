// Local layout fixtures. No live account or provider credentials.
import fs from 'node:fs';
const { db } = await import('../../server/src/db.js');
const { initRooms, createRoom } = await import('../../server/src/agent/rooms.js');
initRooms();
const { createBot } = await import('../../server/src/bots.js');
const now = Date.now(), userId = 'layout-owner';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, 'layout@example.test', 'Test account', now);
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run('layout-test-token', userId, now, now + 3600_000);
const bot = createBot(userId, { name: 'Coordinator', isPrimary: true });
const teammate = createBot(userId, { name: 'Research' });
const room = createRoom(userId, 'Project room', [bot.id, teammate.id]);
fs.writeFileSync(process.env.PHONE_QA_FIXTURE_FILE!, JSON.stringify({ userId, bot, room }));
db.close();

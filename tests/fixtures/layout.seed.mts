// Local layout fixtures. No live account or provider credentials.
import fs from 'node:fs';
const { db } = await import('../../server/src/db.js');
const { initRooms, createRoom } = await import('../../server/src/agent/rooms.js');
initRooms();
const { createBot } = await import('../../server/src/bots.js');
const now = Date.now(), userId = 'layout-owner';
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, 'layout@example.test', 'Test account', now);
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run('layout-test-token', userId, now, now + 3600_000);
const bot = createBot(userId, { name: 'Coordinator', isPrimary: true, avatarShape: 'bird-flock', avatarColor: 'blue' });
const teammate = createBot(userId, { name: 'Research', avatarShape: 'bird-solo', avatarColor: 'green' });
const room = createRoom(userId, 'Project room', [bot.id, teammate.id]);
// Match the waiting and working tasks in the phone QA seed.
db.prepare('INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('task_phoneqaReview', bot.id, 'Review the launch summary before it goes to the whole company', 'needs_input', 'Confirm the embargo time', now, now);
db.prepare('INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('task_phoneqaPress', bot.id, 'Collect press contacts', 'working', 'Reading the press list', now, now);
fs.writeFileSync(process.env.PHONE_QA_FIXTURE_FILE!, JSON.stringify({ userId, bot, room }));
db.close();

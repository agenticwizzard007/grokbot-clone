// Seeds one local account with realistic chat content for the phone size sweep (tests/phone-sizes-ui.mjs).
// Local SQLite only: no provider, app or messaging credentials are used.
import fs from 'node:fs';
const { db } = await import('../../server/src/db.js');
(await import('../../server/src/agent/rooms.js')).initRooms();
const { createBot } = await import('../../server/src/bots.js');
const { appendRow } = await import('../../server/src/store.js');
const file = process.env.PHONE_QA_FIXTURE_FILE!;
const userId = 'phone-qa-owner', now = Date.now();
db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, 'owner@example.test', 'Owner', now);
db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run('phone-qa-token', userId, now, now + 3600_000);
const quinn = createBot(userId, { name: 'Quinn', isPrimary: true });
const research = createBot(userId, { name: 'Research and market intelligence coworker' });
const writer = createBot(userId, { name: 'Writer' });
const say = (role: 'user' | 'assistant', text: string) => appendRow(quinn.id, 'message', { type: 'message', role, text });
say('user', 'Plan the launch week and send me a summary I can share with the team.');
say('assistant', [
  'Here is the launch week plan. I kept it short so it is easy to share.',
  '',
  '## Monday',
  '- Final review of the landing page copy with the design team',
  '- Confirm the press list and embargo time',
  '',
  '| Day | Owner | Status |',
  '| --- | --- | --- |',
  '| Monday | Research and market intelligence coworker | Ready |',
  '| Tuesday | Writer | Drafting |',
  '',
  '```',
  'curl -s https://example.test/api/launch/checklist?include=owners,deadlines,dependencies,notes',
  '```',
  '',
  'Reference: https://example.test/a/very/long/path/that/should/wrap/instead/of/pushing/the/layout/sideways/on/small/phones',
].join('\n'));
say('user', 'Draft the announcement email.');
appendRow(quinn.id, 'card', { type: 'card', card: 'draft', approvalId: '', channel: 'email', to: 'team@example.test', subject: 'Launch week plan', text: 'Hi team,\n\nThe launch week plan is ready. Monday is review day; Tuesday is drafting.\n\nThanks', status: 'pending' } as any);
appendRow(quinn.id, 'notice', { type: 'notice', text: 'Writer is still being set up and can\'t answer in groups yet.', tone: 'info' });
db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES(?,?,?,?,?,?,?,?)').run('rt_phoneqaMonday', quinn.id, 'Monday launch check-in with the whole team', 'Summarize launch status', '0 9 * * 1', 'UTC', 1, now);
db.prepare('INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('task_phoneqaReview', quinn.id, 'Review the launch summary before it goes to the whole company', 'needs_input', 'Confirm the embargo time', now, now);
db.prepare('INSERT INTO tasks(id,bot_id,title,state,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('task_phoneqaPress', quinn.id, 'Collect press contacts', 'working', 'Reading the press list', now, now);
fs.writeFileSync(file, JSON.stringify({ userId, quinn, research, writer }));
db.close();

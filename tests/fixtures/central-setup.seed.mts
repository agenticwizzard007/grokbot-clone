import fs from 'node:fs';
const { db } = await import('../../server/src/db.js');
(await import('../../server/src/agent/subagents.js')).initSubagents();
(await import('../../server/src/agent/rooms.js')).initRooms();
await import('../../server/src/agent/jobs.js');
const { createBot } = await import('../../server/src/bots.js');
const { appendRow } = await import('../../server/src/store.js');
const { createTeammate } = await import('../../server/src/agent/teammates.js');
const { computers } = await import('../../server/src/computers/index.js');
const { prepareCoworkerSetup, getSetup } = await import('../../server/src/bot-setup.js');
const file = process.env.SETUP_FIXTURE_FILE!;
if (process.argv[2] === 'revise') {
  const f = JSON.parse(fs.readFileSync(file, 'utf8'));
  const s = getSetup(f.worker.id)!;
  const answer = appendRow(f.chief.id, 'message', { type: 'message', role: 'user', text: 'Correction: summarize into four bullets, not three. Still no external actions.' });
  prepareCoworkerSetup(f.userId, f.chief.id, { ...s.brief, bot_id: f.worker.id, revision: s.onboarding.revision, stage: 'review', instructions: 'Use four factual bullets.', responsibilities: ['Summarize supplied notes in four bullets'], success_criteria: ['Four faithful bullets'], source_refs: [{ botId: f.chief.id, generation: 1, seq: answer.seq }] });
} else {
  const userId = 'central-browser-owner', otherId = 'central-browser-other';
  for (const id of [userId, otherId]) db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, id + '@example.test', id, Date.now());
  const chief = createBot(userId, { name: 'Quinn', isPrimary: true });
  const foreign = createBot(otherId, { name: 'Foreign private coworker', isPrimary: true });
  for (const [owner, token] of [[userId, 'central-browser-token'], [otherId, 'central-browser-other-token']]) db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(token, owner, Date.now(), Date.now() + 600000);
  const answer = appendRow(chief.id, 'message', { type: 'message', role: 'user', text: 'Prepare Nia to summarize my supplied notes into three bullets. Return results here. No external actions.' });
  computers.screen = async () => { throw new Error('Browser fixture computer pending'); };
  const result = await createTeammate({ creation_request_id: 'browser-create-notes', name: 'Nia', purpose: 'Summarize supplied notes', responsibilities: ['Summarize notes in three bullets'], out_of_scope: ['External actions'], success_criteria: ['Three faithful bullets'], context_summary: 'Summarize only notes supplied by the user.', action_boundaries: 'Return summaries in chat. Ask about ambiguity. No external actions.', handoff_notes: ['Return to Quinn'], workflows: [{ name: 'Summarize', trigger: 'The user requests a summary of supplied notes', steps: ['Read the notes', 'Extract three key points'], output: 'Three sourced bullets' }], instructions: 'Keep summaries factual.', source_message_seqs: [answer.seq] }, { userId, botId: chief.id, depth: 0, enqueueBotMessage: () => { throw new Error('No operational work during setup'); } });
  const worker = JSON.parse(result.output as string).bot;
  fs.writeFileSync(file, JSON.stringify({ userId, chief, worker, foreign }));
}
db.close();

// Canonical domain fixtures for the real server/browser journey; no network sends.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repository = process.env.HERMES_SERVER_ROOT ?? process.cwd();
const moduleAt = (file: string) => import(pathToFileURL(path.join(repository, 'server/src', file)).href);
const { db } = await moduleAt('db.ts');
await moduleAt('db-config.ts');
(await moduleAt('agent/subagents.ts')).initSubagents();
(await moduleAt('agent/rooms.ts')).initRooms();
const { createBot } = await moduleAt('bots.ts');
const { appendRow } = await moduleAt('store.ts');
const { getSetup, saveSetupDraft, activateSetup } = await moduleAt('bot-setup.ts');
const skills = await moduleAt('knowledge/skills.ts');
const memories = await moduleAt('knowledge/memory.ts');
const { patchLearningSettings } = await moduleAt('knowledge/settings.ts');
const { recordArtifact, requestDelivery, sendDelivery } = await moduleAt('deliverables/index.ts');
for (const id of ['experience-owner', 'experience-other']) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, id, Date.now());
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(`${id}-token`, id, Date.now(), Date.now() + 3600000);
}
const owner = 'experience-owner';
const quinn = createBot(owner, { name: 'Quinn', isPrimary: true });
const nia = createBot(owner, { name: 'Nia', description: 'Research sourced evidence.' });
const ellis = createBot(owner, { name: 'Ellis', description: 'Write grounded reports.' });
for (const bot of [quinn, nia, ellis]) {
  const answer = appendRow(bot.id, 'message', { type: 'message', role: 'user', text: 'When asked, research and draft accurate reports with named owners and source links. Ask before external outreach. Return work in chat.' });
  const initial = getSetup(bot.id);
  if (initial?.onboarding.status !== 'active') {
    const view = saveSetupDraft(bot.id, owner, { ...initial.brief, responsibilities: ['Research and draft sourced reports'], success_criteria: ['Accurate reports with named owners and source links'], action_boundaries: 'Research and draft in chat. Ask before any outreach. Never invent evidence.', workflows: [{ name: 'Sourced report', trigger: 'User asks for a report', steps: ['Inspect original sources', 'Draft with evidence'], output: 'Accurate sourced report in chat' }], handoff_notes: [], shared_resources: [], open_questions: [], instructions: '', revision: initial.onboarding.revision, stage: 'review', source_message_seqs: [answer.seq] });
    activateSetup(bot.id, view.onboarding.revision);
  }
}
const researchWeekly = appendRow(nia.id, 'message', { type: 'message', role: 'user', text: 'I prefer weekly research reports with named owners and source links.' });
const researchDaily = appendRow(nia.id, 'message', { type: 'message', role: 'user', text: 'I now prefer daily research reports with named owners and source links.' });
const researchEvidence = (row: any) => ({ botId: row.botId, generation: row.generation, seq: row.seq });
const researchMemory = memories.saveMemory(owner, nia.id, { text: 'Prefers weekly research reports with named owners and source links.', evidence: [researchEvidence(researchWeekly)] }).memory;
const researchSkill = skills.createSkill(owner, nia.id, { name: 'Research procedure', description: 'Prepare sourced research with named owners.', body: 'Inspect original sources and save a weekly research report with owners.' });
const foreign = createBot('experience-other', { name: 'Other account', isPrimary: true });
const weekly = appendRow(quinn.id, 'message', { type: 'message', role: 'user', text: 'I prefer weekly pipeline reports with named owners and source links.' });
const daily = appendRow(quinn.id, 'message', { type: 'message', role: 'user', text: 'I now prefer daily pipeline reports with named owners and source links.' });
const ref = (row: any) => ({ botId: row.botId, generation: row.generation, seq: row.seq });
const memory = memories.saveMemory(owner, quinn.id, { text: 'Prefers weekly pipeline reports with named owners and source links.', evidence: [ref(weekly)] }).memory;
const pendingMemory = memories.stageMemoryChange(owner, quinn.id, { action: 'replace', memoryId: memory.id, expectedRevision: memory.revision, text: 'Prefers daily pipeline reports with named owners and source links.', evidence: [ref(daily)] });
const skill = skills.createSkill(owner, quinn.id, { name: 'Sourced report', description: 'Prepare reports grounded in evidence.', body: '1. Read original sources.\n2. Record owners and source links.\n3. Save a concise report.' });
const legacyProposal = skills.stageSkillProposal(owner, quinn.id, { expectedRevision: 0, content: { name: 'Legacy pending procedure', description: 'An existing proposal must stay pending.', body: 'Review the original report evidence before writing.' }, reason: 'Existing proposal retained across settings changes.', evidence: [ref(weekly)] });
const artifact = recordArtifact({ userId: owner, botId: quinn.id, filename: 'sourced-report.md', content: '# Sourced report\n\nAcceptance fixture: named owners and original source links.\n' });
// Produce a real unknown outcome through the native transport seam. The adapter
// records no external write and simulates loss of provider acknowledgement.
const uncertain = await requestDelivery({ userId: owner, artifactId: artifact.id, channel: 'sms', idempotencyKey: 'experience-unknown-fixture' }, { prepare: async () => ({ channel: 'sms', phone: '+15550000000', transport: 'fixture' }), send: async () => { throw new Error('Provider acknowledgement unavailable'); } });
await sendDelivery(owner, uncertain.id, { prepare: async () => ({ channel: 'sms' }), send: async () => { throw new Error('Mock transport acknowledgement lost; no external send'); } });
appendRow(quinn.id, 'message', { type: 'message', role: 'user', text: 'INTERNAL_NARRATIVE_MUST_NOT_LEAK', from: { kind: 'bot', id: nia.id, name: 'Nia' }, audience: 'internal' });
appendRow(quinn.id, 'message', { type: 'message', role: 'assistant', text: 'INTERNAL_ASSISTANT_MUST_NOT_LEAK', audience: 'internal' });
patchLearningSettings(owner, { expectedRevision: 0, settings: { automaticReview: false } });
fs.writeFileSync(process.env.HERMES_FIXTURE_FILE!, JSON.stringify({ owner, quinn, nia, ellis, foreign, researchSkill, researchMemory, researchDaily: researchEvidence(researchDaily), memory, pendingMemory, skill, legacyProposal, artifact, uncertain, weekly: ref(weekly), daily: ref(daily) }));
db.close();

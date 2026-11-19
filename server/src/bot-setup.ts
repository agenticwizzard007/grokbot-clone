import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, now } from './db.js';
import { env } from './env.js';
import { appendHistory, appendRow, getBotRow } from './store.js';
import { hub } from './lib/hub.js';
import { publishNativeEvent } from './native/events.js';
import { assertLegacyWorkOpen } from './security/legacy-work.js';

db.exec(`CREATE TABLE IF NOT EXISTS coworker_setup_handoffs (
 bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
 job_id TEXT NOT NULL UNIQUE, approved_revision INTEGER NOT NULL, created_at INTEGER NOT NULL
)`);
type SetupHandoffEnqueue = (botId: string, trigger: { type: 'system'; audience: 'internal'; text: string }) => string;
let enqueueSetupHandoff: SetupHandoffEnqueue | undefined;

/** Runtime injects its existing durable admission path; this module never starts a second executor. */
export function bindSetupHandoffRuntime(enqueue: SetupHandoffEnqueue) { enqueueSetupHandoff = enqueue; }

export function releaseSetupHandoff(botId: string): string | null {
  return db.transaction(() => {
    const b = getBotRow(botId);
    if (!b || b.hidden || b.parent_bot_id || b.kind === 'room') return null;
    assertLegacyWorkOpen(b.user_id);
    const prior = db.prepare('SELECT job_id FROM coworker_setup_handoffs WHERE bot_id=?').get(botId) as { job_id: string } | undefined;
    if (prior) return prior.job_id;
    const s = db.prepare('SELECT * FROM bot_setups WHERE bot_id=?').get(botId) as any;
    if (!s || s.onboarding_status !== 'active' || s.computer_status !== 'ready' || !s.pending_handoff || !enqueueSetupHandoff) return null;
    const jobId = enqueueSetupHandoff(botId, { type: 'system', audience: 'internal', text: `Your setup has been confirmed by the user. Handle this initial assignment from your approved creation brief:\n${s.pending_handoff}` });
    if (!db.prepare('SELECT 1 FROM agent_jobs WHERE id=? AND bot_id=? AND user_id=?').get(jobId, botId, b.user_id)) throw new Error('Setup handoff was not durably admitted.');
    const activation = db.prepare("SELECT data FROM native_events WHERE bot_id=? AND kind='setup.activated' ORDER BY seq DESC LIMIT 1").get(botId) as { data: string } | undefined;
    const approvedRevision = activation ? JSON.parse(activation.data).approvedRevision : s.revision - 1;
    db.prepare('INSERT INTO coworker_setup_handoffs(bot_id,job_id,approved_revision,created_at) VALUES(?,?,?,?)').run(botId, jobId, approvedRevision, now());
    db.prepare('UPDATE bot_setups SET pending_handoff=NULL WHERE bot_id=?').run(botId);
    publishNativeEvent({ userId: b.user_id, botId, jobId, kind: 'setup.handoff_admitted', sourceType: 'setup', sourceId: botId, sourceRevision: s.revision, data: { jobId } });
    return jobId;
  })();
}

/** Retry admission after restart/capacity recovery without replaying an existing job. */
export function releaseReadySetupHandoffs() {
  const rows = db.prepare("SELECT bot_id FROM bot_setups WHERE onboarding_status='active' AND computer_status='ready' AND pending_handoff IS NOT NULL").all() as { bot_id: string }[];
  for (const row of rows) { try { releaseSetupHandoff(row.bot_id); } catch { /* Retain the assignment for the next admission attempt. */ } }
}

const text = (max: number) => z.string().trim().min(1).max(max);
const list = z.array(text(2000)).max(30);
export const briefSchema = z.object({
  purpose: text(4000).describe('One focused mission, grounded in the user’s request.'),
  responsibilities: list.min(1).describe('Concrete work this teammate owns; preserve the user’s exact requirements.'),
  out_of_scope: list.describe('Explicit boundaries. Do not invent permissions or unrelated responsibilities.'),
  success_criteria: list.min(1).describe('Expected deliverables and how the user will judge completion.'),
  context_summary: text(12000).describe('Self-contained relevant context from the master chat, including preferences, decisions, constraints and unresolved questions. The teammate cannot read the master’s chat.'),
  shared_resources: list.default([]).describe('Resource references, URLs, file paths and access requirements. Never include credentials or claim unverified access.'),
  handoff_notes: list.default([]).describe('Who supplies inputs, who receives outputs, when to report, and escalation rules.'),
  communication_style: z.string().trim().max(2000).default('Clear, concise and factual.').describe('Tone, preferred format, and how to explain uncertainty.'),
  working_principles: list.default(['Use evidence; distinguish facts from assumptions.', 'Stay within the agreed responsibilities.']),
  action_boundaries: z.string().trim().max(4000).default('').describe('Which actions may be taken autonomously, which need a user decision, and which are excluded. This does not override application permissions.'),
  workflows: z.array(z.object({ name: text(120), trigger: text(2000), steps: list.min(1), output: text(2000) })).max(20).default([]).describe('Specific functions: what starts each workflow, its ordered steps, and expected deliverable.'),
  open_questions: list.default([]).describe('Unresolved questions that prevent the role from being fully specified.'),
});
export type BotBrief = z.infer<typeof briefSchema>;
export interface SetupSource {
  creatorBotId?: string;
  creatorName?: string;
  generation?: number;
  messages: { seq: number; text: string }[];
  interviewMessages?: { generation: number; seq: number; text: string }[];
  sourceRefs?: SetupAnswer[];
}

export const setupSourceRefSchema = z.object({ botId: text(200), generation: z.number().int().positive(), seq: z.number().int().positive(), contentHash: z.string().regex(/^[a-f0-9]{64}$/).optional() });
export interface SetupAnswer { botId: string; generation: number; seq: number; contentHash: string; text: string }

/** Read the original record, including archived generations; never synthesize a local answer. */
export function setupAnswers(userId: string, refs: z.infer<typeof setupSourceRefSchema>[]): SetupAnswer[] {
  return refs.map(ref => {
    const row = db.prepare("SELECT r.body FROM rows r JOIN bots b ON b.id=r.bot_id WHERE b.user_id=? AND r.bot_id=? AND r.generation=? AND r.seq=? AND r.kind='message'").get(userId, ref.botId, ref.generation, ref.seq) as { body: string } | undefined;
    const body = row && JSON.parse(row.body);
    if (!body || body.type !== 'message' || body.role !== 'user' || body.streaming || typeof body.text !== 'string' || !body.text.trim() || body.audience === 'internal' || body.from && !['voice', 'imessage', 'sms', 'whatsapp'].includes(body.from.kind)) throw new Error('Setup sources must reference original human answers owned by this account.');
    const contentHash = createHash('sha256').update(body.text).digest('hex');
    // Team source reads hash the full text; existing session references hash
    // the serialized message. Validate both established reference formats.
    const bodyHash = createHash('sha256').update(row!.body).digest('hex');
    if (ref.contentHash && ref.contentHash !== contentHash && ref.contentHash !== bodyHash) throw new Error('Source message changed. Read the original answer again.');
    return { ...ref, contentHash, text: body.text };
  });
}

export const creationSchema = briefSchema.extend({
  creation_request_id: text(200).optional().describe('Stable identity for this creation request. Reuse exactly on retries, even after the coworker is renamed or edited.'),
  name: text(60).refine((v) => !/[\r\n\t]/.test(v), 'Name must be a single line'),
  label: z.string().trim().max(40).default(''),
  instructions: z.string().trim().max(8000).default(''),
  source_message_seqs: z.array(z.number().int().positive()).min(1).max(30).describe('Relevant user message numbers from the creation context in your system prompt. Include the brief and any corrections; omit unrelated messages.'),
  handoff_message: z.string().trim().max(8000).optional(),
  mode: z.enum(['personal', 'teammate']).optional(),
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']).optional(),
  avatar_shape: z.string().optional(),
  avatar_color: z.string().optional(),
});

export const setupDirectory = (botId: string) => path.join(path.dirname(env.dbPath), 'bot-setups', botId);

export function getSetup(botId: string) {
  const row = db.prepare('SELECT * FROM bot_setups WHERE bot_id=?').get(botId) as any;
  if (!row) return null;
  return { brief: briefSchema.parse(JSON.parse(row.brief)), source: JSON.parse(row.source) as SetupSource,
    onboarding: { status: row.onboarding_status as 'interviewing' | 'review' | 'active', revision: row.revision as number, confirmedAt: row.confirmed_at as number | null },
    computer: { status: row.computer_status as 'pending' | 'ready', error: row.computer_error as string | null }, updatedAt: row.updated_at as number };
}

const bullets = (items: string[], fallback = 'None specified.') => items.length ? items.map((s) => `- ${s}`).join('\n') : fallback;

/** The same charter is loaded on EVERY turn and exported as AGENTS.md. No chat-history dependency. */
export function agentsMarkdown(botId: string) {
  const b = getBotRow(botId);
  const setup = getSetup(botId);
  if (!b || !setup) return '';
  const s = setup.brief;
  return `# ${b.name}${b.label ? ` — ${b.label}` : ''}

## Mission
${s.purpose}

## Responsibilities
${bullets(s.responsibilities)}

## Out of scope
${bullets(s.out_of_scope)}
Stay within this mission. Route unrelated work to the current primary Bot; ask for clarification if the user’s requirements conflict.

## Success criteria
${bullets(s.success_criteria)}

## Context from the user’s brief
${s.context_summary}

## Shared resources
${bullets(s.shared_resources)}
These are references and access requirements, not a claim that access is connected. Browser logins are separate per Bot. Do not copy credentials or other Bots’ browser profiles.

## Handoffs
${bullets(s.handoff_notes, 'Accept assignments from the user or the current primary Bot. Report results and blockers to the assigning Bot with send_to_bot.')}
Include completed work, evidence or file references, blockers, and the next owner. Do not broaden the assignment during a handoff.

## Standing instructions
${b.instructions || 'Follow the user’s brief above.'}

## Action boundaries
${s.action_boundaries || 'Not yet specified. Clarify during setup.'}
These are the agreed working rules; application permissions and tool approval policies still apply.

## Working style (SOUL.md)
${soulMarkdown(s)}

## Workflows
${workflowMarkdown(s)}

## Open questions
${bullets(s.open_questions, 'None recorded.')}

## Working environment
You have your own durable identity, chat, memory, tasks, Library, and browser profile. All Bots for this user share a computer; use only your assigned browser/screen. The active computer provider determines whether a shell is available. Computer setup may be pending; report tool errors accurately.
The setup bundle reproduces your role and configuration with a new identity and a fresh browser. It does not copy credentials, browser sessions, live tasks, schedules, or conversation history.
`;
}

function soulMarkdown(s: BotBrief) {
  return `${s.communication_style}\n\n${bullets(s.working_principles)}\n\nWorking style never expands the agent’s mission or permissions.`;
}

function workflowMarkdown(s: BotBrief) {
  return s.workflows.map((w) => `### ${w.name}\nTrigger: ${w.trigger}\n\n${w.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n\nExpected output: ${w.output}`).join('\n\n') || 'Workflows will be defined with the user during setup.';
}

export function setupManifest(botId: string) {
  const b = getBotRow(botId);
  const s = getSetup(botId);
  if (!b || !s) return null;
  return { format: 'swarm.bot-setup', version: 2, brief: s.brief, source: s.source,
    bot: { name: b.name, label: b.label, description: b.description, instructions: b.instructions,
      avatarShape: b.avatar_shape, avatarColor: b.avatar_color, mode: b.mode, effort: b.effort, model: b.model ?? null,
      voice: b.voice, voiceSpeed: b.voice_speed, voiceLanguage: b.voice_language } };
}

export function setupFiles(botId: string): Record<string, string> {
  const manifest = setupManifest(botId);
  if (!manifest) return {};
  const { bot: b, brief: s, source } = manifest;
  return {
    'AGENTS.md': agentsMarkdown(botId),
    'IDENTITY.md': `# ${b.name}\n\nRole: ${b.label}\n\n${s.purpose}\n`,
    'SOUL.md': `# Working style\n\n${soulMarkdown(s)}\n`,
    'WORKFLOWS.md': `# Workflows\n\n${workflowMarkdown(s)}\n`,
    'CONTEXT.md': `# Context\n\n${s.context_summary}\n\n## Selected user messages\n${source.messages.map((m) => `### Message ${m.seq}\n${m.text}`).join('\n\n') || 'Created from a supplied specification.'}\n\n## Setup interview\n${(source.interviewMessages ?? []).map((m) => `### Conversation ${m.generation}, message ${m.seq}\n${m.text}`).join('\n\n')}\n\n## Original setup answers\n${(source.sourceRefs ?? []).map(m => `### Bot ${m.botId}, conversation ${m.generation}, message ${m.seq}\nHash: ${m.contentHash}\n\n${m.text}`).join('\n\n')}\n`,
    'RESOURCES.md': `# Shared resources\n\n${bullets(s.shared_resources)}\n`,
    'HANDOFFS.md': `# Handoffs\n\n${bullets(s.handoff_notes, 'Report results and blockers to the assigning Bot using send_to_bot.')}\n`,
    'bot-setup.json': JSON.stringify(manifest, null, 2) + '\n',
  };
}

export function writeSetupFiles(botId: string) {
  const dir = setupDirectory(botId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(setupFiles(botId))) {
    fs.writeFileSync(path.join(dir, `${name}.tmp`), body, 'utf8');
    fs.renameSync(path.join(dir, `${name}.tmp`), path.join(dir, name));
  }
}

export function saveSetup(botId: string, brief: z.input<typeof briefSchema>, source: SetupSource, status = 'active') {
  db.prepare('INSERT INTO bot_setups(bot_id,brief,source,onboarding_status,updated_at) VALUES (?,?,?,?,?)').run(botId, JSON.stringify(briefSchema.parse(brief)), JSON.stringify(source), status, now());
  writeSetupFiles(botId);
}

export function setupMissing(brief: BotBrief) {
  const missing: string[] = [];
  if (!brief.workflows.length) missing.push('A concrete workflow with its trigger, steps and output');
  if (!brief.action_boundaries) missing.push('Autonomous actions and decisions reserved for the user');
  if (brief.open_questions.length) missing.push(...brief.open_questions);
  return missing;
}

export function setupView(botId: string) {
  const s = getSetup(botId);
  if (!s) return null;
  return { manifest: setupManifest(botId)!, computer: s.computer, onboarding: { ...s.onboarding, missing: setupMissing(s.brief) }, files: setupFiles(botId) };
}

export const isConfiguring = (botId: string) => {
  const setup = getSetup(botId);
  return !!setup && setup.onboarding.status !== 'active';
};

export function emitSetup(botId: string) {
  const b = getBotRow(botId);
  if (b) hub.emit(b.user_id, { type: 'setup', botId });
}

/** Start a visible interview immediately, even without a configured model key. */
export function beginSetupInterview(botId: string) {
  const b = getBotRow(botId);
  if (!b || b.kind === 'room') throw new Error('No agent found.');
  if (!getSetup(botId)) saveSetup(botId, {
    purpose: b.description || b.label || 'Define the agent’s responsibilities with the user.',
    responsibilities: [b.description || 'Define the work this agent should own.'], out_of_scope: [],
    success_criteria: ['Deliver the outcome agreed with the user.'], context_summary: b.instructions || 'No detailed brief has been supplied yet.',
  }, { messages: [] });
  db.prepare("UPDATE bot_setups SET onboarding_status='interviewing', revision=revision+1, confirmed_at=NULL, updated_at=? WHERE bot_id=?").run(now(), botId);
  const s = getSetup(botId)!;
  const questions = [
    !s.brief.workflows.length ? 'Walk me through one typical input and the exact result or action you want from me.' : '',
    !s.brief.action_boundaries ? 'Which actions should I handle on my own, and which decisions should I bring to you?' : '',
  ].filter(Boolean).slice(0, 2);
  const hasBrief = !!b.description.trim() || s.source.messages.length > 0 || !!s.source.interviewMessages?.length;
  const text = hasBrief
    ? `I’ll help you configure ${b.name}. My starting brief is: ${s.brief.purpose}\n\n${questions.length ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n') : 'The job, workflow and action limits are already defined. Is anything missing, or should I prepare this setup for your review?'}\n\nYour saved role is visible in Configuration on the right.`
    : `What job would you like ${b.name} to handle? Give me one example of what you’d provide and the result you’d want back.\n\nI’ll ask about any important gaps and save the role in Configuration on the right.`;
  appendRow(botId, 'message', { type: 'message', role: 'assistant', text });
  appendHistory(botId, [{ role: 'assistant', content: text }]);
  writeSetupFiles(botId);
  emitSetup(botId);
}

export const setupDraftSchema = briefSchema.extend({
  revision: z.number().int().positive().describe('Current setup revision shown in the system prompt; prevents overwriting newer changes.'),
  stage: z.enum(['interviewing', 'review']),
  instructions: z.string().max(8000),
  source_message_seqs: z.array(z.number().int().positive()).max(30).describe('User answers from this agent’s current conversation; [] only when all details came from the inherited brief.'),
});

export function saveSetupDraft(botId: string, userId: string, input: unknown) {
  const b = getBotRow(botId);
  const prior = getSetup(botId);
  if (!b || b.user_id !== userId || !prior || !isConfiguring(botId)) throw new Error('Start or resume the setup interview before editing the specification.');
  const a = setupDraftSchema.parse(input);
  const brief = briefSchema.parse(a);
  const missing = setupMissing(brief);
  if (a.stage === 'review' && missing.length) throw new Error(`Finish the brief before requesting review: ${missing.join('; ')}`);
  const answers = a.source_message_seqs.map((seq) => {
    const m = creationContext(botId).find((m) => m.seq === seq);
    if (!m) throw new Error(`Message ${seq} is not a user answer in this conversation.`);
    return { ...m, generation: b.generation };
  });
  const evidence = new Map((prior.source.interviewMessages ?? []).map((m) => [`${m.generation}:${m.seq}`, m]));
  for (const m of answers) evidence.set(`${m.generation}:${m.seq}`, m);
  const source = { ...prior.source, interviewMessages: [...evidence.values()] };
  db.transaction(() => {
    const result = db.prepare('UPDATE bot_setups SET brief=?, source=?, onboarding_status=?, revision=revision+1, confirmed_at=NULL, updated_at=? WHERE bot_id=? AND revision=?').run(JSON.stringify(brief), JSON.stringify(source), a.stage, now(), botId, a.revision);
    if (!result.changes) throw new Error('The configuration changed. Read the latest revision and retry.');
    db.prepare('UPDATE bots SET instructions=?, description=?, updated_at=? WHERE id=?').run(a.instructions, brief.purpose.slice(0, 300), now(), botId);
    publishNativeEvent({ userId, botId, kind: 'setup.prepared', sourceType: 'setup', sourceId: botId, sourceRevision: a.revision + 1, data: { stage: a.stage } });
    writeSetupFiles(botId);
  })();
  emitSetup(botId);
  return setupView(botId)!;
}

export function assertSetupCoordinator(userId: string, coordinatorId: string) {
  assertLegacyWorkOpen(userId);
  const b = getBotRow(coordinatorId);
  const primaries = db.prepare('SELECT id FROM bots WHERE user_id=? AND is_primary=1').all(userId) as { id: string }[];
  if (!b || b.user_id !== userId || !b.is_primary || b.hidden || b.parent_bot_id || b.kind === 'room' || primaries.length !== 1 || primaries[0].id !== coordinatorId) throw new Error('Only this user’s current primary Bot can prepare teammate setup.');
  return b;
}

export function coworkerSetup(userId: string, coordinatorId: string, botId: string) {
  assertSetupCoordinator(userId, coordinatorId);
  const b = getBotRow(botId);
  if (!b || b.user_id !== userId || b.id === coordinatorId || b.is_primary || b.hidden || b.parent_bot_id || b.kind === 'room') throw new Error('Coworker setup not found.');
  const setup = setupView(botId);
  if (!setup) throw new Error('Coworker setup not found.');
  return { botId, ...setup };
}

export function coworkerSetups(userId: string, coordinatorId: string) {
  assertSetupCoordinator(userId, coordinatorId);
  const bots = db.prepare("SELECT b.id FROM bots b JOIN bot_setups s ON s.bot_id=b.id WHERE b.user_id=? AND b.is_primary=0 AND COALESCE(b.hidden,0)=0 AND b.parent_bot_id IS NULL AND COALESCE(b.kind,'agent')!='room' AND s.onboarding_status!='active' ORDER BY s.updated_at DESC,b.id").all(userId) as { id: string }[];
  return bots.map(b => coworkerSetup(userId, coordinatorId, b.id));
}

export const centralSetupDraftSchema = briefSchema.extend({
  bot_id: text(200), revision: z.number().int().positive(), stage: z.enum(['interviewing', 'review']), instructions: z.string().max(8000),
  source_refs: z.array(setupSourceRefSchema).min(1).max(30).describe('Original human answers, including Quinn’s conversation. Use stable botId, generation and seq; never copy them into the specialist chat.'),
}).strict();

export function prepareCoworkerSetup(userId: string, coordinatorId: string, input: unknown) {
  const a = centralSetupDraftSchema.parse(input);
  return db.transaction(() => {
    const view = coworkerSetup(userId, coordinatorId, a.bot_id);
    const pendingCard = db.prepare("SELECT 1 FROM rows r JOIN bots b ON b.id=r.bot_id AND b.generation=r.generation WHERE r.bot_id=? AND r.kind='card' AND json_extract(r.body,'$.card') IN ('question','approval','connect') AND json_extract(r.body,'$.status')='pending' LIMIT 1").get(a.bot_id);
    if (pendingCard || db.prepare('SELECT 1 FROM pending_turns WHERE bot_id=?').get(a.bot_id) || db.prepare("SELECT 1 FROM approvals WHERE bot_id=? AND status='pending'").get(a.bot_id)) throw new Error('Resolve the coworker’s pending decision before changing its setup.');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_jobs'").get() && db.prepare("SELECT 1 FROM agent_jobs WHERE bot_id=? AND state IN ('queued','running')").get(a.bot_id)) throw new Error('Wait for the coworker’s current work before changing its setup.');
    const prior = getSetup(a.bot_id)!;
    if (view.onboarding.revision !== a.revision) throw new Error('The configuration changed. Read the latest revision and retry.');
    const answers = setupAnswers(userId, a.source_refs);
    const evidence = new Map((prior.source.sourceRefs ?? []).map(m => [`${m.botId}:${m.generation}:${m.seq}`, m]));
    for (const m of answers) evidence.set(`${m.botId}:${m.generation}:${m.seq}`, m);
    const brief = briefSchema.parse(a);
    if (a.stage === 'review' && setupMissing(brief).length) throw new Error(`Finish the brief before requesting review: ${setupMissing(brief).join('; ')}`);
    const source = { ...prior.source, sourceRefs: [...evidence.values()] };
    const changed = db.prepare('UPDATE bot_setups SET brief=?,source=?,onboarding_status=?,revision=revision+1,confirmed_at=NULL,updated_at=? WHERE bot_id=? AND revision=?').run(JSON.stringify(brief), JSON.stringify(source), a.stage, now(), a.bot_id, a.revision);
    if (!changed.changes) throw new Error('The configuration changed. Read the latest revision and retry.');
    db.prepare('UPDATE bots SET instructions=?,description=?,updated_at=? WHERE id=? AND user_id=?').run(a.instructions, brief.purpose.slice(0, 300), now(), a.bot_id, userId);
    publishNativeEvent({ userId, botId: a.bot_id, kind: 'setup.prepared', sourceType: 'setup', sourceId: a.bot_id, sourceRevision: a.revision + 1, data: { coordinatorId, stage: a.stage, sourceRefs: answers.map(({ text, ...ref }) => ref) } });
    writeSetupFiles(a.bot_id);
    emitSetup(a.bot_id);
    return coworkerSetup(userId, coordinatorId, a.bot_id);
  })();
}

export function activateSetup(botId: string, revision: number) {
  return db.transaction(() => {
    const b = getBotRow(botId);
    if (!b) throw new Error('Agent not found.');
    assertLegacyWorkOpen(b.user_id);
    const s = getSetup(botId);
    if (!s || s.onboarding.status !== 'review') throw new Error('Finish the setup interview before activating this agent.');
    if (setupMissing(s.brief).length) throw new Error('The specification has unresolved questions.');
    const result = db.prepare("UPDATE bot_setups SET onboarding_status='active', confirmed_at=?, revision=revision+1, updated_at=? WHERE bot_id=? AND revision=? AND onboarding_status='review'").run(now(), now(), botId, revision);
    if (!result.changes) throw new Error('The specification changed. Review the latest version before activating.');
    const pending = db.prepare('SELECT pending_handoff FROM bot_setups WHERE bot_id=?').get(botId) as { pending_handoff: string | null };
    publishNativeEvent({ userId: b.user_id, botId, kind: 'setup.activated', sourceType: 'setup', sourceId: botId, sourceRevision: revision + 1, audience: 'user', data: { approvedRevision: revision } });
    const text = 'Your setup is confirmed. I’ll follow the agreed responsibilities, workflows and working style.';
    appendRow(botId, 'message', { type: 'message', role: 'assistant', text });
    appendHistory(botId, [{ role: 'assistant', content: text }]);
    emitSetup(botId);
    // Provisioning can finish later. Keep the original assignment until one
    // durable job and its receipt commit together. Legacy callers may inspect it.
    try { releaseSetupHandoff(botId); } catch { /* Human activation remains committed; retry durable admission when capacity returns. */ }
    return s.computer.status === 'ready' ? pending.pending_handoff : null;
  })();
}

export function removeSetupFiles(botId: string) {
  fs.rmSync(setupDirectory(botId), { recursive: true, force: true });
}

/** Only actual user messages (typed, spoken on a call, or texted) can be cited as the creation brief. */
export function creationContext(botId: string) {
  const b = getBotRow(botId);
  if (!b) return [];
  const rows = db.prepare("SELECT seq,body FROM rows WHERE bot_id=? AND generation=? AND kind='message' AND json_extract(body,'$.role')='user' AND COALESCE(json_extract(body,'$.audience'),'user')!='internal' AND COALESCE(json_extract(body,'$.streaming'),0)=0 AND (json_extract(body,'$.from.kind') IS NULL OR json_extract(body,'$.from.kind') IN ('voice','imessage','sms','whatsapp')) ORDER BY seq DESC LIMIT 100").all(botId, b.generation) as { seq: number; body: string }[];
  return rows.flatMap((r) => {
    const m = JSON.parse(r.body);
    return m.role === 'user' && (!m.from || m.from.kind === 'voice' || m.from.kind === 'imessage' || m.from.kind === 'sms' || m.from.kind === 'whatsapp') ? [{ seq: r.seq, text: String(m.text) }] : [];
  });
}

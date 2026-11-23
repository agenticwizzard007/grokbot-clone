import { z } from 'zod';
import { createHash } from 'node:crypto';
import { createBot, resolveBotTarget, visibleAgentByName, type BotTarget } from '../bots.js';
import {
  beginSetupInterview, creationContext, creationSchema, emitSetup, getSetup, setupFiles, setupManifest,
  briefSchema, writeSetupFiles, setupAnswers, setupMissing, setupView, assertSetupCoordinator,
  coworkerSetup, centralSetupDraftSchema, prepareCoworkerSetup, releaseSetupHandoff, type SetupSource,
} from '../bot-setup.js';
import { reserveScreen } from '../computers/orgo-box.js';
import { db, now } from '../db.js';
import { appendRow, getBot, getBotRow } from '../store.js';
import { publishNativeEvent } from '../native/events.js';
import type { ToolDef, ToolCtx, ToolResult } from './tools.js';
import { redactInternalIds } from '../lib/redact.js';

const primary = (ctx: ToolCtx) => assertSetupCoordinator(ctx.userId, ctx.botId);

// Request identities survive renames, setup changes and deletion. A deleted
// coworker is a tombstone, never a reason to silently repeat creation.
db.exec(`CREATE TABLE IF NOT EXISTS coworker_creation_requests (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL,
 created_at INTEGER NOT NULL, PRIMARY KEY(user_id,request_id)
)`);

export const CENTRAL_SETUP_TOOLS: ToolDef[] = [
  {
    name: 'inspect_teammate_setup', description: 'Inspect a permanent coworker’s saved configuration, revision, unresolved decisions and original setup sources from the primary conversation. Does not start work or restart interviews.',
    parameters: { type: 'object', properties: { bot_id: { type: 'string' } }, required: ['bot_id'], additionalProperties: false },
    activity: 'working', label: 'Reading coworker setup',
    impl: async (a, ctx) => ({ output: JSON.stringify(coworkerSetup(ctx.userId, ctx.botId, a.bot_id)) }),
  },
  {
    name: 'prepare_teammate_setup', description: 'Prepare or revise a permanent coworker centrally from original human answers, including the primary conversation. Preserve unresolved decisions as open_questions; ask only material missing questions in the primary chat. Use the current revision. A complete draft can enter review, but only the human can activate its exact revision using the conversation review card. Does not grant app permissions or run the coworker.',
    parameters: (() => { const { $schema, ...schema } = z.toJSONSchema(centralSetupDraftSchema, { io: 'input' }); return schema; })(),
    activity: 'working', label: 'Preparing coworker setup',
    impl: async (a, ctx) => ({ output: JSON.stringify(prepareCoworkerSetup(ctx.userId, ctx.botId, a)), summary: 'Coworker configuration prepared for human review' }),
  },
];

/** A saved teammate survives computer failures; retry provisioning on the same id. */
const provisioning = new Map<string, Promise<{ status: 'ready' | 'pending'; error: string | null }>>();
export function provisionTeammate(userId: string, botId: string) {
  const bot = getBotRow(botId);
  if (!bot || bot.user_id !== userId || !getSetup(botId)) throw new Error('Bot setup not found.');
  const running = provisioning.get(botId);
  if (running) return running;
  const job = (async () => {
    // Providers depend on the runtime idle watcher. Load them after tool
    // definitions initialize so importing this module cannot cycle through tools.
    const { computers } = await import('../computers/index.js');
    const release = reserveScreen(botId);
    try {
      writeSetupFiles(botId);
      // Canonical files also remain on the app server and downloadable if this computer is offline.
      if (computers.kind === 'orgo') for (const [name, content] of Object.entries(setupFiles(botId))) await computers.files.save(userId, botId, name, content);
      const screen = await computers.screen(userId, botId);
      // A local screenshot starts this Bot's Chrome; Orgo also needs its dedicated browser launched.
      if (computers.kind === 'orgo' && getSetup(botId)?.computer.status !== 'ready') await screen.openUrl('about:blank');
      await screen.screenshot();
      db.prepare("UPDATE bot_setups SET computer_status='ready', computer_error=NULL, updated_at=? WHERE bot_id=?").run(now(), botId);
      try { releaseSetupHandoff(botId); } catch { /* Assignment remains pending until durable admission succeeds. */ }
      return { status: 'ready' as const, error: null };
    } catch (e: any) {
      const error = String(e?.message ?? e).slice(0, 1000);
      db.prepare("UPDATE bot_setups SET computer_status='pending', computer_error=?, updated_at=? WHERE bot_id=?").run(error, now(), botId);
      return { status: 'pending' as const, error };
    } finally { release(); emitSetup(botId); }
  })();
  provisioning.set(botId, job);
  void job.finally(() => provisioning.delete(botId)).catch(() => {});
  return job;
}

export async function createTeammate(raw: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const actor = primary(ctx);
  const a = creationSchema.parse(raw);
  a.name = a.name.replace(/\s+/g, ' ');
  a.source_message_seqs = [...new Set(a.source_message_seqs)].sort((left, right) => left - right);
  // Briefs are redacted by their schema; standing instructions never keep internal ids either (R2F-002).
  a.instructions = redactInternalIds(a.instructions);
  const brief = briefSchema.parse(a);
  const fingerprint = createHash('sha256').update(JSON.stringify(a)).digest('hex');
  const result = db.transaction(() => {
    if (a.creation_request_id) {
      const prior = db.prepare('SELECT * FROM coworker_creation_requests WHERE user_id=? AND request_id=?').get(ctx.userId, a.creation_request_id) as any;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('This creation request ID was already used with different parameters. Use a new request ID for a different coworker.');
        const saved = prior.bot_id && getBotRow(prior.bot_id);
        if (!saved || saved.user_id !== ctx.userId || saved.hidden || saved.parent_bot_id || saved.kind === 'room') throw new Error('The coworker created by this request is no longer available.');
        return { bot: getBot(saved.id)!, alreadyCreated: true };
      }
    }
    const context = creationContext(ctx.botId);
    const messages = [...new Set(a.source_message_seqs)].sort((a, b) => a - b).map(seq => {
      const m = context.find(m => m.seq === seq);
      if (!m) throw new Error(`Message ${seq} is not a user message in the current master chat. Use the message numbers in your creation context.`);
      return m;
    });
    const source: SetupSource = { creatorBotId: ctx.botId, creatorName: actor.name, generation: actor.generation, messages,
      sourceRefs: setupAnswers(ctx.userId, messages.map(m => ({ botId: actor.id, generation: actor.generation, seq: m.seq }))) };
    let bot = visibleAgentByName(ctx.userId, a.name);
    const alreadyCreated = !!bot;
    if (bot) {
      const existing = getSetup(bot.id);
      if (!existing || existing.source.creatorBotId !== actor.id || JSON.stringify(existing.brief) !== JSON.stringify(brief) || bot.instructions !== a.instructions) throw new Error(`A Bot named "${a.name}" already exists. Hand work to it or use a different name; no changes were made.`);
    } else {
      bot = createBot(ctx.userId, { name: a.name, label: a.label, description: a.purpose, instructions: a.instructions, brief, source,
        avatarShape: a.avatar_shape, avatarColor: a.avatar_color, mode: a.mode ?? actor.mode, effort: a.effort ?? actor.effort, model: actor.model });
      const stage = setupMissing(brief).length ? 'interviewing' : 'review';
      db.prepare('UPDATE bot_setups SET onboarding_status=?,pending_handoff=? WHERE bot_id=?').run(stage, a.handoff_message?.trim() || null, bot.id);
      appendRow(bot.id, 'event', { type: 'event', event: 'bot-message', text: `${actor.name} prepared this coworker. Review and activate its configuration in ${actor.name}’s conversation, or continue setup here.` });
      publishNativeEvent({ userId: ctx.userId, botId: bot.id, kind: 'setup.prepared', sourceType: 'setup', sourceId: bot.id, sourceRevision: 1, data: { coordinatorId: actor.id, stage, creationRequestId: a.creation_request_id ?? null } });
    }
    if (a.creation_request_id) db.prepare('INSERT INTO coworker_creation_requests(user_id,request_id,fingerprint,bot_id,created_at) VALUES(?,?,?,?,?)').run(ctx.userId, a.creation_request_id, fingerprint, bot.id, now());
    return { bot: getBot(bot.id)!, alreadyCreated };
  })();
  const { bot, alreadyCreated } = result;
  const computer = await provisionTeammate(ctx.userId, bot.id);
  const setup = setupView(bot.id)!;
  return { output: JSON.stringify({ ok: true, already_created: alreadyCreated, bot,
    purpose: setup.manifest.brief.purpose, responsibilities: setup.manifest.brief.responsibilities, setup: `/api/bots/${bot.id}/setup`, files: Object.keys(setup.files), computer,
    onboarding: setup.onboarding.status, revision: setup.onboarding.revision, missing: setup.onboarding.missing, handoff_sent: false, handoff_deferred: !!a.handoff_message,
    note: `Continue preparation here in the primary conversation using inspect_teammate_setup and prepare_teammate_setup. Ask the user only material missing decisions; cite their original messages. The user can review and activate the exact revision in this conversation. ${computer.status === 'ready' ? 'Its separate browser is ready.' : 'Computer setup is pending; retry_bot_setup reuses this coworker.'}` }), summary: `${alreadyCreated ? 'Reused' : 'Prepared'} ${bot.name} · ${setup.onboarding.status}` };
}

export const manifestSchema = z.object({
  format: z.enum(['swarm.bot-setup', 'grokbot.bot-setup']), version: z.union([z.literal(1), z.literal(2)]), brief: briefSchema,
  bot: z.object({
    name: z.string().trim().min(1).max(60), label: z.string().max(40), description: z.string().max(300), instructions: z.string().max(8000),
    avatarShape: z.string(), avatarColor: z.string(), mode: z.enum(['personal', 'teammate']), effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']),
    model: z.string().max(120).nullable(), voice: z.string().max(40), voiceSpeed: z.number().min(0.7).max(1.5), voiceLanguage: z.string().max(40),
  }),
  source: z.object({ creatorBotId: z.string().optional(), creatorName: z.string().optional(), generation: z.number().optional(), messages: z.array(z.object({ seq: z.number(), text: z.string() })).max(30), interviewMessages: z.array(z.object({ generation: z.number(), seq: z.number(), text: z.string() })).optional() }),
});

export async function importTeammate(userId: string, manifest: unknown, name?: string) {
  const m = manifestSchema.parse(manifest);
  const newName = z.string().trim().min(1).max(60).parse(name ?? m.bot.name);
  if (visibleAgentByName(userId, newName)) throw new Error(`A Bot named "${newName}" already exists. Choose a new name for the replica.`);
  // Imported source IDs are portable context, never authenticated local answers.
  const bot = createBot(userId, { ...m.bot, name: newName, brief: m.brief, source: { ...m.source, sourceRefs: [] } });
  db.prepare('UPDATE bots SET voice=?, voice_speed=?, voice_language=? WHERE id=?').run(m.bot.voice, m.bot.voiceSpeed, m.bot.voiceLanguage, bot.id);
  beginSetupInterview(bot.id);
  return { bot: getBot(bot.id), computer: await provisionTeammate(userId, bot.id) };
}

export async function replicateTeammate(a: BotTarget & { new_name: string }, ctx: ToolCtx): Promise<ToolResult> {
  primary(ctx);
  const bot = resolveBotTarget(ctx.userId, a);
  const manifest = bot && setupManifest(bot.id);
  if (!manifest) throw new Error('No saved setup found for that teammate. Create one from its brief with create_bot.');
  const result = await importTeammate(ctx.userId, manifest, a.new_name);
  return { output: JSON.stringify({ ok: true, ...result, note: 'Role and setup replicated. Browser sessions, live tasks, schedules, and chat history are not copied.' }), summary: `Replicated ${bot.name} as ${result.bot!.name}` };
}

export async function retryTeammate(a: BotTarget, ctx: ToolCtx): Promise<ToolResult> {
  primary(ctx);
  const bot = resolveBotTarget(ctx.userId, a);
  if (!bot) throw new Error('No such teammate.');
  return { output: JSON.stringify({ bot_id: bot.id, computer: await provisionTeammate(ctx.userId, bot.id) }) };
}

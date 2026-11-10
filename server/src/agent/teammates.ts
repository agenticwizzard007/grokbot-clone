import { z } from 'zod';
import { createBot, visibleAgentByName } from '../bots.js';
import { beginSetupInterview, creationContext, creationSchema, emitSetup, getSetup, setupFiles, setupManifest, briefSchema, writeSetupFiles, type SetupSource } from '../bot-setup.js';
import { computers } from '../computers/index.js';
import { reserveScreen } from '../computers/orgo-box.js';
import { db, now } from '../db.js';
import { appendRow, getBot, getBotRow } from '../store.js';
import type { ToolCtx, ToolResult } from './tools.js';

function primary(ctx: ToolCtx) {
  const b = getBotRow(ctx.botId);
  if (!b || b.user_id !== ctx.userId || !b.is_primary || b.hidden || b.kind === 'room') {
    throw new Error('Only this user’s current primary Bot can create or replicate teammates. Send the brief to the primary Bot.');
  }
  return b;
}

/** A saved teammate survives computer failures; retry provisioning on the same id. */
const provisioning = new Map<string, Promise<{ status: 'ready' | 'pending'; error: string | null }>>();
export function provisionTeammate(userId: string, botId: string) {
  const bot = getBotRow(botId);
  if (!bot || bot.user_id !== userId || !getSetup(botId)) throw new Error('Bot setup not found.');
  const running = provisioning.get(botId);
  if (running) return running;
  const job = (async () => {
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
  const brief = briefSchema.parse(a);
  const context = creationContext(ctx.botId);
  const messages = [...new Set(a.source_message_seqs)].sort((a, b) => a - b).map((seq) => {
    const m = context.find((m) => m.seq === seq);
    if (!m) throw new Error(`Message ${seq} is not a user message in the current master chat. Use the message numbers in your creation context.`);
    return m;
  });
  const source: SetupSource = { creatorBotId: ctx.botId, creatorName: actor.name, generation: actor.generation, messages };
  let bot = visibleAgentByName(ctx.userId, a.name);
  if (bot) {
    const existing = getSetup(bot.id);
    if (!existing || existing.source.creatorBotId !== actor.id || JSON.stringify(existing.brief) !== JSON.stringify(brief) || bot.instructions !== a.instructions) {
      throw new Error(`A Bot named "${a.name}" already exists. Hand work to it or use a different name; no changes were made.`);
    }
    // An identical retried call reuses the original teammate instead of creating a duplicate.
    return { output: JSON.stringify({ ok: true, already_created: true, bot: getBot(bot.id), setup: `/api/bots/${bot.id}/setup`, computer: await provisionTeammate(ctx.userId, bot.id), handoff_sent: false }), summary: `${bot.name} already exists` };
  }
  const created = createBot(ctx.userId, { name: a.name, label: a.label, description: a.purpose, instructions: a.instructions, brief, source,
    avatarShape: a.avatar_shape, avatarColor: a.avatar_color, mode: a.mode ?? actor.mode, effort: a.effort ?? actor.effort, model: actor.model });
  appendRow(created.id, 'event', { type: 'event', event: 'bot-message', text: `${actor.name} created this teammate. Its setup consultant will help you define and review the role in this chat.` });
  const handoff = a.handoff_message?.trim();
  if (handoff) db.prepare('UPDATE bot_setups SET pending_handoff=? WHERE bot_id=?').run(handoff, created.id);
  beginSetupInterview(created.id);
  const computer = await provisionTeammate(ctx.userId, created.id);
  return { output: JSON.stringify({ ok: true, bot: { id: created.id, name: created.name, label: created.label },
    purpose: brief.purpose, responsibilities: brief.responsibilities, setup: `/api/bots/${created.id}/setup`, files: Object.keys(setupFiles(created.id)), computer,
    onboarding: 'interviewing', handoff_sent: false, handoff_deferred: !!handoff,
    note: `The teammate is created and its setup interview has started in its own chat. Direct the user there to define missing functionality and review the Configuration tab before activation. ${computer.status === 'ready' ? 'Its separate browser is ready.' : 'Computer setup is pending; retry_bot_setup can finish it after reconnecting.'}` }), summary: `Created ${created.name} · setup interview started` };
}

export const manifestSchema = z.object({
  format: z.literal('grokbot.bot-setup'), version: z.union([z.literal(1), z.literal(2)]), brief: briefSchema,
  bot: z.object({
    name: z.string().trim().min(1).max(60), label: z.string().max(40), description: z.string().max(300), instructions: z.string().max(8000),
    avatarShape: z.string(), avatarColor: z.string(), mode: z.enum(['personal', 'teammate']), effort: z.enum(['low', 'medium', 'high', 'xhigh']),
    model: z.string().max(120).nullable(), voice: z.string().max(40), voiceSpeed: z.number().min(0.7).max(1.5), voiceLanguage: z.string().max(40),
  }),
  source: z.object({ creatorBotId: z.string().optional(), creatorName: z.string().optional(), generation: z.number().optional(), messages: z.array(z.object({ seq: z.number(), text: z.string() })).max(30), interviewMessages: z.array(z.object({ generation: z.number(), seq: z.number(), text: z.string() })).optional() }),
});

export async function importTeammate(userId: string, manifest: unknown, name?: string) {
  const m = manifestSchema.parse(manifest);
  const newName = z.string().trim().min(1).max(60).parse(name ?? m.bot.name);
  if (visibleAgentByName(userId, newName)) throw new Error(`A Bot named "${newName}" already exists. Choose a new name for the replica.`);
  const bot = createBot(userId, { ...m.bot, name: newName, brief: m.brief, source: m.source });
  db.prepare('UPDATE bots SET voice=?, voice_speed=?, voice_language=? WHERE id=?').run(m.bot.voice, m.bot.voiceSpeed, m.bot.voiceLanguage, bot.id);
  beginSetupInterview(bot.id);
  return { bot: getBot(bot.id), computer: await provisionTeammate(userId, bot.id) };
}

export async function replicateTeammate(a: { bot_name: string; new_name: string }, ctx: ToolCtx): Promise<ToolResult> {
  primary(ctx);
  const bot = visibleAgentByName(ctx.userId, a.bot_name);
  const manifest = bot && setupManifest(bot.id);
  if (!manifest) throw new Error('No saved setup found for that teammate. Create one from its brief with create_bot.');
  const result = await importTeammate(ctx.userId, manifest, a.new_name);
  return { output: JSON.stringify({ ok: true, ...result, note: 'Role and setup replicated. Browser sessions, live tasks, schedules, and chat history are not copied.' }), summary: `Replicated ${bot.name} as ${result.bot!.name}` };
}

export async function retryTeammate(a: { bot_name: string }, ctx: ToolCtx): Promise<ToolResult> {
  primary(ctx);
  const bot = visibleAgentByName(ctx.userId, a.bot_name);
  if (!bot) throw new Error('No such teammate.');
  return { output: JSON.stringify({ bot_id: bot.id, computer: await provisionTeammate(ctx.userId, bot.id) }) };
}

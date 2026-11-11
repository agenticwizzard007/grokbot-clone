import { z } from 'zod';
import { creationSchema, emitSetup, getSetup, isConfiguring, writeSetupFiles } from './bot-setup.js';
import { createTeammate } from './agent/teammates.js';
import { interrupt, turnSignal } from './agent/loop.js';
import { db, now } from './db.js';
import { assertTenant } from './deployment.js';
import { appendHistory, appendRow, emitBot, getBotRow, getLive, getRow, listRoutines, listTasks, setLive, updateRow } from './store.js';
import { EFFORTS, type MessageBody, type ToolCallBody } from './types.js';

export interface VoiceControlContext { userId: string; botId: string; callId: string }

const id = z.string().trim().min(1).max(200);
const createSchema = creationSchema.omit({ source_message_seqs: true }).extend({
  user_request: z.string().min(1).max(32000).refine(text => !!text.trim(), 'A spoken user request is required.')
    .describe('The user’s actual spoken creation request, including requirements and corrections. Saved as voice evidence in this chat; do not invent user authorization.'),
}).strict();
const updateSchema = z.object({
  bot_id: id,
  name: z.string().trim().min(1).max(60).refine(text => !/[\r\n\t]/.test(text)).optional(),
  label: z.string().trim().max(40).optional(),
  description: z.string().trim().max(300).optional(),
  // Match PATCH /bots/:id: model is an optional provider id (or null for the default).
  model: z.string().max(120).nullable().optional(),
  effort: z.enum(EFFORTS).optional(),
}).strict().refine(value => Object.keys(value).some(key => key !== 'bot_id'), 'Supply at least one field to update.');
const schemas = {
  list_agents: z.object({}).strict(),
  get_agent: z.object({ bot_id: id, message_limit: z.number().int().min(1).max(100).default(20) }).strict(),
  create_bot: createSchema,
  update_agent: updateSchema,
  control_agent: z.object({ bot_id: id, action: z.literal('stop') }).strict(),
};
type ControlName = keyof typeof schemas;

const descriptions: Record<ControlName, string> = {
  list_agents: 'List this user’s agents, including helpers, with IDs, roles, live state, tasks, model and setup status. Never returns other users or account credentials.',
  get_agent: 'Read an owned agent’s current details, recent messages, tasks, routines and setup revision by bot_id.',
  create_bot: 'Current primary agent only: create a durable teammate from a complete spoken brief. Starts its setup interview; activation requires review. Retries reuse its identity and never enqueue operational work.',
  update_agent: 'Current primary agent only: update an owned agent’s name, label, description, model or effort. Broader changes and setup activation go through text chat and Configuration.',
  control_agent: 'Stop an agent’s active turn, cancel queued work and expire paused approvals without deleting the agent. The primary may stop any owned agent; other agents may stop only themselves. Routines remain scheduled.',
};

/** Realtime function schemas; runtime validation uses these same Zod schemas. */
export const VOICE_CONTROL_TOOLS = (Object.keys(schemas) as ControlName[]).map(name => {
  const { $schema, ...parameters } = z.toJSONSchema(schemas[name], { io: 'input' });
  return { type: 'function' as const, name, description: descriptions[name], parameters };
});

const isPrimary = (bot: any) => !!bot?.is_primary && !bot.hidden && bot.kind !== 'room';

export function voiceControlTools(botId: string) {
  const bot = getBotRow(botId);
  if (!bot || bot.kind === 'room') return [];
  assertTenant(bot.user_id);
  return VOICE_CONTROL_TOOLS.filter(tool =>
    !['create_bot', 'update_agent'].includes(tool.name) || isPrimary(bot) && (tool.name !== 'create_bot' || !isConfiguring(botId)));
}

function ownedAgent(userId: string, botId: string) {
  const bot = getBotRow(botId);
  if (!bot || bot.user_id !== userId || bot.kind === 'room') throw new Error('Agent not found.');
  return bot;
}

function requirePrimary(bot: any) {
  if (!isPrimary(bot)) throw new Error('Only the current primary agent can create or update agents. Send this request to the primary agent.');
}

// Explicit projections keep raw DB rows, provider credentials, tool arguments and approval bindings out of voice results.
function agentView(bot: any) {
  const setup = getSetup(bot.id);
  return {
    id: bot.id, name: bot.name, label: bot.label, description: bot.description,
    role: bot.hidden ? 'helper' : isPrimary(bot) ? 'primary' : 'teammate',
    isPrimary: isPrimary(bot), parentBotId: bot.parent_bot_id ?? null,
    mode: bot.mode, model: bot.model ?? null, effort: bot.effort,
    live: getLive(bot.id), tasks: listTasks(bot.id).map(({ id, title, state }) => ({ id, title, state })),
    setup: setup ? { status: setup.onboarding.status, revision: setup.onboarding.revision,
      confirmedAt: setup.onboarding.confirmedAt, computerStatus: setup.computer.status } : null,
  };
}

function agentDetails(bot: any) {
  const view = agentView(bot);
  return { ...view, instructions: bot.instructions, fast: !!bot.fast,
    voice: bot.voice ?? 'luna', voiceSpeed: bot.voice_speed ?? 1, voiceLanguage: bot.voice_language ?? 'auto',
    tasks: listTasks(bot.id), setup: view.setup ? { ...view.setup, brief: getSetup(bot.id)!.brief } : null };
}

function recentMessages(bot: any, limit: number) {
  const rows = db.prepare("SELECT seq,body,created_at FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq DESC LIMIT ?")
    .all(bot.id, bot.generation, limit) as { seq: number; body: string; created_at: number }[];
  return rows.reverse().flatMap(row => {
    const body = JSON.parse(row.body) as MessageBody;
    return body.type === 'message' ? [{ seq: row.seq, role: body.role, text: body.text, createdAt: row.created_at,
      ...(body.from ? { from: { kind: body.from.kind, id: body.from.id, name: body.from.name } } : {}) }] : [];
  });
}

function stopAgent(botId: string, userId: string) {
  // beginJob only starts 'queued' jobs. Do this before yielding so already-scheduled
  // promises cannot restart work after interrupt aborts the active turn.
  const active = !!turnSignal(botId);
  const cancelled = db.prepare("UPDATE agent_jobs SET state='cancelled',finished_at=? WHERE bot_id=? AND user_id=? AND (state='queued' OR (?=1 AND state='running'))")
    .run(now(), botId, userId, active ? 1 : 0).changes;
  interrupt(botId);
  // Paused runs have already ended, but their question/approval still represents unfinished
  // work. Cancel that assignment too, and make old question cards non-resumable.
  const decisions = db.prepare("SELECT seq,body FROM rows WHERE bot_id=? AND generation=? AND kind='card' AND json_extract(body,'$.card') IN ('question','approval','connect') AND json_extract(body,'$.status')='pending'")
    .all(botId, getBotRow(botId).generation) as { seq: number; body: string }[];
  for (const decision of decisions) {
    const card = JSON.parse(decision.body);
    if (typeof card.jobId === 'string') db.prepare("UPDATE agent_jobs SET state='cancelled',finished_at=? WHERE id=? AND bot_id=? AND user_id=?").run(now(), card.jobId, botId, userId);
    if (card.card === 'question') updateRow(botId, decision.seq, { ...card, status: 'dismissed' });
    if (card.card === 'connect') updateRow(botId, decision.seq, { ...card, status: 'skipped', answerJobId: card.jobId });
  }
  // A stopped approval must not be resumable from its old card. Preserve history
  // with denied outputs, without granting approval or scheduling a resume job.
  const pending = db.prepare('SELECT state FROM pending_turns WHERE bot_id=?').get(botId) as { state: string } | undefined;
  if (pending) {
    const state = JSON.parse(pending.state) as { outputs: Record<string, unknown>[]; calls: { call_id: string; rowSeq: number }[] };
    appendHistory(botId, [
      ...state.outputs.map(({ __endTurn, ...output }) => output),
      ...state.calls.map(call => ({ type: 'function_call_output', call_id: call.call_id, output: 'Skipped: the user stopped this agent. Do not retry unless asked.' })),
    ]);
    for (const call of state.calls) {
      const row = getRow(botId, call.rowSeq);
      if (row?.body.type === 'tool-call') updateRow(botId, row.seq, { ...row.body, status: 'denied', summary: 'Stopped by user' } satisfies ToolCallBody);
    }
    db.prepare('DELETE FROM pending_turns WHERE bot_id=?').run(botId);
  }
  const approvals = db.prepare("SELECT id,row_seq FROM approvals WHERE bot_id=? AND status='pending'").all(botId) as { id: string; row_seq: number }[];
  for (const approval of approvals) {
    db.prepare("UPDATE approvals SET status='expired',resolved_at=? WHERE id=? AND bot_id=? AND status='pending'").run(now(), approval.id, botId);
    const row = getRow(botId, approval.row_seq);
    if (row?.body.type === 'card' && row.body.card === 'approval') updateRow(botId, row.seq, { ...row.body, status: 'expired' });
  }
  if (!turnSignal(botId)) setLive(botId, { isRunning: false, activity: null, awaiting: null, startedAt: null });
  return { ok: true, bot_id: botId, action: 'stop', cancelled_jobs: cancelled };
}

/** Unknown names fall through to the caller. Known tools return errors as JSON tool output. */
export async function runVoiceControl(name: string, args: unknown, ctx: VoiceControlContext): Promise<{ output: string } | null> {
  if (!Object.hasOwn(schemas, name)) return null;
  const output = (value: unknown) => ({ output: JSON.stringify(value) });
  try {
    z.object({ userId: id, botId: id, callId: z.string().min(1).max(512) }).parse(ctx);
    assertTenant(ctx.userId);
    const actor = ownedAgent(ctx.userId, ctx.botId);
    const raw = typeof args === 'string' ? JSON.parse(args) : args;
    const tool = name as ControlName;
    if (tool === 'list_agents') {
      schemas.list_agents.parse(raw);
      const agents = db.prepare('SELECT * FROM bots WHERE user_id=? ORDER BY is_primary DESC,created_at,id').all(ctx.userId) as any[];
      return output({ agents: agents.filter(bot => bot.kind !== 'room').map(agentView) });
    }
    if (tool === 'get_agent') {
      const a = schemas.get_agent.parse(raw);
      const bot = ownedAgent(ctx.userId, a.bot_id);
      return output({ agent: agentDetails(bot), generation: bot.generation, messages: recentMessages(bot, a.message_limit), routines: listRoutines(bot.id) });
    }
    if (tool === 'create_bot') {
      requirePrimary(actor);
      if (isConfiguring(actor.id)) throw new Error('Complete and review the primary agent’s setup before creating teammates.');
      const { user_request, ...spec } = schemas.create_bot.parse(raw);
      // A repeated provider call reuses its evidence row as well as the canonical
      // teammate identity. Never cite generated summaries or enqueue a browser task.
      const existing = db.prepare("SELECT seq FROM rows WHERE bot_id=? AND generation=? AND kind='message' AND json_extract(body,'$.role')='user' AND json_extract(body,'$.from.kind')='voice' AND json_extract(body,'$.from.id')=? AND json_extract(body,'$.text')=? ORDER BY seq DESC LIMIT 1")
        .get(actor.id, actor.generation, ctx.callId, user_request) as { seq: number } | undefined;
      const seq = existing?.seq ?? appendRow(actor.id, 'message', { type: 'message', role: 'user', text: user_request, from: { kind: 'voice', id: ctx.callId, name: 'Voice call' } }).seq;
      const result = await createTeammate({ ...spec, source_message_seqs: [seq] }, {
        userId: ctx.userId, botId: actor.id, depth: 0,
        enqueueBotMessage: () => { throw new Error('Voice creation cannot enqueue operational work.'); },
      });
      return { output: String(result.output) };
    }
    if (tool === 'update_agent') {
      requirePrimary(actor);
      const { bot_id, ...patch } = schemas.update_agent.parse(raw);
      const bot = ownedAgent(ctx.userId, bot_id);
      if (patch.model !== undefined) patch.model = patch.model?.trim() || null;
      db.transaction(() => {
        for (const [column, value] of Object.entries(patch)) {
          db.prepare(`UPDATE bots SET ${column}=?,updated_at=? WHERE id=? AND user_id=?`).run(value, now(), bot.id, ctx.userId);
        }
        // Same configuration invalidation and file regeneration as PATCH /bots/:id.
        if (getSetup(bot.id)) {
          db.prepare('UPDATE bot_setups SET revision=revision+1,updated_at=? WHERE bot_id=?').run(now(), bot.id);
          writeSetupFiles(bot.id);
        }
      })();
      if (getSetup(bot.id)) emitSetup(bot.id);
      emitBot(bot.id);
      return output({ ok: true, agent: agentView(getBotRow(bot.id)) });
    }
    const a = schemas.control_agent.parse(raw);
    const bot = ownedAgent(ctx.userId, a.bot_id);
    if (!isPrimary(actor) && actor.id !== bot.id) throw new Error('Only the primary agent may stop another agent.');
    return output(stopAgent(bot.id, ctx.userId));
  } catch (error) {
    return output({ error: error instanceof Error ? error.message : 'Voice control failed.' });
  }
}

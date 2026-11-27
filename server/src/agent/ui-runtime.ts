import { db } from '../db.js';
import { appendRow, getBotRow, loadHistory, updateRow } from '../store.js';
import { uiConfigService } from '../ui/index.js';
import { REGISTRY, accentPair, presetConfig, type UiPreviewCardBody } from '../ui-config/index.js';
import { isConfiguring } from '../bot-setup.js';
import { currentRun, withRun } from './run-scope.js';
import { currentJobId } from '../usage-context.js';
import { selectedCli } from '../cli/store.js';
import { createUiTools, UI_TOOL_NAMES } from './ui-tools.js';
import type { ToolCtx } from './tools.js';
import { APPEARANCE_SKILL } from './ui-skill.js';

type Context = { botId: string; userId?: string; jobId?: string; depth?: number; roomId?: string };
/** Fail closed when a caller has no durable direct-chat provenance. */
export function uiChatJobs(ctx: Context): string[] {
  const bot = getBotRow(ctx.botId);
  if (!bot || ctx.userId && bot.user_id !== ctx.userId || bot.mode !== 'personal' || bot.hidden || bot.parent_bot_id || bot.kind === 'room' || ctx.roomId || ctx.depth || isConfiguring(ctx.botId)) return [];
  let jobId = ctx.jobId ?? (currentRun()?.botId === ctx.botId ? currentRun()?.id : undefined) ?? currentJobId() ?? undefined;
  const jobs: string[] = [];
  while (jobId && jobs.length < 32 && !jobs.includes(jobId)) {
    let row: { trigger: string } | undefined;
    try { row = db.prepare('SELECT trigger FROM agent_jobs WHERE id=? AND bot_id=? AND user_id=?').get(jobId, ctx.botId, bot.user_id) as typeof row; }
    catch { return []; }
    if (!row) return [];
    let trigger: any;
    try { trigger = JSON.parse(row.trigger); } catch { return []; }
    if (!trigger || trigger.roomId || trigger.channel || trigger.audience === 'internal' || trigger.workflowId || trigger.taskId || trigger.goalId || trigger.proactiveSlotKey || trigger.coordinationRequestId || trigger.coordinationWakeId) return [];
    jobs.push(jobId);
    if (trigger.type === 'user') return jobs;
    if (trigger.type !== 'resume' || typeof trigger.parentJobId !== 'string') return [];
    jobId = trigger.parentJobId;
  }
  return [];
}

const outsideTurns = new Map<string, boolean>();
const safeNames = new Set(['tool_search', 'tool_describe', 'get_platform_state', 'ask_user']);
function outsideName(name: string, args?: any) {
  if (UI_TOOL_NAMES.has(name) || safeNames.has(name)) return false;
  if (name === 'read_skill' && args?.skill_id === 'appearance') return false;
  // App metadata, memory, other skills, computer actions and unknown tools can all contain outside text.
  return true;
}
export function uiTurnTainted(ctx: Context): boolean {
  const jobs = uiChatJobs(ctx);
  if (!jobs.length) return true;
  const key = `${ctx.botId}:${jobs.at(-1)}`;
  if (outsideTurns.get(key)) return true;
  // Native CLI file reads are not all observable by this server. Require a click.
  let tainted = !!selectedCli(getBotRow(ctx.botId).user_id);
  const rows = db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='tool-call' AND json_extract(body,'$.jobId') IN (SELECT value FROM json_each(?))").all(ctx.botId, getBotRow(ctx.botId).generation, JSON.stringify(jobs)) as { body: string }[];
  tainted ||= rows.some(row => {
    const body = JSON.parse(row.body);
    return ['running', 'done', 'error'].includes(body.status) && outsideName(body.name, body.args);
  });
  // Provider-managed web/search reads have no tool-dispatch row, but do persist in model history.
  const history = loadHistory(ctx.botId);
  const lastUser = history.findLastIndex(item => item.role === 'user');
  tainted ||= history.slice(lastUser + 1).some(item => typeof item.type === 'string' && /search|browse|computer|file/.test(item.type) && item.type !== 'function_call' && item.type !== 'function_call_output');
  if (tainted) {
    if (outsideTurns.size >= 2048) outsideTurns.delete(outsideTurns.keys().next().value!);
    outsideTurns.set(key, true);
  }
  return tainted;
}
export function uiToolsOffered(ctx: Context): boolean {
  const bot = getBotRow(ctx.botId);
  if (!bot || !uiConfigService.enabled(bot.user_id) || !uiChatJobs(ctx).length) return false;
  uiTurnTainted(ctx); // Retain provider-read evidence before context compaction.
  return true;
}
export function syncUiCards(userId?: string): void {
  // Joining the current generation prevents updates to archived conversations.
  const cards = db.prepare(`SELECT r.bot_id, r.seq, r.body, b.user_id FROM rows r JOIN bots b ON b.id=r.bot_id AND b.generation=r.generation
    WHERE r.kind='card' AND json_extract(r.body,'$.card')='ui_preview' AND json_extract(r.body,'$.status')='pending'
    AND (? IS NULL OR b.user_id=?) LIMIT 200`).all(userId ?? null, userId ?? null) as { bot_id: string; seq: number; body: string; user_id: string }[];
  for (const card of cards) {
    if (!uiConfigService.enabled(card.user_id)) continue;
    const body = JSON.parse(card.body), preview = uiConfigService.getPreview(card.user_id, body.previewId);
    if (preview && preview.status !== body.status) updateRow(card.bot_id, card.seq, { ...body, status: preview.status, ...(preview.revision === undefined ? {} : { revision: preview.revision }) });
  }
}
// Also covers REST actions, expiry and a server restart without manufacturing online presence.
const cardPoll = setInterval(() => {
  try { withRun(undefined, () => syncUiCards()); } catch { /* A database closing or migrating is retried next tick. */ }
}, 1000);
cardPoll.unref();

const runtimeTools = createUiTools({
  service: uiConfigService,
  allowed: ctx => uiChatJobs(ctx).length > 0,
  tainted: uiTurnTainted,
  card: (ctx, body: UiPreviewCardBody) => appendRow(ctx.botId, 'card', { type: 'card', ...body, jobId: ctx.jobId }),
  syncCards: ctx => syncUiCards(ctx.userId),
  history: userId => uiConfigService.history(userId),
  presets: userId => [...REGISTRY.presets.map(preset => ({ id: preset.id, doc: presetConfig(preset.id) })), ...uiConfigService.presets(userId)],
  savePreset: (userId, name) => uiConfigService.savePreset(userId, name),
  accentPair,
  failures: ctx => {
    const jobs = uiChatJobs(ctx);
    const rows = db.prepare("SELECT json_extract(body,'$.name') name FROM rows WHERE bot_id=? AND generation=? AND kind='tool-call' AND json_extract(body,'$.status')='error' AND json_extract(body,'$.jobId') IN (SELECT value FROM json_each(?))").all(ctx.botId, getBotRow(ctx.botId).generation, JSON.stringify(jobs)) as { name: string }[];
    return rows.filter(row => UI_TOOL_NAMES.has(row.name)).length;
  },
});
export const runtimeUiTool = (name: string, raw: unknown, ctx: ToolCtx) => runtimeTools.find(tool => tool.name === name)!.impl(raw, ctx);

/** Add the built-in recipe through existing discovery without writing user skill records. */
export async function appearanceSkillResult(name: string, args: any, ctx: ToolCtx, next: () => Promise<any>) {
  if (!uiToolsOffered(ctx)) return next();
  if (name === 'read_skill' && args?.skill_id === 'appearance') {
    if (args.file_path && args.file_path !== 'SKILL.md') return { output: JSON.stringify({ ok: false, error: 'Skill file not found.' }), isError: true };
    return { output: JSON.stringify({ ok: true, skill: APPEARANCE_SKILL }) };
  }
  const result = await next();
  if (name === 'list_skills' && !args?.offset && !result.isError && typeof result.output === 'string') {
    const parsed = JSON.parse(result.output);
    if (Array.isArray(parsed.skills)) {
      const { body: _body, ...metadata } = APPEARANCE_SKILL;
      parsed.skills.push(metadata);
      return { ...result, output: JSON.stringify(parsed) };
    }
  }
  return result;
}

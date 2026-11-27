/** Pure DDL. HO-B imports FK parent schema modules before executing this string. */
export const DDL = `
CREATE TABLE IF NOT EXISTS run_outputs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  job_id TEXT UNIQUE REFERENCES agent_jobs(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK(source IN ('run','task','message','routine','loop_step')),
  status TEXT NOT NULL CHECK(status IN ('draft','final','superseded')),
  revision INTEGER NOT NULL DEFAULT 1, title TEXT NOT NULL, summary TEXT NOT NULL,
  manifest TEXT NOT NULL,            -- JSON OutputPart[] without bodies
  provenance TEXT NOT NULL,          -- JSON Provenance
  content_hash TEXT NOT NULL, incomplete INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, finalized_at INTEGER);
CREATE INDEX IF NOT EXISTS run_outputs_owner ON run_outputs(user_id, bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS run_outputs_task ON run_outputs(task_id);
CREATE TABLE IF NOT EXISTS run_output_parts (
  output_id TEXT NOT NULL REFERENCES run_outputs(id) ON DELETE CASCADE, part_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('text','data')), name TEXT NOT NULL, body TEXT NOT NULL,
  sha256 TEXT NOT NULL, redacted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(output_id, part_id));

CREATE TABLE IF NOT EXISTS loops (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  room_id TEXT REFERENCES bots(id) ON DELETE SET NULL, task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  name TEXT NOT NULL, spec TEXT NOT NULL,                 -- JSON LoopSpec, validated
  status TEXT NOT NULL CHECK(status IN ('draft','awaiting_approval','running','paused','succeeded','capped','stalled','failed','cancelled')),
  stop_reason TEXT, iteration INTEGER NOT NULL DEFAULT 0, best_output_id TEXT REFERENCES run_outputs(id) ON DELETE SET NULL,
  initiated_by TEXT NOT NULL, claim_token TEXT, claim_until INTEGER,
  idempotency_key TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(user_id, idempotency_key));
CREATE INDEX IF NOT EXISTS loops_owner ON loops(user_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  to_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  source_output_id TEXT NOT NULL REFERENCES run_outputs(id) ON DELETE CASCADE,
  result_output_id TEXT REFERENCES run_outputs(id) ON DELETE SET NULL,
  initiated_by TEXT NOT NULL CHECK(initiated_by IN ('user','agent','link','loop')),
  instruction TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal',
  return_result INTEGER NOT NULL DEFAULT 1, create_task INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('pending_approval','queued','delivered','running','completed','failed','declined','cancelled','expired')),
  reason TEXT NOT NULL DEFAULT '', request_id TEXT REFERENCES coordination_requests(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,
  loop_id TEXT REFERENCES loops(id) ON DELETE SET NULL, iteration INTEGER, step_id TEXT,
  room_id TEXT REFERENCES bots(id) ON DELETE SET NULL, chain_depth INTEGER NOT NULL DEFAULT 1,
  parent_handoff_id TEXT REFERENCES handoffs(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(user_id, idempotency_key));
CREATE INDEX IF NOT EXISTS handoffs_bot ON handoffs(user_id, to_bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS handoffs_from ON handoffs(user_id, from_bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS handoffs_status ON handoffs(status, updated_at);

CREATE TABLE IF NOT EXISTS handoff_links (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  to_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('off','suggest','auto')) DEFAULT 'suggest',
  trigger TEXT NOT NULL DEFAULT 'any_run', template TEXT NOT NULL DEFAULT '',
  auto_approve_loops INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(from_bot_id, to_bot_id));

CREATE TABLE IF NOT EXISTS loop_steps (                                  -- one row per step run, written before dispatch
  id TEXT PRIMARY KEY, loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  iteration INTEGER NOT NULL, step_id TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  role TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('dispatching','dispatched','running','completed','failed','skipped')),
  handoff_id TEXT REFERENCES handoffs(id) ON DELETE SET NULL, job_id TEXT REFERENCES agent_jobs(id) ON DELETE SET NULL,
  output_id TEXT REFERENCES run_outputs(id) ON DELETE SET NULL, nudged INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER, cost_usd REAL, started_at INTEGER, finished_at INTEGER,
  UNIQUE(loop_id, iteration, step_id));

CREATE TABLE IF NOT EXISTS loop_verdicts (
  loop_id TEXT NOT NULL REFERENCES loops(id) ON DELETE CASCADE, iteration INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checker_step_id TEXT NOT NULL, output_id TEXT REFERENCES run_outputs(id) ON DELETE SET NULL,
  pass INTEGER NOT NULL, claimed_pass INTEGER NOT NULL, score REAL, checklist TEXT NOT NULL, feedback TEXT NOT NULL,
  feedback_hash TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(loop_id, iteration));

CREATE TABLE IF NOT EXISTS handoff_events (                               -- append only, source of the timeline
  seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  loop_id TEXT REFERENCES loops(id) ON DELETE CASCADE, handoff_id TEXT REFERENCES handoffs(id) ON DELETE CASCADE,
  type TEXT NOT NULL, data TEXT NOT NULL,                   -- JSON ids, counts, hashes, never bodies
  created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS handoff_events_loop ON handoff_events(loop_id, seq);
CREATE INDEX IF NOT EXISTS handoff_events_handoff ON handoff_events(handoff_id, seq);

CREATE TABLE IF NOT EXISTS handoff_task_links (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  handoff_id TEXT REFERENCES handoffs(id) ON DELETE CASCADE, loop_id TEXT REFERENCES loops(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('receiver','gate','loop')), PRIMARY KEY(task_id, kind));

CREATE TABLE IF NOT EXISTS bot_flow_cache (
  bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE, inputs_hash TEXT NOT NULL,
  model_json TEXT NOT NULL, version INTEGER NOT NULL, agent_steps_json TEXT, agent_steps_hash TEXT, updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS handoff_user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 1,
  agent_handoffs TEXT NOT NULL DEFAULT 'team' CHECK(agent_handoffs IN ('team','links_only','off')), updated_at INTEGER NOT NULL);
`;
export { OUTPUT_LIMITS } from "./contracts.js";

import { z } from 'zod';
import { OUTPUT_LIMITS as limits } from './contracts.js';
import { canonicalJson } from '../flow/hash.js';

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const httpsUrl = z.string().max(2048).url().refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password;
}, 'Use an https URL without credentials');
export const linkSchema = z.object({ url: httpsUrl, title: z.string().max(120), relation: z.enum(['source', 'result', 'reference']) }).strict();
export const dataPartSchema = z.object({ name: z.string().min(1).max(80), schema: z.string().max(120).optional(), json: z.unknown() }).strict().superRefine((part, ctx) => {
  try {
    if (new TextEncoder().encode(canonicalJson(part.json)).length > limits.dataBytesMax) ctx.addIssue({ code: 'custom', message: 'Data part is too large' });
  } catch { ctx.addIssue({ code: 'custom', message: 'Data must be JSON' }); }
});
export const submitOutputSchema = z.object({
  title: z.string().min(1).max(120).optional(), summary: z.string().min(1).max(limits.summaryChars),
  dataParts: z.array(dataPartSchema).max(limits.dataMax).optional(),
  links: z.array(linkSchema).max(limits.linksMax).optional(), files: z.array(z.string().min(1).max(1024)).max(limits.filesMax).optional(),
}).strict();
export const verdictSchema = z.object({
  pass: z.boolean(), score: z.number().min(0).max(1).optional(),
  checklist: z.array(z.object({ id, pass: z.boolean(), note: z.string().max(400) }).strict()).max(30),
  feedback: z.string().max(2000),
}).strict();
export const loopStepSchema = z.object({ id, botId: id, role: z.enum(['step', 'maker', 'checker']), instruction: z.string().max(1500) }).strict();
export const exitRuleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('verdict') }).strict(),
  z.object({ mode: z.literal('checklist'), items: z.array(z.object({ id, text: z.string().min(1).max(400), required: z.boolean() }).strict()).min(1).max(30), minScore: z.number().min(0).max(1).optional() }).strict(),
  z.object({ mode: z.literal('judge'), judgeBotId: id.optional(), rubric: z.string().min(1).max(2000) }).strict(),
  z.object({ mode: z.literal('manual') }).strict(),
]);
export const loopLimitsSchema = z.object({
  maxIterations: z.number().int().min(1).max(10).default(4), maxMinutes: z.number().min(5).max(240).default(30),
  maxCostUsd: z.number().positive().optional(), maxTokens: z.number().int().positive().optional(),
  stepTimeoutMinutes: z.number().min(1).max(30).default(10),
}).strict();
export const loopSpecSchema = z.object({
  name: z.string().min(1).max(80), goal: z.string().min(1).max(2000), kind: z.enum(['pipeline', 'maker_checker']),
  steps: z.array(loopStepSchema).min(2).max(6), seed: z.object({ outputRef: z.string().max(400).optional(), text: z.string().max(2000).optional() }).strict(),
  exit: exitRuleSchema, limits: loopLimitsSchema,
  gate: z.object({ before: z.enum(['none', 'first', 'each']), onCap: z.enum(['stop', 'ask']) }).strict(),
  roomId: id.optional(), taskId: id.optional(),
}).strict().superRefine((spec, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(spec.steps.map(s => s.id)).size !== spec.steps.length) issue('Step ids must be unique');
  if (spec.kind === 'maker_checker' && (spec.steps.length !== 2 || spec.steps[0].role !== 'maker' || spec.steps[1].role !== 'checker')) issue('Use exactly a maker followed by a checker');
  if (['verdict', 'checklist'].includes(spec.exit.mode) && spec.steps.at(-1)?.role !== 'checker') issue('The final step must be a checker');
  if (spec.exit.mode === 'checklist' && new Set(spec.exit.items.map(i => i.id)).size !== spec.exit.items.length) issue('Checklist ids must be unique');
  if (spec.seed.outputRef && !/^swarm:\/\/output\/out_[A-Za-z0-9_-]+$/.test(spec.seed.outputRef)) issue('Invalid seed reference');
});
export const flowSummarySchema = z.object({
  steps: z.array(z.object({ label: z.string().min(1).max(40), detail: z.string().max(60).optional() }).strict()).min(1).max(6),
  loopNote: z.string().max(120).optional(),
}).strict();

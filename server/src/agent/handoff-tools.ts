import { z } from 'zod';
import type { HandoffContext, HandoffService } from '../handoffs/contracts.js';
import { OUTPUT_LIMITS } from '../handoffs/contracts.js';
import type { HandoffErrorCode } from '../handoffs/errors.js';
import type { ToolCtx, ToolDef, ToolResult } from './tools.js';

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const outputRef = z.string().max(500).regex(/^swarm:\/\/output\/out_[A-Za-z0-9_-]+(?:#[A-Za-z0-9_-]+)?(?:\?o=\d+&l=\d+)?$/)
  .refine(value => {
    const page = /\?o=(\d+)&l=(\d+)$/.exec(value);
    return !page || (Number.isSafeInteger(Number(page[1])) && Number(page[2]) >= 1 && Number(page[2]) <= 8000);
  }, 'Reference pages must use a safe offset and a limit from 1 to 8000.');
const handoffRef = z.string().max(500).regex(/^swarm:\/\/handoff\/ho_[A-Za-z0-9_-]+$/);
const path = z.string().min(1).max(1024).refine(value => !/[\u0000-\u001f]/.test(value), 'Use a saved file path.');
const text = (max: number) => z.string().trim().min(1).max(max);
const link = z.object({
  url: z.url({ protocol: /^https$/ }).max(2048).refine(value => {
    try { const url = new URL(value); return !url.username && !url.password; }
    catch { return false; }
  }, 'Use an HTTPS URL without credentials.'),
  title: text(120), relation: z.enum(['source', 'result', 'reference']),
}).strict();
const dataPart = z.object({
  name: text(80), schema: text(120).optional(),
  json: z.json().refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= OUTPUT_LIMITS.dataBytesMax,
    'The data part exceeds 256 KB. Save it as a file instead.'),
}).strict();
const verdict = z.object({
  pass: z.boolean(), score: z.number().min(0).max(1).optional(),
  checklist: z.array(z.object({ id, pass: z.boolean(), note: z.string().max(400) }).strict()).max(30)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Answer each checklist item once.'),
  feedback: z.string().max(2000),
}).strict();
const exitRule = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('verdict') }).strict(),
  z.object({ mode: z.literal('checklist'), items: z.array(z.object({ id, text: text(400), required: z.boolean() }).strict()).min(1).max(30)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Checklist ids must be unique.'),
  minScore: z.number().min(0).max(1).optional() }).strict(),
  z.object({ mode: z.literal('judge'), judgeBotId: id.optional(), rubric: text(2000) }).strict(),
  z.object({ mode: z.literal('manual') }).strict(),
]);
const loop = z.object({
  steps: z.array(z.object({ id, botId: id, role: z.enum(['step', 'maker', 'checker']), instruction: text(1500) }).strict()).min(2).max(6),
  goal: text(2000), exit: exitRule,
  limits: z.object({
    maxIterations: z.number().int().min(1).max(10).default(4),
    maxMinutes: z.number().int().min(5).max(240).default(30),
    stepTimeoutMinutes: z.number().int().min(1).max(30).default(10),
    maxCostUsd: z.number().positive().optional(), maxTokens: z.number().int().positive().optional(),
  }).strict(),
  name: text(80).optional(), kind: z.enum(['pipeline', 'maker_checker']).default('maker_checker'),
  seed: z.object({ outputRef: outputRef.optional(), text: text(2000).optional() }).strict().optional(),
  roomId: id.optional(), taskId: id.optional(),
}).strict().superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(value.steps.map(step => step.id)).size !== value.steps.length) issue('Step ids must be unique.');
  const makerChecker = value.kind === 'maker_checker';
  if (makerChecker && (value.steps.length !== 2 || value.steps[0]?.role !== 'maker' || value.steps[1]?.role !== 'checker')) {
    issue('A maker and checker loop requires exactly one maker followed by one checker.');
  }
  if (value.steps.some(step => step.role === 'maker' && value.steps.some(other => other.role === 'checker' && other.botId === step.botId))) {
    issue('Choose different agents to make and check the work.');
  }
  if (['verdict', 'checklist'].includes(value.exit.mode) && value.steps.at(-1)?.role !== 'checker') {
    issue('The final step must be a checker for this exit rule.');
  }
});

export const HANDOFF_TOOL_SCHEMAS = {
  submit_output: z.object({
    title: text(120).optional(), summary: text(OUTPUT_LIMITS.summaryChars),
    dataParts: z.array(dataPart).max(OUTPUT_LIMITS.dataMax).optional(),
    links: z.array(link).max(OUTPUT_LIMITS.linksMax).optional(),
    files: z.array(path).max(OUTPUT_LIMITS.filesMax).optional(),
  }).strict(),
  handoff_to_agent: z.object({
    toBotId: id, instruction: text(2000), outputRef: outputRef.optional(),
    summary: text(OUTPUT_LIMITS.summaryChars).optional(), includeFiles: z.array(id).max(OUTPUT_LIMITS.filesMax).optional(),
    returnResult: z.boolean().default(true), priority: z.enum(['normal', 'high']).default('normal'), reason: text(500).optional(),
  }).strict(),
  read_handoff: z.object({
    ref: z.union([outputRef, handoffRef]).optional(), handoffId: id.optional(), partId: id.optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(8000).optional(), materialize: z.boolean().optional(),
  }).strict().refine(value => Boolean(value.ref) !== Boolean(value.handoffId), 'Provide either ref or handoffId, not both.'),
  list_handoffs: z.object({
    direction: z.enum(['sent', 'received', 'all']).default('all'),
    status: z.enum(['pending_approval', 'queued', 'delivered', 'running', 'completed', 'failed', 'declined', 'cancelled', 'expired']).optional(),
    limit: z.number().int().min(1).max(20).default(20),
  }).strict(),
  submit_verdict: verdict,
  start_loop: loop,
};

/** Fixed messages never forward service exceptions, ids, paths or other tenant data. */
export const HANDOFF_REFUSALS: Readonly<Record<HandoffErrorCode | 'part_too_large', string>> = {
  disabled: 'Handoffs are disabled. Continue with the current task.',
  policy_denied: 'Agent handoffs are not allowed by the current policy. Return your result to the user.',
  cycle_detected: 'That would send the work back to an earlier agent. Use a bounded loop instead.',
  chain_too_long: 'This handoff chain has reached its limit. Return your result or propose a bounded loop.',
  rate_limited: 'The handoff rate limit has been reached. Return your result and wait before trying again.',
  target_not_allowed: 'That agent cannot receive this handoff. Choose an allowed active teammate.',
  not_in_loop: 'No review is waiting for you.',
  loop_nested: 'This run is part of a loop. Return your result; the loop passes it on.',
  part_too_large: 'This output exceeds a size limit. Shorten the text or save large data as a file.',
  size_limit: 'This output exceeds a size limit. Shorten the text or save large data as a file.',
  not_found: 'That output or handoff is not available to this agent. Use a reference addressed to you.',
  output_deleted: 'That output was deleted. Ask for a new output.',
  invalid_state: 'This result is already final or the review has already been submitted. It cannot be changed.',
  idempotency_conflict: 'This call already recorded different content. Inspect its result before requesting a new action.',
  same_bot_roles: 'Choose different agents to make and check the work.',
  invalid_input: 'The request is invalid. Check the tool fields and limits before trying again.',
};

/** The dispatch owner must supply the stable call id for API and CLI calls. */
export type HandoffToolContext = ToolCtx & { toolCallId?: string };
export type HandoffToolPolicy = Pick<HandoffService, 'enabled'>;
type TextResult = ToolResult & { output: string };
const refusal = (output: string): TextResult => ({ output, isError: true });

export function defineHandoffTool<S extends z.ZodType>(
  name: string, description: string, label: string, schema: S,
  policy: () => HandoffToolPolicy | undefined,
  action: (input: z.output<S>, context: HandoffContext) => Promise<TextResult>,
): ToolDef {
  const { $schema, ...parameters } = z.toJSONSchema(schema, { io: 'input' });
  return {
    name, description, parameters, activity: 'working', label,
    impl: async (args: unknown, raw: HandoffToolContext): Promise<TextResult> => {
      try {
        const parsed = schema.safeParse(args);
        if (!parsed.success) return refusal('Invalid arguments. Check required fields, allowed fields and size limits in the tool schema.');
        // Never spread arguments or trust caller-selected identity fields.
        if (![raw.userId, raw.botId, raw.jobId, raw.toolCallId].every(value => typeof value === 'string' && value.length > 0)) {
          return refusal('This tool needs an active run and a stable tool call id. Ask the user to retry from an active run.');
        }
        const context: HandoffContext = { userId: raw.userId, botId: raw.botId, jobId: raw.jobId!, toolCallId: raw.toolCallId! };
        const service = policy();
        if (!service) return refusal('Handoff tools are not available yet. Continue with the current task.');
        if (process.env.HANDOFFS_DISABLED === '1' || !await service.enabled(context.userId)) return refusal(HANDOFF_REFUSALS.disabled);
        return await action(parsed.data, context);
      } catch (error) {
        let code = '';
        try {
          if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') code = error.code;
        } catch { /* Untrusted exception objects must not escape the tool boundary. */ }
        return refusal(Object.hasOwn(HANDOFF_REFUSALS, code) ? HANDOFF_REFUSALS[code as keyof typeof HANDOFF_REFUSALS] : 'The handoff operation could not finish. Inspect the current result before trying again.');
      }
    },
  };
}

function buildHandoffTools(resolve: () => HandoffService | undefined): ToolDef[] {
  const tool = <S extends z.ZodType>(name: string, description: string, label: string, schema: S,
    action: (service: HandoffService, input: z.output<S>, context: HandoffContext) => Promise<TextResult>) =>
    defineHandoffTool(name, description, label, schema, resolve, (input, context) => action(resolve()!, input, context));
  return [
    tool('submit_output', 'Declare or revise this run\'s draft output. Include a short summary, JSON data, HTTPS links and only files saved by this run.', 'Saving run output', HANDOFF_TOOL_SCHEMAS.submit_output,
      async (service, input, context) => {
        const output = await service.submitOutput(context, input);
        return { output: JSON.stringify({ outputRef: `swarm://output/${output.id}`, status: output.status, revision: output.revision }) };
      }),
    tool('handoff_to_agent', 'Pass work to an allowed teammate for a good reason. includeFiles selects file part or artifact ids from the output. Returns immediately; results arrive asynchronously. Unavailable inside a loop step.', 'Sending to agent', HANDOFF_TOOL_SCHEMAS.handoff_to_agent,
      async (service, input, context) => {
        const handoff = await service.handoffToAgent(context, input);
        return { output: JSON.stringify({ handoffId: handoff.id, status: handoff.status }), ...(input.returnResult ? {} : { endTurn: true }) };
      }),
    tool('read_handoff', 'Read an output produced by you, addressed to you or available in your loop. Page through at most 8000 characters. Links are metadata only. Materialize included files only when needed.', 'Reading handoff', HANDOFF_TOOL_SCHEMAS.read_handoff,
      async (service, input, context) => ({ output: JSON.stringify(await service.readHandoff(context, input)) })),
    tool('list_handoffs', 'List this agent\'s handoffs, newest first, with at most 20 results.', 'Listing handoffs', HANDOFF_TOOL_SCHEMAS.list_handoffs,
      async (service, input, context) => ({ output: JSON.stringify(await service.listHandoffs(context, input)) })),
    tool('submit_verdict', 'Submit one strict review as the current loop checker or judge. Checklist pass is recomputed by the server. Submitted verdicts cannot be changed.', 'Submitting review', HANDOFF_TOOL_SCHEMAS.submit_verdict,
      async (service, input, context) => ({ output: JSON.stringify(await service.submitVerdict(context, input)) })),
    tool('start_loop', 'Propose bounded improvement with steps, a goal, exit criteria and limits. The server enforces a user gate unless the exact pair is already approved. Tell the user when approval is waiting. Unavailable inside loop steps.', 'Proposing loop', HANDOFF_TOOL_SCHEMAS.start_loop,
      async (service, input, context) => {
        const loop = await service.startLoop(context, input);
        return { output: JSON.stringify({ loopId: loop.id, status: loop.status, message: loop.status === 'awaiting_approval'
          ? 'The loop is waiting for user approval. Tell the user to review it before work can begin.'
          : 'The loop was created under the user\'s policy. Tell the user its current status.' }) };
      }),
  ];
}

export function createHandoffTools(service: HandoffService): ToolDef[] {
  return buildHandoffTools(() => service);
}

let configuredService: HandoffService | undefined;
/** HO-I binds HO-B's service before exposing HANDOFF_TOOLS in the registry. */
export function configureHandoffTools(service: HandoffService): void {
  configuredService = service;
}
export const HANDOFF_TOOLS = buildHandoffTools(() => configuredService);

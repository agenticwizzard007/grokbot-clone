import { z } from 'zod';
import { db } from '../db.js';
import { transactionWithEffects } from '../lib/commit-effects.js';
import type { FlowStore, FlowSummaryInput, HandoffContext } from '../handoffs/contracts.js';
import { ownFlowBot, readFlowInputs, touchFlow, FlowError } from './cache.js';
import { stepHash } from './build.js';

const text = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u2013\u2014]*$/, 'Use plain punctuation.');
export const flowSummarySchema = z.object({ steps: z.array(z.object({ label: text(40), detail: text(60).optional() }).strict()).min(1).max(6), loopNote: text(60).optional() }).strict();
export const flowStore: FlowStore = {
  async writeFlowSummary(context: HandoffContext, input: FlowSummaryInput) {
    const summary = flowSummarySchema.parse(input);
    return transactionWithEffects(() => {
      ownFlowBot(context.userId, context.botId);
      const hash = stepHash(readFlowInputs(context.userId, context.botId));
      db.prepare("INSERT INTO bot_flow_cache(bot_id,inputs_hash,model_json,version,agent_steps_json,agent_steps_hash,updated_at) VALUES(?,'','',0,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET inputs_hash='',agent_steps_json=excluded.agent_steps_json,agent_steps_hash=excluded.agent_steps_hash").run(context.botId, JSON.stringify(summary), hash, Date.now());
      touchFlow(context.botId);
      return { inputsHash: hash };
    });
  },
};
export type FlowRefreshEnqueue = (botId: string, text: string, options: { idempotencyKey: string; reply: false; correlationId: string }) => unknown;
let enqueue: FlowRefreshEnqueue | undefined;
/** HO-I supplies HO-B's enqueueSystemRequest after both workstreams merge. */
export function configureFlowRefresh(value: FlowRefreshEnqueue) { enqueue = value; }
export function requestFlowRefresh(userId: string, botId: string, clock = Date.now()) {
  return transactionWithEffects(() => {
    ownFlowBot(userId, botId);
    const last = db.prepare('SELECT requested_at FROM flow_refresh_requests WHERE bot_id=?').get(botId) as { requested_at: number } | undefined;
    if (last && clock - last.requested_at < 600_000) return { accepted: false, retryAfter: Math.ceil((600_000 - (clock - last.requested_at)) / 1000) };
    if (!enqueue) throw new FlowError('unavailable', 'Summary refresh is not available yet.', 503);
    const key = `flow:${botId}:${clock}`;
    enqueue(botId, 'Review your current instructions and skills, then call write_flow_summary once. Do not run the workflow.', { idempotencyKey: key, reply: false, correlationId: key });
    db.prepare('INSERT INTO flow_refresh_requests VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET requested_at=excluded.requested_at').run(botId, clock);
    return { accepted: true, retryAfter: 600 };
  });
}

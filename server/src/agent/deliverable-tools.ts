import { z } from 'zod';
import type { ToolDef } from './tools.js';
import { getArtifact, listArtifacts, listDeliveries, listRoutineRuns, requestDelivery, retryDelivery, sendDelivery } from '../deliverables/index.js';
import { deliverArtifactArgs, prepareDeliveryAction, retryDeliveryArgs } from '../deliverables/approval.js';
export { prepareDeliveryAction } from '../deliverables/approval.js';

const schema = (value: z.ZodType) => { const { $schema, ...json } = z.toJSONSchema(value); return json; };
const empty = z.object({}).strict();
const history = z.object({ routine_id: z.string().min(1).optional() }).strict();
const delivery = deliverArtifactArgs;
const retry = retryDeliveryArgs;

/** Delivery/retry are external actions: the registry owner must apply Swarm's exact-action approval gate. */
export const DELIVERABLE_TOOLS: ToolDef[] = [
  {
    name: 'list_deliverables', description: 'List your saved report files, authenticated Library downloads and delivery outcomes. Files are immutable snapshots; an unknown delivery was not retried.',
    parameters: schema(empty), activity: 'working', label: 'Reading saved reports',
    impl: async (a, ctx) => {
      empty.parse(a);
      return { output: JSON.stringify({ artifacts: listArtifacts(ctx.userId, ctx.botId).map((f) => ({ ...f, deliveries: listDeliveries(ctx.userId, f.id) })) }) };
    },
  },
  {
    name: 'routine_history', description: 'Read your routine run history, including durable job IDs and completed, failed or unknown outcomes. Does not run a routine.',
    parameters: schema(history), activity: 'working', label: 'Reading routine history',
    impl: async (a, ctx) => { const args = history.parse(a); return { output: JSON.stringify({ runs: listRoutineRuns(ctx.userId, ctx.botId, args.routine_id) }) }; },
  },
  {
    name: 'deliver_artifact', description: 'Deliver an existing saved report to Library or one of the user’s linked messaging channels. Requires authorization to send. Sends saved bytes or an authenticated download link; never regenerates the report. A send outcome can be unknown: verify with the recipient rather than sending again.',
    parameters: schema(delivery), activity: 'working', label: 'Delivering a saved report',
    impl: async (a, ctx) => {
      const args = delivery.parse(a), artifact = getArtifact(ctx.userId, args.artifact_id);
      if (!args.destination) throw new Error('Prepare the report destination before requesting approval.');
      await prepareDeliveryAction(ctx.userId, ctx.botId, 'deliver_artifact', args);
      if (artifact.botId !== ctx.botId) throw new Error('Report does not belong to this Bot.');
      if (!ctx.jobId) throw new Error('Delivery requires a durable job context.');
      const d = await requestDelivery({ userId: ctx.userId, artifactId: artifact.id, channel: args.channel,
        idempotencyKey: `job:${ctx.jobId}:${artifact.id}:${args.channel}`, approvedTarget: args.destination.target });
      const result = await sendDelivery(ctx.userId, d.id);
      return { output: JSON.stringify({ delivery: result }), isError: result.status === 'failed' || result.status === 'unknown', summary: `Report delivery: ${result.status}` };
    },
  },
  {
    name: 'retry_delivery', description: 'Retry a definitely-not-sent report delivery using the identical saved artifact and original destination. Requires authorization to send. Unknown or already delivered sends cannot be retried. Never runs the routine or agent again.',
    parameters: schema(retry), activity: 'working', label: 'Retrying report delivery',
    impl: async (a, ctx) => {
      const args = retry.parse(a);
      if (!args.destination) throw new Error('Prepare the report destination before requesting approval.');
      await prepareDeliveryAction(ctx.userId, ctx.botId, 'retry_delivery', args);
      // Validate the acting Bot before resetting any delivery state.
      const { getDelivery } = await import('../deliverables/delivery.js');
      const old = getDelivery(ctx.userId, args.delivery_id);
      if (getArtifact(ctx.userId, old.artifactId).botId !== ctx.botId) throw new Error('Report does not belong to this Bot.');
      const d = retryDelivery(ctx.userId, old.id), result = await sendDelivery(ctx.userId, d.id);
      return { output: JSON.stringify({ delivery: result }), isError: result.status !== 'delivered', summary: `Report delivery: ${result.status}` };
    },
  },
];

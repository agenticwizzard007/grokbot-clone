import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { env } from '../env.js';
import { getArtifact } from './artifacts.js';
import { getDelivery, getDeliveryTarget, targetIdentity, type DeliveryTarget, type DeliveryTransport } from './delivery.js';
import { messagingDeliveryTransport } from './messaging.js';
import { DeliverableError } from './types.js';

const targetSchema = z.object({ channel: z.enum(['library', 'imessage', 'sms', 'whatsapp']), transport: z.string().optional(),
  phone: z.string().nullable().optional(), chatRef: z.string().nullable().optional(), revision: z.string().optional() }).strict();
export const deliveryDestinationSchema = z.object({ target: targetSchema, recipient: z.string(), artifact_sha256: z.string(), proof: z.string() }).strict();
export const deliverArtifactArgs = z.object({ artifact_id: z.string().min(1), channel: z.enum(['library', 'imessage', 'sms', 'whatsapp']), destination: deliveryDestinationSchema.optional() }).strict();
export const retryDeliveryArgs = z.object({ delivery_id: z.string().min(1), destination: deliveryDestinationSchema.optional() }).strict();

function signature(userId: string, botId: string, name: string, artifactId: string, sha: string, deliveryId: string | null, target: DeliveryTarget) {
  return createHmac('sha256', env.sessionSecret).update(JSON.stringify([userId, botId, name, artifactId, sha, deliveryId, targetIdentity(target)])).digest('hex');
}
function sameProof(actual: string, expected: string) {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Root calls BEFORE policy/binding and persists these augmented arguments in pending turns/cards.
 * Existing pins are validated, never silently replaced when a recipient changes during approval.
 * adapter is an optional deterministic test seam; production always uses the registered messaging adapter.
 */
export async function prepareDeliveryAction(userId: string, botId: string, name: string, raw: unknown, adapter: DeliveryTransport = messagingDeliveryTransport): Promise<Record<string, unknown>> {
  if (name !== 'deliver_artifact' && name !== 'retry_delivery') return raw as Record<string, unknown>;
  const args = name === 'deliver_artifact' ? deliverArtifactArgs.parse(raw) : retryDeliveryArgs.parse(raw);
  const deliveryId = 'delivery_id' in args ? args.delivery_id : null;
  const old = deliveryId ? getDelivery(userId, deliveryId) : null;
  const artifact = getArtifact(userId, 'artifact_id' in args ? args.artifact_id : old!.artifactId);
  if (artifact.botId !== botId) throw new DeliverableError('Report does not belong to this Bot.', 404);
  if (old && old.status !== 'failed') throw new DeliverableError('Only definitely not-sent deliveries can retry.', 409);
  const channel = 'channel' in args ? args.channel : old!.channel;
  const current: DeliveryTarget = channel === 'library' ? { channel } : await adapter.prepare(userId, channel);
  const target = deliveryId ? getDeliveryTarget(userId, deliveryId) : current;
  if (targetIdentity(target) !== targetIdentity(current)) throw new DeliverableError('Original report destination changed. Delivery was not sent.', 409);
  const proof = signature(userId, botId, name, artifact.id, artifact.sha256, deliveryId, target);
  const pinned = args.destination;
  if (pinned && (!sameProof(pinned.proof, proof) || pinned.artifact_sha256 !== artifact.sha256 || targetIdentity(pinned.target) !== targetIdentity(target))) {
    throw new DeliverableError('Approved report destination changed or its approval is invalid. Request approval again.', 409);
  }
  const recipient = channel === 'library' ? 'Library' : `${channel}: ${target.phone ?? target.chatRef ?? 'linked recipient'}`;
  if (pinned && pinned.recipient !== recipient) throw new DeliverableError('Approved recipient label changed.', 409);
  return { ...args, destination: pinned ?? { target, recipient, artifact_sha256: artifact.sha256, proof } };
}

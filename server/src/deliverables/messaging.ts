import { env } from '../env.js';
import type { DeliveryTransport } from './delivery.js';
import { DeliveryNotSentError } from './types.js';

export const messagingDeliveryTransport: DeliveryTransport = {
  async prepare(userId, channel) {
    if (channel === 'library') return { channel };
    const { controlledDeliveryTarget } = await import('../messaging/bridge.js');
    return controlledDeliveryTarget(userId, channel);
  },
  async send({ userId, attemptId, target, artifact, content }) {
    const url = new URL(artifact.downloadUrl, env.appUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new DeliveryNotSentError('Invalid download URL.');
    const { sendControlledDeliverable } = await import('../messaging/bridge.js');
    return sendControlledDeliverable({ userId, botId: artifact.botId, artifactId: artifact.id, dispatchId: attemptId, target,
      file: { data: content, mime: artifact.mimeType, filename: artifact.filename }, downloadUrl: url.href });
  },
};

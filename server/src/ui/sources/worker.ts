import { db } from '../../db.js';
import { sourceById } from './catalog.js';

// All schema setup happens at module initialization. Source execution cannot write.
db.pragma('query_only = ON');
globalThis.fetch = async () => { throw new Error('Dashboard sources cannot access the network.'); };
process.on('disconnect', () => { db.close(); process.exit(0); });
process.on('message', (message: any) => {
  try {
    const source = sourceById.get(message.source);
    if (!source || typeof message.userId !== 'string' || !message.userId) throw new Error('Invalid source request.');
    const params = source.paramsSchema.parse(message.params);
    process.send?.({ ok: true, data: source.resolve(message.userId, params as any) });
  } catch (error) {
    process.send?.({ ok: false, code: error && typeof error === 'object' && 'code' in error ? error.code : 'unavailable' });
  }
});
process.send?.({ ready: true });

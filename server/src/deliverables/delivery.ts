import './schema.js';
import { db, now } from '../db.js';
import { newId } from '../lib/ids.js';
import { getArtifact, readArtifact } from './artifacts.js';
import { ownerAlive, ownerBirth, writeOwner } from './ownership.js';
import { DeliverableError, DeliveryNotSentError, type Artifact, type ArtifactDelivery, type DeliveryAttempt, type DeliveryChannel, type DeliveryStatus } from './types.js';
import { legacyWritableRows } from '../platform/legacy-database-fence.js';

export interface DeliveryTarget { channel: DeliveryChannel; transport?: string; phone?: string | null; chatRef?: string | null; revision?: string }
export const targetIdentity = (target: DeliveryTarget) => JSON.stringify([target.channel, target.transport ?? null, target.phone ?? null, target.chatRef ?? null, target.revision ?? null]);
export interface DeliveryTransport {
  prepare(userId: string, channel: DeliveryChannel): Promise<DeliveryTarget>;
  send(input: { userId: string; deliveryId: string; attemptId: string; target: DeliveryTarget; artifact: Artifact; content: Buffer }): Promise<string>;
}
interface DeliveryRow { id: string; user_id: string; artifact_id: string; channel: DeliveryChannel;
  target_json: string; status: DeliveryStatus; error: string | null; created_at: number; updated_at: number }
interface AttemptRow { id: string; number: number; status: DeliveryStatus; error: string | null; external_id: string | null; started_at: number; finished_at: number | null }
const viewAttempt = (r: AttemptRow): DeliveryAttempt => ({ id: r.id, number: r.number, status: r.status, error: r.error, externalId: r.external_id, startedAt: r.started_at, finishedAt: r.finished_at });
const row = (id: string) => db.prepare('SELECT * FROM artifact_deliveries WHERE id=?').get(id) as DeliveryRow | undefined;
const view = (r: DeliveryRow): ArtifactDelivery => ({ id: r.id, artifactId: r.artifact_id, channel: r.channel,
  status: r.status, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
  attempts: (db.prepare('SELECT * FROM artifact_delivery_attempts WHERE delivery_id=? ORDER BY number').all(r.id) as AttemptRow[]).map(viewAttempt) });
async function transport(): Promise<DeliveryTransport> { return (await import('./messaging.js')).messagingDeliveryTransport; }

export function getDelivery(userId: string, deliveryId: string) {
  const r = row(deliveryId);
  if (!r || r.user_id !== userId) throw new DeliverableError('Not found.', 404);
  getArtifact(userId, r.artifact_id);
  return view(r);
}
export function listDeliveries(userId: string, artifactId: string) {
  getArtifact(userId, artifactId);
  return (db.prepare('SELECT * FROM artifact_deliveries WHERE artifact_id=? AND user_id=? ORDER BY created_at DESC,id DESC LIMIT 100').all(artifactId, userId) as DeliveryRow[]).map(view);
}
export function getDeliveryTarget(userId: string, deliveryId: string): DeliveryTarget {
  getDelivery(userId, deliveryId);
  return JSON.parse(row(deliveryId)!.target_json);
}

export async function requestDelivery(input: { userId: string; artifactId: string; channel: DeliveryChannel; idempotencyKey?: string; approvedTarget?: DeliveryTarget }, adapter?: DeliveryTransport): Promise<ArtifactDelivery> {
  const a = getArtifact(input.userId, input.artifactId);
  writeOwner(input.userId, a.botId);
  if (!['library', 'imessage', 'sms', 'whatsapp'].includes(input.channel)) throw new DeliverableError('Unsupported delivery channel.');
  const key = input.idempotencyKey ?? null;
  if (key !== null && (!key || key.length > 200 || /[^\x21-\x7e]/.test(key))) throw new DeliverableError('Invalid delivery idempotency key.');
  const existing = () => key ? db.prepare('SELECT * FROM artifact_deliveries WHERE user_id=? AND idempotency_key=?').get(input.userId, key) as DeliveryRow | undefined : undefined;
  const checkExisting = (r: DeliveryRow) => {
    if (r.artifact_id !== a.id || r.channel !== input.channel) throw new DeliverableError('Idempotency key already belongs to another delivery.', 409);
    if (input.approvedTarget && targetIdentity(input.approvedTarget) !== targetIdentity(JSON.parse(r.target_json))) throw new DeliverableError('Approved delivery destination changed.', 409);
    return view(r);
  };
  const prior = existing();
  if (prior) return checkExisting(prior);
  const target: DeliveryTarget = input.channel === 'library' ? { channel: 'library' } : await (adapter ?? await transport()).prepare(input.userId, input.channel);
  if (target.channel !== input.channel) throw new DeliverableError('Delivery target mismatch.');
  if (input.approvedTarget && targetIdentity(input.approvedTarget) !== targetIdentity(target)) throw new DeliverableError('Approved delivery destination changed. Request approval again.', 409);
  return db.transaction(() => {
    const raced = existing();
    if (raced) return checkExisting(raced);
    writeOwner(input.userId, a.botId);
    const id = newId('delivery'), at = now();
    db.prepare("INSERT INTO artifact_deliveries(id,user_id,artifact_id,channel,target_json,idempotency_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?)")
      .run(id, input.userId, a.id, input.channel, JSON.stringify(target), key, at, at);
    return getDelivery(input.userId, id);
  })();
}

/** Atomic pending->sending claim. A live or uncertain claim is never stolen on a timeout. */
function claim(deliveryId: string) {
  return db.transaction(() => {
    const r = row(deliveryId);
    if (!r || r.status !== 'pending') return null;
    const a = getArtifact(r.user_id, r.artifact_id);
    writeOwner(r.user_id, a.botId);
    const at = now(), attemptId = newId('delivery_attempt');
    if (!db.prepare("UPDATE artifact_deliveries SET status='sending',error=NULL,updated_at=? WHERE id=? AND status='pending'").run(at, r.id).changes) return null;
    const number = (db.prepare('SELECT COALESCE(MAX(number),0)+1 n FROM artifact_delivery_attempts WHERE delivery_id=?').get(r.id) as { n: number }).n;
    db.prepare("INSERT INTO artifact_delivery_attempts(id,delivery_id,number,status,started_at,owner_pid,owner_birth) VALUES(?,?,?,'sending',?,?,?)")
      .run(attemptId, r.id, number, at, process.pid, ownerBirth);
    return { delivery: r, attemptId };
  })();
}

export async function sendDelivery(userId: string, deliveryId: string, adapter?: DeliveryTransport): Promise<ArtifactDelivery> {
  getDelivery(userId, deliveryId);
  const claimed = claim(deliveryId);
  if (!claimed) return getDelivery(userId, deliveryId);
  const r = claimed.delivery;
  let status: DeliveryStatus = 'delivered', externalId: string | null = null, error: string | null = null;
  let invoked = false;
  try {
    const saved = readArtifact(userId, r.artifact_id);
    writeOwner(userId, saved.artifact.botId);
    if (r.channel !== 'library') {
      const sender = adapter ?? await transport();
      invoked = true;
      externalId = await sender.send({ userId, deliveryId, attemptId: claimed.attemptId, target: JSON.parse(r.target_json), ...saved });
      if (!externalId) throw new Error('Provider did not acknowledge delivery.');
    }
  } catch (e) {
    // Translated from Hermes cron/delivery_queue.py:282-355: uncertain sends are
    // terminal, not retries. Only an explicit pre-send refusal is safely retryable.
    status = !invoked || e instanceof DeliveryNotSentError ? 'failed' : 'unknown';
    error = e instanceof DeliveryNotSentError || !invoked ? 'Delivery was not sent. Check the saved file and channel connection, then retry.' : 'Send outcome is unknown. It was not retried; verify with the recipient.';
  }
  db.transaction(() => {
    const changed = db.prepare("UPDATE artifact_delivery_attempts SET status=?,error=?,external_id=?,finished_at=? WHERE id=? AND status='sending'")
      .run(status, error, externalId, now(), claimed.attemptId).changes;
    if (changed) db.prepare("UPDATE artifact_deliveries SET status=?,error=?,updated_at=? WHERE id=? AND status='sending'").run(status, error, now(), deliveryId);
  })();
  return getDelivery(userId, deliveryId);
}

export function retryDelivery(userId: string, deliveryId: string): ArtifactDelivery {
  return db.transaction(() => {
    const d = getDelivery(userId, deliveryId), a = getArtifact(userId, d.artifactId);
    writeOwner(userId, a.botId);
    if (d.status !== 'failed') throw new DeliverableError('Only definitely not-sent deliveries can retry. Unknown sends require verification.', 409);
    db.prepare("UPDATE artifact_deliveries SET status='pending',error=NULL,updated_at=? WHERE id=? AND status='failed'").run(now(), deliveryId);
    return getDelivery(userId, deliveryId);
  })();
}

export function recoverDeliveries() {
  let count = 0;
  const writable = legacyWritableRows(db, 'artifact_delivery_attempts');
  const deliveryWritable = legacyWritableRows(db, 'artifact_deliveries');
  for (const a of db.prepare(`SELECT id,delivery_id,owner_pid,owner_birth FROM artifact_delivery_attempts WHERE status='sending' AND ${writable}`).all() as { id: string; delivery_id: string; owner_pid: number; owner_birth: string }[]) {
    if (ownerAlive(a.owner_pid, a.owner_birth)) continue;
    count += db.transaction(() => {
      const error = 'Delivery owner was lost. Send outcome is unknown and was not retried.';
      const changed = db.prepare(`UPDATE artifact_delivery_attempts SET status='unknown',error=?,finished_at=? WHERE id=? AND status='sending' AND ${writable}`).run(error, now(), a.id).changes;
      if (changed) db.prepare(`UPDATE artifact_deliveries SET status='unknown',error=?,updated_at=? WHERE id=? AND status='sending' AND ${deliveryWritable}`).run(error, now(), a.delivery_id);
      return changed;
    })();
  }
  return count;
}

export async function drainDeliveries(limit = 20, adapter?: DeliveryTransport) {
  // Exclude held owners BEFORE applying the batch limit, so their frozen oldest
  // deliveries cannot starve another account. Recheck after each awaited send.
  const pending = db.prepare(`SELECT id,user_id FROM artifact_deliveries WHERE status='pending' AND ${legacyWritableRows(db, 'artifact_deliveries')} ORDER BY created_at,id LIMIT ?`).all(Math.max(0, Math.min(limit, 100))) as { id: string; user_id: string }[];
  let count = 0;
  for (const r of pending) {
    if (!db.prepare(`SELECT 1 FROM artifact_deliveries WHERE id=? AND status='pending' AND ${legacyWritableRows(db, 'artifact_deliveries')}`).get(r.id)) continue;
    await sendDelivery(r.user_id, r.id, adapter);
    count++;
  }
  return count;
}

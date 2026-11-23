import { isTenant, tenantId } from './deployment.js';
import { gatewayRequest } from './runtime/gateway-client.js';
import { db, now } from './db.js';
import { APPS_OFF, composio } from './composio.js';
import { env } from './env.js';
import { hub } from './lib/hub.js';
import { waitForTriggerSubscription } from './trigger-subscription.js';
import { checkRoutineCreate } from './routine-limits.js';
import { retainTriggerEvent, drainTriggerEvents } from './trigger-events.js';

/**
 * Event routines: Composio triggers (e.g. GMAIL_NEW_GMAIL_MESSAGE, SLACK_RECEIVE_MESSAGE,
 * GITHUB_PULL_REQUEST_EVENT) that wake a bot with a prompt. Stored in the `routines` table
 * with schedule `event:<TRIGGER_SLUG>` so they show up alongside cron routines.
 * Delivery uses Composio's realtime subscription (no public webhook URL needed).
 */

let enqueueFn: ((botId: string, t: any) => string | void) | null = null;
let drainTimer: ReturnType<typeof setInterval> | undefined;
let drainScheduled = false;
let subscribed = false;
let subscriptionAttempt: Promise<void> | null = null;
const routineChanges = new Map<string, Promise<void>>();
let subscriptionClient: ReturnType<typeof composio> | null = null;
let subscriptionChange: Promise<void> = Promise.resolve();

export const isEventSchedule = (schedule: string) => schedule.startsWith('event:');

export async function initTriggers(enqueue: (botId: string, t: any) => string | void) {
  enqueueFn = enqueue;
  drainTimer ??= setInterval(() => drainTriggerEvents(enqueueFn!), 1000).unref();
  drainTriggerEvents(enqueue);
  await reconcileEventRoutines();
}

async function ensureSubscribed() {
  if (isTenant || subscribed) return;
  if (subscriptionAttempt) return subscriptionAttempt;
  const client = composio();
  subscriptionAttempt = Promise.resolve().then(async () => {
    try {
      await subscriptionClient?.triggers.unsubscribe();
      subscriptionClient = client;
      let failed = false;
      await client.triggers.subscribe(
        (data: any) => { if (subscriptionClient === client) onTrigger(data); },
        undefined,
        () => {
          if (subscriptionClient !== client) return;
          failed = true;
          subscribed = false;
          failActiveSubscriptions();
        },
      );
      if (failed) throw new Error('Event subscription failed.');
      await waitForTriggerSubscription(client);
      if (failed) throw new Error('Event subscription failed.');
      subscribed = true;
      console.log('[triggers] realtime subscription active');
    } catch (e) {
      subscribed = false;
      subscriptionClient = null;
      await client.triggers.unsubscribe().catch(() => {});
      throw e;
    } finally { subscriptionAttempt = null; }
  });
  return subscriptionAttempt;
}

/** Only idempotent subscription/toggle operations are retried, never trigger creation. */
async function retryChange(change: () => Promise<unknown>) {
  for (let attempt = 0; ; attempt++) {
    try { await change(); return; }
    catch (e) {
      if (attempt === 2) throw e;
      await new Promise(resolve => setTimeout(resolve, 100 * 3 ** attempt));
    }
  }
}

function emitRoutine(routineId: string) {
  const row = db.prepare('SELECT r.bot_id,b.user_id FROM routines r JOIN bots b ON b.id=r.bot_id WHERE r.id=?').get(routineId) as any;
  if (row) hub.emit(row.user_id, { type: 'routines', botId: row.bot_id });
}

function failActiveSubscriptions() {
  const rows = db.prepare("SELECT id FROM routines WHERE schedule LIKE 'event:%' AND enabled=1").all() as { id: string }[];
  db.prepare("UPDATE routines SET enabled=0,activation_target=COALESCE(activation_target,1),activation_error=? WHERE schedule LIKE 'event:%' AND enabled=1")
    .run('Event delivery could not connect. Check the connected app and retry.');
  for (const row of rows) emitRoutine(row.id);
}

/** Reapply saved intent after a crash, including provider changes made before a local commit. */
async function reconcileEventRoutines() {
  const rows = db.prepare("SELECT id,COALESCE(activation_target,enabled) target FROM routines WHERE schedule LIKE 'event:%'").all() as { id: string; target: number }[];
  // Do not advertise enabled routines while their delivery subscription is being restored.
  db.prepare("UPDATE routines SET activation_target=COALESCE(activation_target,enabled),enabled=0 WHERE schedule LIKE 'event:%' AND enabled=1 AND COALESCE(activation_target,enabled)=1").run();
  await Promise.allSettled(rows.map(row => setEventRoutineEnabled(row.id, !!row.target)));
}

/** Live key changes must reconnect event delivery to the current project too. */
export function refreshTriggerSubscription(): Promise<void> {
  if (isTenant) return Promise.resolve();
  subscriptionChange = subscriptionChange.catch(() => {}).then(async () => {
    await subscriptionAttempt?.catch(() => {});
    const next = env.composioEnabled ? composio() : null;
    if (subscriptionClient === next && subscribed) return;
    const previous = subscriptionClient;
    subscriptionClient = null;
    subscribed = false;
    await previous?.triggers.unsubscribe();
    if (!next) { failActiveSubscriptions(); return; }
    if (!enqueueFn) return;
    const active = db.prepare("SELECT 1 FROM routines WHERE schedule LIKE 'event:%' AND enabled=1 LIMIT 1").get();
    if (active) {
      try { await retryChange(ensureSubscribed); }
      catch {
        failActiveSubscriptions();
        throw new Error('Event delivery could not connect. Check the connected app and retry.');
      }
    }
  });
  return subscriptionChange;
}

export function onTrigger(data: any, deliveryId?: string) {
  retainTriggerEvent(data, deliveryId);
  // The inbox's outer transaction must commit before any model work can start.
  if (drainScheduled) return;
  drainScheduled = true;
  queueMicrotask(() => {
    drainScheduled = false;
    if (enqueueFn) drainTriggerEvents(enqueueFn);
  });
}

export async function listTriggerTypes(toolkit: string) {
  const r: any = isTenant ? await gatewayRequest(tenantId, 'trigger-types', { toolkit }) : await composio().triggers.listTypes({ toolkits: [toolkit] } as any);
  const items: any[] = r?.items ?? r ?? [];
  return items.slice(0, 40).map((t) => ({
    slug: t.slug,
    name: t.name,
    description: String(t.description ?? '').slice(0, 300),
    config: t.config?.properties ? { properties: t.config.properties, required: t.config.required ?? [] } : t.config ?? {},
  }));
}

export async function createEventRoutine(userId: string, botId: string, a: { name: string; prompt: string; trigger_slug: string; config?: Record<string, unknown> }) {
  if (!env.composioEnabled) throw new Error(APPS_OFF);
  // A failed initial connection must not create an orphaned active provider trigger.
  try { await retryChange(ensureSubscribed); }
  catch { throw new Error('Routine activation failed. Check the connected app and try again.'); }
  const slug = a.trigger_slug.toUpperCase();
  const res: any = isTenant ? await gatewayRequest(userId, 'trigger-create', { slug, config: a.config ?? {} }) : await composio().triggers.create(userId, slug, { triggerConfig: a.config ?? {} } as any);
  const triggerId = res?.triggerId ?? res?.trigger_id ?? res?.id;
  if (!triggerId) throw new Error(`Composio did not return a trigger id: ${JSON.stringify(res).slice(0, 200)}`);
  const id = `rt_${Math.random().toString(36).slice(2, 12)}`;
  db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at,trigger_id,trigger_config,activation_target) VALUES (?,?,?,?,?,?,0,?,?,?,1)')
    .run(id, botId, a.name, a.prompt, `event:${slug}`, 'UTC', now(), triggerId, JSON.stringify(a.config ?? {}));
  await setEventRoutineEnabled(id, true);
  return { id, triggerId };
}

/** Serialize changes per routine so a slow enable cannot overtake a later pause. */
export function setEventRoutineEnabled(routineId: string, enabled: boolean): Promise<void> {
  const previous = routineChanges.get(routineId) ?? Promise.resolve();
  const change = previous.catch(() => {}).then(async () => {
    const r = db.prepare('SELECT * FROM routines WHERE id=?').get(routineId) as any;
    if (!r) throw new Error('Routine not found.');
    // Pending activation reserves a slot while enabled remains false. Recheck after queued changes.
    if (enabled && !r.enabled && r.activation_target !== 1) {
      const limit = checkRoutineCreate(r.bot_id, r.schedule, { timezone: r.timezone, excludeRoutineId: routineId });
      if (limit) throw new Error(limit);
    }
    db.prepare('UPDATE routines SET activation_target=?,activation_error=NULL WHERE id=?').run(enabled ? 1 : 0, routineId);
    if (enabled) db.prepare('UPDATE routines SET enabled=0 WHERE id=?').run(routineId);
    emitRoutine(routineId);
    try {
      if (!r.trigger_id) throw new Error('Missing provider trigger.');
      if (!env.composioEnabled) throw new Error(APPS_OFF);
      await retryChange(async () => {
        if (isTenant) {
          await gatewayRequest(tenantId, enabled ? 'trigger-enable' : 'trigger-disable', { triggerId: r.trigger_id });
        } else {
          // Connect delivery before enabling the provider, and share in-flight subscription setup.
          if (enabled) { await ensureSubscribed(); await composio().triggers.enable(r.trigger_id); }
          else await composio().triggers.disable(r.trigger_id);
        }
      });
      if (enabled && !isTenant && !subscribed) throw new Error('Event subscription failed.');
      db.prepare('UPDATE routines SET enabled=?,activation_target=NULL,activation_error=NULL WHERE id=?').run(enabled ? 1 : 0, routineId);
    } catch {
      const message = enabled
        ? 'Routine activation failed. Check the connected app and retry.'
        : 'Routine pause failed. Check the connected app and retry.';
      db.prepare('UPDATE routines SET activation_error=? WHERE id=?').run(message, routineId);
      throw new Error(message);
    } finally { emitRoutine(routineId); }
  });
  routineChanges.set(routineId, change);
  // Attach both handlers without creating an unhandled rejected cleanup promise.
  void change.then(() => cleanup(), () => cleanup());
  function cleanup() { if (routineChanges.get(routineId) === change) routineChanges.delete(routineId); }
  return change;
}

export function describeEvent(schedule: string) {
  const slug = schedule.slice(6);
  const words = slug.split('_');
  const app = words.shift() ?? '';
  return `When ${app.charAt(0) + app.slice(1).toLowerCase()}: ${words.join(' ').toLowerCase()}`;
}

/** Remove the Composio trigger behind an event routine (call before deleting the routine row). */
export async function deleteEventTrigger(routineId: string) {
  const r = db.prepare('SELECT trigger_id FROM routines WHERE id=?').get(routineId) as any;
  if (!r?.trigger_id) return;
  if (isTenant) { await gatewayRequest(tenantId, 'trigger-delete', { triggerId: r.trigger_id }); return; }
  try { await composio().triggers.delete(r.trigger_id); } catch (e) { console.warn('[triggers] delete failed', routineId, (e as Error).message); }
}

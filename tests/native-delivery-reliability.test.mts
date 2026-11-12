// Run: node --import tsx --test --test-concurrency=1 tests/native-delivery-reliability.test.mts
// Real authenticated routes, SQLite, immutable artifact bytes and delivery runtime.
// Only channel preparation/sending is mocked; every network request is forbidden.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import type { DeliveryTarget, DeliveryTransport } from '../server/src/deliverables/delivery.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-delivery-reliability-'));
Object.assign(process.env, {
  DB_PATH: path.join(root, 'app.db'), FILES_DIR: path.join(root, 'files'),
  SWARM_ROLE: 'standalone', SWARM_NO_SCHEDULER: '1', NODE_ENV: 'test',
  SESSION_SECRET: 'delivery-first-process-test-secret', COMPUTER_PROVIDER: 'local',
  APP_URL: 'http://localhost:3000', SERVER_URL: 'http://localhost:3000',
  COMPOSIO_API_KEY: '', OPENROUTER_API_KEY: '', DIRECT_API_KEY: '',
  ADMIN_EMAILS: '', ADMIN_PHONES: '', INKBOX_TUNNEL: '0', WHATSAPP_DISABLED: '1',
});
mock.method(globalThis, 'fetch', async () => { throw new Error('Delivery reliability tests forbid network effects'); });
const { db } = await import('../server/src/db.js');
const d = await import('../server/src/deliverables/index.js');
const { messagingDeliveryTransport } = await import('../server/src/deliverables/messaging.js');
const { deliverablesApi } = await import('../server/src/routes-deliverables.js');
const { Hono } = await import('hono');
const app = new Hono().route('/api/deliverables', deliverablesApi);

type Mode = 'acknowledged' | 'not_sent' | 'unknown';
interface Fixture {
  userId: string; botId: string; cookie: string; target: DeliveryTarget; mode: Mode;
  prepares: number; sends: Parameters<DeliveryTransport['send']>[0][];
  failures: Map<string, Mode>;
}
const fixtures = new Map<string, Fixture>();
let sequence = 0;
mock.method(messagingDeliveryTransport, 'prepare', async (userId, channel) => {
  const f = fixtures.get(userId)!;
  assert.ok(f, 'only known disposable accounts may prepare a channel');
  assert.equal(channel, f.target.channel); f.prepares++;
  return structuredClone(f.target);
});
mock.method(messagingDeliveryTransport, 'send', async input => {
  const f = fixtures.get(input.userId)!;
  assert.ok(f, 'only known disposable accounts may send to a mock channel');
  f.sends.push(input);
  const mode = f.failures.get(input.deliveryId) ?? f.mode;
  if (mode === 'not_sent') throw new d.DeliveryNotSentError('Mock refused before any external write');
  if (mode === 'unknown') throw new Error('Mock lost acknowledgement; no external write was performed');
  return `mock-provider-${input.attemptId}`;
});
let stopRuntime: (() => void) | undefined;
after(() => { stopRuntime?.(); mock.restoreAll(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function fixture(label: string): Fixture {
  const userId = `delivery-${label}-${++sequence}`, botId = `bot-${userId}`, token = `${userId}-token`;
  const at = Date.now();
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(userId, `${userId}@example.test`, label, at);
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(botId, userId, label, at, at);
  db.prepare('INSERT INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(token, userId, at, at + 3600000);
  const f: Fixture = { userId, botId, cookie: `swarm_session=${token}`, mode: 'acknowledged', prepares: 0, sends: [], failures: new Map(),
    target: { channel: 'sms', transport: 'mock-only', phone: '+15550001000', chatRef: 'original-recipient', revision: 'link-v1' } };
  fixtures.set(userId, f); return f;
}
function artifact(f: Fixture, filename = 'report.md') {
  return d.recordArtifact({ userId: f.userId, botId: f.botId, filename, content: `Immutable report for ${f.userId}\nOwner: Quinn. Source: original evidence.` });
}
async function http(f: Fixture, method: string, url: string, body?: unknown, key?: string, expected = 200) {
  const response = await app.request(`/api/deliverables${url}`, { method,
    headers: { cookie: f.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json() as any;
  assert.equal(response.status, expected, `${method} ${url}: ${JSON.stringify(value)}`);
  return value;
}
const preview = async (f: Fixture, a: ReturnType<typeof artifact>) => (await http(f, 'POST', `/artifacts/${a.id}/delivery-preview`, { channel: 'sms' })).destination;
const retryPreview = async (f: Fixture, id: string) => (await http(f, 'POST', `/deliveries/${id}/retry-preview`, {})).destination;
const key = () => `delivery-action-${++sequence}`;
const latest = (delivery: { attempts: { id: string }[] }) => delivery.attempts.at(-1)!.id;
const changeTarget = (f: Fixture) => { f.target = { ...f.target, phone: '+15550009999', chatRef: 'changed-recipient', revision: 'link-v2' }; };

test('HTTP preview pins recipient, connection revision and immutable artifact; stale approval never sends', async () => {
  const f = fixture('stale'), a = artifact(f), destination = await preview(f, a);
  assert.deepEqual(destination.target, f.target); assert.equal(destination.artifact_sha256, a.sha256);
  assert.match(destination.recipient, /15550001000/); assert.ok(destination.proof);
  const original = structuredClone(f.target);
  // Even a relink to the same address requires fresh destination approval.
  f.target = { ...original, revision: 'relinked-same-address' };
  await http(f, 'POST', `/artifacts/${a.id}/deliveries`, { channel: 'sms', destination }, key(), 409);
  changeTarget(f);
  await http(f, 'POST', `/artifacts/${a.id}/deliveries`, { channel: 'sms', destination }, key(), 409);
  f.target = original;
  for (const forged of [
    { ...destination, proof: `${destination.proof.slice(0, -1)}!` },
    { ...destination, artifact_sha256: '0'.repeat(64) },
    { ...destination, recipient: 'An unapproved recipient label' },
  ]) await http(f, 'POST', `/artifacts/${a.id}/deliveries`, { channel: 'sms', destination: forged }, key(), 409);
  assert.equal(f.sends.length, 0);
  assert.equal(d.listDeliveries(f.userId, a.id).length, 0);
  assert.equal((db.prepare('SELECT count(*) n FROM artifact_delivery_commands WHERE user_id=?').get(f.userId) as any).n, 0);
});

test('HTTP exact-key replay precedes changed-target validation and binds the full approved request', async () => {
  const f = fixture('replay'), a = artifact(f), destination = await preview(f, a), actionKey = key();
  const body = { channel: 'sms', destination };
  const first = (await http(f, 'POST', `/artifacts/${a.id}/deliveries`, body, actionKey)).delivery;
  assert.equal(first.status, 'delivered'); assert.equal(first.acknowledgement, 'provider');
  assert.equal(first.attempts.length, 1); assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0].target, destination.target);
  assert.deepEqual(f.sends[0].content, d.readArtifact(f.userId, a.id).content);
  changeTarget(f); const prepares = f.prepares;
  const replay = (await http(f, 'POST', `/artifacts/${a.id}/deliveries`, body, actionKey)).delivery;
  assert.deepEqual(replay, first); assert.equal(f.prepares, prepares, 'accepted key must resolve without preparing the new recipient');
  assert.equal(f.sends.length, 1);
  await http(f, 'POST', `/artifacts/${a.id}/deliveries`, { ...body, destination: { ...destination, recipient: 'Changed body' } }, actionKey, 409);
  await http(f, 'POST', `/artifacts/${artifact(f, 'another-report.md').id}/deliveries`, body, actionKey, 409);
  await http(f, 'POST', `/artifacts/${a.id}/deliveries`, body, key(), 409);
  assert.equal(f.sends.length, 1); assert.equal(d.getDelivery(f.userId, first.id).attempts.length, 1);
});

test('HTTP replay recovers accepted delivery identity even if its command receipt was not yet committed', async () => {
  const f = fixture('admission-crash'), a = artifact(f), destination = await preview(f, a), actionKey = key();
  // Crash boundary: durable delivery admission succeeded, HTTP command receipt/response did not.
  const accepted = await d.requestDelivery({ userId: f.userId, artifactId: a.id, channel: 'sms', idempotencyKey: actionKey, approvedTarget: destination.target });
  assert.equal(accepted.status, 'pending'); changeTarget(f); const prepares = f.prepares;
  const recovered = (await http(f, 'POST', `/artifacts/${a.id}/deliveries`, { channel: 'sms', destination }, actionKey)).delivery;
  assert.equal(recovered.id, accepted.id); assert.equal(recovered.status, 'pending');
  assert.equal(f.prepares, prepares); assert.equal(f.sends.length, 0);
  assert.equal(d.listDeliveries(f.userId, a.id).length, 1);
  await d.sendDelivery(f.userId, accepted.id);
  assert.equal(f.sends.length, 1); assert.deepEqual(f.sends[0].target, destination.target);
});

test('failed HTTP retries retain stable identities and reject a stale latest-attempt guard', async () => {
  const f = fixture('retry'), a = artifact(f), destination = await preview(f, a); f.mode = 'not_sent';
  const first = (await http(f, 'POST', `/artifacts/${a.id}/deliveries`, { channel: 'sms', destination }, key())).delivery;
  assert.equal(first.status, 'failed'); assert.equal(f.sends.length, 1);
  const pinnedRetry = await retryPreview(f, first.id);
  assert.notEqual(pinnedRetry.proof, destination.proof, 'an initial-send proof cannot approve a retry');
  const route = `/deliveries/${first.id}/retry`;
  await http(f, 'POST', route, { destination: pinnedRetry, expectedAttemptId: 'stale-attempt' }, key(), 409);
  assert.equal(f.sends.length, 1);
  const actionKey = key(), body = { destination: pinnedRetry, expectedAttemptId: latest(first) };
  const second = (await http(f, 'POST', route, body, actionKey)).delivery;
  assert.equal(second.status, 'failed'); assert.equal(second.attempts.length, 2); assert.equal(f.sends.length, 2);
  const original = structuredClone(f.target); changeTarget(f); const prepares = f.prepares;
  assert.deepEqual((await http(f, 'POST', route, body, actionKey)).delivery, second);
  assert.equal(f.prepares, prepares); assert.equal(f.sends.length, 2, 'replaying a failed retry must not try again');
  f.target = original;
  await http(f, 'POST', route, body, key(), 409);
  assert.equal(f.sends.length, 2); assert.equal(d.getDelivery(f.userId, first.id).attempts.length, 2);
  f.mode = 'acknowledged';
  const finalKey = key(), finalBody = { destination: await retryPreview(f, first.id), expectedAttemptId: latest(second) };
  const final = (await http(f, 'POST', route, finalBody, finalKey)).delivery;
  assert.equal(final.status, 'delivered'); assert.deepEqual(final.attempts.map((a: any) => a.status), ['failed', 'failed', 'delivered']);
  changeTarget(f);
  assert.deepEqual((await http(f, 'POST', route, finalBody, finalKey)).delivery, final);
  await http(f, 'POST', route, { ...finalBody, expectedAttemptId: latest(first) }, finalKey, 409);
  assert.equal(f.sends.length, 3);
  assert.equal(new Set(f.sends.map(s => s.attemptId)).size, 3);
});

for (const outcome of ['delivered', 'not_sent'] as const) test(`unknown HTTP reconciliation (${outcome}) is owner scoped, append-only and never sends`, async () => {
  const f = fixture(`unknown-${outcome}`), other = fixture(`foreign-${outcome}`), a = artifact(f), destination = await preview(f, a);
  f.mode = 'unknown'; const sendKey = key(), sendBody = { channel: 'sms', destination };
  const uncertain = (await http(f, 'POST', `/artifacts/${a.id}/deliveries`, sendBody, sendKey)).delivery;
  assert.equal(uncertain.status, 'unknown'); assert.equal(uncertain.acknowledgement, null); assert.equal(f.sends.length, 1);
  const attempt = structuredClone(uncertain.attempts), route = `/deliveries/${uncertain.id}/reconcile`;
  const actionKey = key(), body = { outcome, evidence: 'Provider audit reference mock-123 confirms the outcome.', expectedAttemptId: latest(uncertain) };
  await http(other, 'GET', `/deliveries/${uncertain.id}`, undefined, undefined, 404);
  await http(other, 'POST', route, body, actionKey, 404);
  await http(other, 'POST', `/deliveries/${uncertain.id}/retry-preview`, {}, undefined, 404);
  await http(other, 'POST', `/deliveries/${uncertain.id}/retry`, { destination, expectedAttemptId: latest(uncertain) }, key(), 404);
  await http(f, 'POST', `/deliveries/${uncertain.id}/retry-preview`, {}, undefined, 409);
  await http(f, 'POST', `/deliveries/${uncertain.id}/retry`, { destination, expectedAttemptId: latest(uncertain) }, key(), 409);
  await http(f, 'POST', route, { ...body, expectedAttemptId: 'stale-attempt' }, key(), 409);
  await http(f, 'POST', route, { ...body, evidence: '   ' }, key(), 400);
  assert.deepEqual(d.getDelivery(f.userId, uncertain.id).reconciliations, []);
  assert.deepEqual(d.getDelivery(f.userId, uncertain.id).attempts, attempt);
  const reconciled = (await http(f, 'POST', route, body, actionKey)).delivery;
  assert.equal(reconciled.status, outcome === 'delivered' ? 'delivered' : 'failed');
  assert.equal(reconciled.acknowledgement, outcome === 'delivered' ? 'owner' : null);
  assert.deepEqual(reconciled.attempts, attempt, 'owner attestation must not rewrite the original unknown provider attempt');
  assert.equal(reconciled.reconciliations.length, 1);
  assert.deepEqual({ ...reconciled.reconciliations[0], id: undefined, createdAt: undefined },
    { id: undefined, createdAt: undefined, outcome, evidence: body.evidence, attemptId: latest(uncertain) });
  assert.deepEqual((await http(f, 'POST', route, body, actionKey)).delivery, reconciled);
  await http(f, 'POST', route, { ...body, evidence: 'Attempt to replace accepted evidence.' }, actionKey, 409);
  await http(f, 'POST', route, { ...body, outcome: outcome === 'delivered' ? 'not_sent' : 'delivered' }, key(), 409);
  await http(f, 'POST', route, body, key(), 409);
  await http(other, 'POST', route, body, actionKey, 404);
  assert.deepEqual((await http(f, 'GET', `/deliveries/${uncertain.id}`)).delivery, reconciled);
  assert.deepEqual((await http(f, 'POST', `/artifacts/${a.id}/deliveries`, sendBody, sendKey)).delivery, reconciled);
  assert.equal(f.sends.length, 1, 'reconciliation, conflicts and original-key replay must never invoke transport');
  assert.equal(other.sends.length, 0);
  if (outcome === 'not_sent') {
    f.mode = 'acknowledged';
    const retried = (await http(f, 'POST', `/deliveries/${uncertain.id}/retry`, { destination: await retryPreview(f, uncertain.id), expectedAttemptId: latest(uncertain) }, key())).delivery;
    assert.equal(retried.status, 'delivered'); assert.equal(f.sends.length, 2, 'only a separately confirmed explicit retry may send');
    assert.deepEqual(retried.attempts[0], attempt[0]); assert.equal(retried.attempts[1].status, 'delivered');
    assert.deepEqual(retried.reconciliations, reconciled.reconciliations);
  }
});

test('HTTP destination signing proof survives a fresh process with a different SESSION_SECRET', async () => {
  const f = fixture('restart-proof'), a = artifact(f), destination = await preview(f, a);
  const moduleUrl = (file: string) => pathToFileURL(path.join(import.meta.dirname, '../server/src', file)).href;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import fs from 'node:fs';
    const input=JSON.parse(fs.readFileSync(0,'utf8'));
    globalThis.fetch=async()=>{throw new Error('Fresh process forbids external effects');};
    const {db}=await import(${JSON.stringify(moduleUrl('db.ts'))});
    const {messagingDeliveryTransport}=await import(${JSON.stringify(moduleUrl('deliverables/messaging.ts'))});
    let sends=0;
    messagingDeliveryTransport.prepare=async()=>input.destination.target;
    messagingDeliveryTransport.send=async()=>{sends++;return 'mock-restarted-provider';};
    const {deliverablesApi}=await import(${JSON.stringify(moduleUrl('routes-deliverables.ts'))});
    const {Hono}=await import('hono');
    const app=new Hono().route('/api/deliverables',deliverablesApi);
    const headers={cookie:input.cookie,'content-type':'application/json','Idempotency-Key':input.key};
    const response=await app.request('/api/deliverables/artifacts/'+input.artifactId+'/deliveries',{method:'POST',headers,body:JSON.stringify({channel:'sms',destination:input.destination})});
    console.log('RELIABILITY_RESULT '+JSON.stringify({pid:process.pid,status:response.status,body:await response.json(),sends}));
    db.close();
  `], { env: { ...process.env, SESSION_SECRET: 'a-different-restarted-process-test-secret' },
    input: JSON.stringify({ artifactId: a.id, cookie: f.cookie, destination, key: key() }), encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stderr);
  const line = child.stdout.split('\n').find(line => line.startsWith('RELIABILITY_RESULT '));
  assert.ok(line, child.stdout); const result = JSON.parse(line.slice('RELIABILITY_RESULT '.length));
  assert.notEqual(result.pid, process.pid); assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.sends, 1); assert.equal(result.body.delivery.status, 'delivered');
  const saved = d.getDelivery(f.userId, result.body.delivery.id);
  assert.equal(saved.attempts.length, 1); assert.equal(saved.attempts[0].externalId, 'mock-restarted-provider');
  assert.deepEqual(d.getDeliveryTarget(f.userId, saved.id), destination.target);
});

test('continuous runtime drains more than 100 pending items despite an oldest claim failure and channel refusals', async () => {
  const f = fixture('backlog'), a = artifact(f), pending: string[] = [];
  for (let n = 0; n < 208; n++) {
    const delivery = await d.requestDelivery({ userId: f.userId, artifactId: a.id, channel: 'sms', idempotencyKey: key() });
    db.prepare('UPDATE artifact_deliveries SET created_at=? WHERE id=?').run(n + 1, delivery.id);
    pending.push(delivery.id);
  }
  const [claimFailure, refused, unknown, ...healthy] = pending;
  f.failures.set(refused, 'not_sent'); f.failures.set(unknown, 'unknown');
  // Inject a real SQLite claim failure in the oldest item. The actual drainer
  // must catch it and keep processing later records across successive batches.
  db.exec(`CREATE TEMP TRIGGER delivery_fixture_claim_failure BEFORE UPDATE OF status ON artifact_deliveries
    WHEN OLD.id='${claimFailure}' AND NEW.status='sending'
    BEGIN SELECT RAISE(ABORT,'fixture storage claim unavailable'); END;`);
  try {
    stopRuntime = d.startDeliveryRuntime(messagingDeliveryTransport, 10);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const count = (db.prepare("SELECT count(*) n FROM artifact_deliveries WHERE user_id=? AND status='delivered'").get(f.userId) as any).n;
      if (count === healthy.length) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(healthy.length, 205);
    for (const id of healthy) {
      const saved = d.getDelivery(f.userId, id);
      assert.equal(saved.status, 'delivered', `backlog item ${id} must advance without a manual drain`);
      assert.equal(saved.attempts.length, 1);
    }
    assert.equal(d.getDelivery(f.userId, refused).status, 'failed');
    assert.equal(d.getDelivery(f.userId, unknown).status, 'unknown');
    assert.equal(d.getDelivery(f.userId, claimFailure).status, 'pending');
    assert.equal(d.getDelivery(f.userId, claimFailure).attempts.length, 0);
    assert.equal(f.sends.length, 207);
    assert.equal(new Set(f.sends.map(send => send.deliveryId)).size, 207, 'failed/unknown sends must not repeat on later runtime ticks');
    assert.ok(f.sends.some(send => send.deliveryId === healthy.at(-1)), 'the runtime must continue beyond its first 100-item batch');
  } finally {
    stopRuntime?.(); stopRuntime = undefined;
    db.exec('DROP TRIGGER delivery_fixture_claim_failure');
  }
});

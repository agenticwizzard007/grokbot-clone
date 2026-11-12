import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-deliverables-'));
Object.assign(process.env, { DB_PATH: path.join(root, 'swarm.db'), FILES_DIR: path.join(root, 'files'),
  SESSION_SECRET: 'deliverables-test-only', COMPUTER_PROVIDER: 'local', APP_URL: 'http://localhost:3000', SERVER_URL: 'http://localhost:3000',
  COMPOSIO_API_KEY: '', OPENROUTER_API_KEY: '', DIRECT_API_KEY: '', INKBOX_TUNNEL: '0',
  ROUTINE_MIN_INTERVAL_MIN: '0', ROUTINE_PAUSE_IF_USER_IDLE_DAYS: '0' });

const { db } = await import('../server/src/db.js');
const { acceptJob, beginJob, finishJob } = await import('../server/src/agent/jobs.js');
const d = await import('../server/src/deliverables/index.js');
const { initRoutines, runRoutine, unscheduleRoutine } = await import('../server/src/routines.js');
const { Hono } = await import('hono');
const { deliverablesApi } = await import('../server/src/routes-deliverables.js');
import type { DeliveryTransport } from '../server/src/deliverables/delivery.js';

const owner = 'user_reports', other = 'user_foreign', bot = 'bot_reports', foreignBot = 'bot_foreign';
for (const [id, botId] of [[owner, bot], [other, foreignBot]]) {
  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, id, Date.now());
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run(botId, id, botId, Date.now(), Date.now());
}
const createdRoutines: string[] = [];
function routine(id: string) {
  db.prepare("INSERT INTO routines(id,bot_id,name,prompt,schedule,enabled,created_at) VALUES(?,?,?,'Make report','0 0 * * *',1,?)").run(id, bot, id, Date.now());
  createdRoutines.push(id); return id;
}
const enqueued: { jobId: string; trigger: any }[] = [];
let rejectEnqueue = false;
initRoutines((botId, trigger) => {
  if (rejectEnqueue) throw new Error('Queue unavailable');
  const jobId = acceptJob(botId, trigger).id;
  enqueued.push({ jobId, trigger });
  return jobId;
});
after(() => { for (const id of createdRoutines) unscheduleRoutine(id); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

function artifact(name = 'report.md', content = '# Saved report\nOriginal findings') {
  return d.recordArtifact({ userId: owner, botId: bot, filename: name, content });
}
function fakeTransport(send: DeliveryTransport['send']): DeliveryTransport {
  return { prepare: async (_userId, channel) => ({ channel, transport: 'test', phone: '15550001000', chatRef: 'original' }), send };
}

test('one durable routine fire/job; duplicates and overlapping manual runs do not enqueue or spend quotas', () => {
  const id = routine('routine_single'), before = enqueued.length;
  const first = runRoutine(id, 'schedule', { fireKey: 'scheduled:1234' });
  assert.equal(first.ok, true); assert.ok(first.runId); assert.ok(first.jobId);
  const duplicate = runRoutine(id, 'schedule', { fireKey: 'scheduled:1234' });
  assert.equal(duplicate.runId, first.runId); assert.equal(enqueued.length, before + 1);
  assert.equal(runRoutine(id, 'manual').ok, false);
  assert.equal((db.prepare('SELECT count(*) n FROM routine_runs WHERE routine_id=?').get(id) as any).n, 1);
  beginJob(first.jobId!);
  const started = d.onJobStarted({ jobId: first.jobId!, botId: bot });
  assert.equal(started?.status, 'running');
  const file = d.recordArtifact({ userId: owner, botId: bot, jobId: first.jobId, filename: 'routine-report.md', content: 'real file' });
  assert.equal(file.runId, first.runId);
  assert.equal(d.onJobFinished({ jobId: first.jobId!, botId: bot, status: 'completed' })?.status, 'completed');
  assert.equal(d.onJobStarted({ jobId: first.jobId!, botId: bot })?.status, 'completed', 'a duplicate hook must not reopen terminal work');
  assert.equal(runRoutine(id, 'schedule', { fireKey: 'scheduled:1234' }).runId, first.runId);
  assert.equal(enqueued.length, before + 1, 'a completed fire cannot regenerate');
});

test('queue admission failure rolls back fire claim, quota debit and last_run_at', () => {
  const id = routine('routine_rejected'); rejectEnqueue = true;
  try { assert.equal(runRoutine(id, 'manual', { fireKey: 'retry-admission' }).ok, false); } finally { rejectEnqueue = false; }
  assert.equal(d.listRoutineRuns(owner, bot, id).length, 0);
  assert.equal((db.prepare('SELECT count(*) n FROM routine_runs WHERE routine_id=?').get(id) as any).n, 0);
  assert.equal((db.prepare('SELECT last_run_at FROM routines WHERE id=?').get(id) as any).last_run_at, null);
  const accepted = runRoutine(id, 'manual', { fireKey: 'retry-admission' });
  assert.equal(accepted.ok, true);
});

test('approval/question descendants keep one routine open through restart and finish only after final descendant', () => {
  const id = routine('routine_descendants'), fired = runRoutine(id, 'manual');
  beginJob(fired.jobId!); d.onJobStarted({ jobId: fired.jobId!, botId: bot });
  db.prepare('INSERT OR REPLACE INTO pending_turns(bot_id,state) VALUES(?,?)').run(bot, JSON.stringify({ jobId: fired.jobId, approvalId: 'approval-test', calls: [] }));
  finishJob(fired.jobId!, true);
  assert.equal(d.onJobFinished({ jobId: fired.jobId!, botId: bot, status: 'completed' })?.status, 'waiting');
  assert.equal(runRoutine(id, 'manual').ok, false);
  d.recoverDeliverables();
  assert.equal(d.getRoutineRun(owner, fired.runId!).status, 'waiting', 'durable questions/approvals survive owner recovery');
  const resumed = acceptJob(bot, { type: 'resume', parentJobId: fired.jobId }).id;
  beginJob(resumed); assert.equal(d.onJobStarted({ jobId: resumed, botId: bot })?.id, fired.runId);
  db.prepare('DELETE FROM pending_turns WHERE bot_id=?').run(bot);
  const body = { type: 'card', card: 'question', jobId: resumed, question: 'Which format?', status: 'pending' };
  const generation = (db.prepare('SELECT generation FROM bots WHERE id=?').get(bot) as any).generation;
  db.prepare('INSERT INTO rows(bot_id,generation,seq,updated_seq,kind,body,created_at) VALUES(?,?,9001,9001,?,?,?)').run(bot, generation, 'card', JSON.stringify(body), Date.now());
  finishJob(resumed, true);
  assert.equal(d.onJobFinished({ jobId: resumed, botId: bot, status: 'completed' })?.status, 'waiting');
  const answer = acceptJob(bot, { type: 'user', text: 'Markdown', parentJobId: resumed }).id;
  db.prepare('UPDATE rows SET body=? WHERE bot_id=? AND seq=9001').run(JSON.stringify({ ...body, status: 'answered', answerJobId: answer }), bot);
  d.recoverDeliverables();
  assert.equal(d.getRoutineRun(owner, fired.runId!).status, 'waiting', 'queued answer must not become an unknown old parent');
  beginJob(answer); d.onJobStarted({ jobId: answer, botId: bot });
  const saved = d.recordArtifact({ userId: owner, botId: bot, jobId: answer, filename: 'descendant.md', content: 'final descendant bytes' });
  assert.equal(saved.runId, fired.runId);
  finishJob(answer, true);
  assert.equal(d.onJobFinished({ jobId: answer, botId: bot, status: 'completed' })?.status, 'completed');
  assert.deepEqual(d.listRoutineRuns(owner, bot, id).map((r) => r.id), [fired.runId]);
});

test('save_file byte snapshots are immutable versions, deduplicated within the same source job', () => {
  const a = artifact('versioned.md', 'old bytes');
  assert.equal(artifact('versioned.md', 'old bytes').id, a.id);
  const newer = artifact('versioned.md', 'new bytes');
  assert.notEqual(newer.id, a.id); assert.notEqual(newer.sha256, a.sha256);
  fs.mkdirSync(path.join(root, 'files', bot), { recursive: true });
  fs.writeFileSync(path.join(root, 'files', bot, 'versioned.md'), 'mutable Library source changed');
  assert.equal(d.readArtifact(owner, a.id).content.toString(), 'old bytes');
  assert.equal(d.readArtifact(owner, newer.id).content.toString(), 'new bytes');
  assert.ok(fs.existsSync(path.join(root, 'files', bot, a.libraryPath)), 'existing files/ backup scope includes snapshot bytes');
});

test('concurrent delivery drains claim once; an idempotency key binds exact artifact/channel', async () => {
  const a = artifact('delivery.md'); let sends = 0;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const adapter = fakeTransport(async ({ content }) => { sends++; assert.equal(content.toString(), '# Saved report\nOriginal findings'); await wait; return 'external-1'; });
  const input = { userId: owner, artifactId: a.id, channel: 'imessage' as const, idempotencyKey: 'same-action' };
  const [one, two] = await Promise.all([d.requestDelivery(input, adapter), d.requestDelivery(input, adapter)]);
  assert.equal(one.id, two.id);
  const sending = d.sendDelivery(owner, one.id, adapter);
  await d.sendDelivery(owner, one.id, adapter);
  assert.equal(sends, 1); release(); await sending;
  assert.equal(d.getDelivery(owner, one.id).status, 'delivered');
  assert.equal(d.getDelivery(owner, one.id).attempts.length, 1);
  await assert.rejects(d.requestDelivery({ ...input, channel: 'sms' }, adapter), /another delivery/);
  await assert.rejects(d.requestDelivery({ ...input, artifactId: artifact('other-delivery.md').id }, adapter), /another delivery/);
});

test('delivery-only safe retry reads saved bytes and original target, without another agent job', async () => {
  const a = artifact('retry.md', 'immutable result'), before = enqueued.length;
  const failedAdapter = fakeTransport(async () => { throw new d.DeliveryNotSentError('channel offline'); });
  const delivery = await d.requestDelivery({ userId: owner, artifactId: a.id, channel: 'imessage' }, failedAdapter);
  assert.equal((await d.sendDelivery(owner, delivery.id, failedAdapter)).status, 'failed');
  const expected = d.readArtifact(owner, a.id).content;
  const sent: string[] = [];
  const retryAdapter = fakeTransport(async ({ content, target }) => {
    assert.deepEqual(content, expected); assert.equal(target.chatRef, 'original');
    sent.push(content.toString()); return 'delivered-after-reconnect';
  });
  d.retryDelivery(owner, delivery.id);
  const result = await d.sendDelivery(owner, delivery.id, retryAdapter);
  assert.equal(result.status, 'delivered'); assert.deepEqual(result.attempts.map((a) => a.status), ['failed', 'delivered']);
  assert.deepEqual(sent, ['immutable result']); assert.equal(enqueued.length, before);
  assert.throws(() => d.retryDelivery(owner, delivery.id), /Only definitely/);
});

test('uncertain external send is unknown and never replayed by send/retry/drain', async () => {
  let sends = 0;
  const adapter = fakeTransport(async () => { sends++; throw new Error('response lost after provider accepted'); });
  const delivery = await d.requestDelivery({ userId: owner, artifactId: artifact('unknown.md').id, channel: 'sms' }, adapter);
  const result = await d.sendDelivery(owner, delivery.id, adapter);
  assert.equal(result.status, 'unknown');
  assert.throws(() => d.retryDelivery(owner, delivery.id), /Unknown/);
  await d.sendDelivery(owner, delivery.id, adapter); await d.drainDeliveries(20, adapter);
  assert.equal(sends, 1);
});

test('approval pins recipient/revision/artifact before sending and refuses changed or forged destinations', async () => {
  const a = artifact('approval-bound.md');
  let recipient = { channel: 'imessage' as const, transport: 'test', phone: '15550001000', chatRef: 'original', revision: 'link-revision-1' };
  const adapter: DeliveryTransport = { prepare: async () => ({ ...recipient }), send: async () => 'approved' };
  const raw = { artifact_id: a.id, channel: 'imessage' };
  const pinned = await d.prepareDeliveryAction(owner, bot, 'deliver_artifact', raw, adapter) as any;
  assert.equal(pinned.destination.target.phone, '15550001000');
  assert.match(pinned.destination.recipient, /15550001000/);
  assert.equal(pinned.destination.artifact_sha256, a.sha256);
  assert.deepEqual(await d.prepareDeliveryAction(owner, bot, 'deliver_artifact', pinned, adapter), pinned);
  recipient = { ...recipient, phone: '15550009999', revision: 'link-revision-2' };
  await assert.rejects(d.prepareDeliveryAction(owner, bot, 'deliver_artifact', pinned, adapter), /destination changed/);
  await assert.rejects(d.requestDelivery({ userId: owner, artifactId: a.id, channel: 'imessage', approvedTarget: pinned.destination.target }, adapter), /destination changed/);
  recipient = { ...recipient, phone: '15550001000', revision: 'link-revision-1' };
  const forged = structuredClone(pinned); forged.destination.target.phone = '15550009999';
  await assert.rejects(d.prepareDeliveryAction(owner, bot, 'deliver_artifact', forged, adapter), /destination changed/);
  const changedArtifact = { ...pinned, artifact_id: artifact('different-approved.md').id };
  await assert.rejects(d.prepareDeliveryAction(owner, bot, 'deliver_artifact', changedArtifact, adapter), /approval is invalid/);
  await assert.rejects(d.prepareDeliveryAction(other, foreignBot, 'deliver_artifact', pinned, adapter), /Not found/);
  const request = await d.requestDelivery({ userId: owner, artifactId: a.id, channel: 'imessage', approvedTarget: pinned.destination.target }, adapter);
  await d.sendDelivery(owner, request.id, fakeTransport(async () => { throw new d.DeliveryNotSentError(); }));
  const retry = await d.prepareDeliveryAction(owner, bot, 'retry_delivery', { delivery_id: request.id }, adapter) as any;
  assert.deepEqual(retry.destination.target, pinned.destination.target);
  assert.notEqual(retry.destination.proof, pinned.destination.proof, 'an approval for initial delivery cannot authorize a retry');
});

test('real exited owner recovery marks running work and claimed sends unknown without regeneration', async () => {
  const id = routine('routine_crash');
  const moduleUrl = (name: string) => pathToFileURL(path.join(import.meta.dirname, '..', 'server/src', name)).href;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    const { acceptJob,beginJob }=await import(${JSON.stringify(moduleUrl('agent/jobs.ts'))});
    const d=await import(${JSON.stringify(moduleUrl('deliverables/index.ts'))});
    const r=d.reserveRoutineRun({userId:${JSON.stringify(owner)},botId:${JSON.stringify(bot)},routineId:${JSON.stringify(id)},name:'crash',kind:'schedule',fireKey:'crash-slot'});
    const job=acceptJob(${JSON.stringify(bot)},{type:'routine',routineId:${JSON.stringify(id)},routineRunId:r.run.id});
    d.bindRoutineJob(${JSON.stringify(owner)},r.run.id,job.id);beginJob(job.id);d.onJobStarted({jobId:job.id,botId:${JSON.stringify(bot)}});
    const a=d.recordArtifact({userId:${JSON.stringify(owner)},botId:${JSON.stringify(bot)},jobId:job.id,filename:'crash.md',content:'persisted before crash'});
    const adapter={prepare:async(u,channel)=>({channel}),send:async()=>{console.log(JSON.stringify({runId:r.run.id,deliveryId:delivery.id}));process.exit(0);}};
    const delivery=await d.requestDelivery({userId:${JSON.stringify(owner)},artifactId:a.id,channel:'imessage'},adapter);
    await d.sendDelivery(${JSON.stringify(owner)},delivery.id,adapter);
  `], { env: process.env, encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 0, child.stderr);
  const crash = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
  assert.equal(d.getDelivery(owner, crash.deliveryId).status, 'sending');
  const before = enqueued.length, recovered = d.recoverDeliverables();
  assert.ok(recovered.runs >= 1); assert.equal(recovered.deliveries, 1);
  assert.equal(d.getRoutineRun(owner, crash.runId).status, 'unknown');
  assert.equal(d.getDelivery(owner, crash.deliveryId).status, 'unknown');
  assert.throws(() => d.retryDelivery(owner, crash.deliveryId), /Unknown/);
  assert.equal(runRoutine(id, 'schedule', { fireKey: 'crash-slot' }).runId, crash.runId);
  assert.equal(enqueued.length, before, 'old fire identity remains a tombstone');
});

test('foreign owner/Bot identities, arbitrary paths and symlinked storage are refused', async () => {
  const a = artifact('private.md');
  assert.throws(() => d.getArtifact(other, a.id), /Not found/);
  assert.throws(() => d.listArtifacts(other, bot), /Not found/);
  await assert.rejects(d.requestDelivery({ userId: other, artifactId: a.id, channel: 'library' }), /Not found/);
  for (const name of ['../secret', '/etc/passwd', 'dir/report', 'dir\\report', '..', 'bad\0.md']) assert.throws(() => artifact(name), /filename/);
  const external = path.join(root, 'outside'); fs.mkdirSync(external);
  db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES(?,?,?,?,?)').run('bot_symlink', owner, 'symlink', Date.now(), Date.now());
  fs.symlinkSync(external, path.join(root, 'files', 'bot_symlink'));
  assert.throws(() => d.recordArtifact({ userId: owner, botId: 'bot_symlink', filename: 'leak.md', content: 'no leak' }));
  assert.equal(fs.readdirSync(external).length, 0);
  const damaged = artifact('damaged.md', 'original');
  const target = path.join(root, 'files', bot, damaged.libraryPath);
  fs.chmodSync(target, 0o600); fs.writeFileSync(target, 'tampered');
  assert.throws(() => d.readArtifact(owner, damaged.id), /integrity/);
});

test('authenticated downloads enforce ownership and safe attachment headers; Library delivery is durable', async () => {
  const app = new Hono(); app.route('/api/deliverables', deliverablesApi);
  const a = artifact('safe report.md', '<script>unsafe inline</script>');
  const cookie = (userId: string) => {
    const token = `delivery-session-${userId}`;
    db.prepare('INSERT OR REPLACE INTO auth_sessions(token,user_id,created_at,expires_at) VALUES(session_hash(?),?,?,?)').run(token, userId, Date.now(), Date.now() + 3600000);
    return `swarm_session=${token}`;
  };
  assert.equal((await app.request(a.downloadUrl)).status, 401);
  assert.equal((await app.request(a.downloadUrl, { headers: { cookie: cookie(other) } })).status, 404);
  const downloaded = await app.request(a.downloadUrl, { headers: { cookie: cookie(owner) } });
  assert.equal(downloaded.status, 200); assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
  assert.match(downloaded.headers.get('content-disposition')!, /^attachment;/);
  assert.equal(await downloaded.text(), '<script>unsafe inline</script>');
  const headers = { cookie: cookie(owner), 'content-type': 'application/json', 'Idempotency-Key': 'library-delivery' };
  const delivered = await app.request(`/api/deliverables/artifacts/${a.id}/deliveries`, { method: 'POST', headers, body: JSON.stringify({ channel: 'library' }) });
  assert.equal(delivered.status, 200);
  const body = await delivered.json() as any;
  assert.equal(body.delivery.status, 'delivered'); assert.equal(body.delivery.attempts.length, 1);
  const again = await app.request(`/api/deliverables/artifacts/${a.id}/deliveries`, { method: 'POST', headers, body: JSON.stringify({ channel: 'library' }) });
  assert.equal((await again.json() as any).delivery.id, body.delivery.id);
  const csrf = await app.request(`/api/deliverables/artifacts/${a.id}/deliveries`, { method: 'POST', headers: { ...headers, origin: 'https://attacker.test' }, body: JSON.stringify({ channel: 'library' }) });
  assert.equal(csrf.status, 403);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { snapshotStagingVolume } from '../scripts/snapshot-staging-volume.mjs';
import { retryCommand } from '../scripts/retry-staging-command.mjs';

function fixture(change = () => {}) {
  let time = 0, createdAt, creates = 0, evidence;
  const calls = [];
  const input = { now: () => time, sleep: async ms => { time += ms; }, log: () => {}, save: value => { evidence = value; },
    run: async (args, timeout) => {
      calls.push({ args, timeout });
      const override = change({ args, time, creates, createdAt });
      if (override !== undefined) return JSON.stringify(override);
      if (args[1] === 'list') return JSON.stringify([{ id: 'volume', name: 'swarm_data', attached_machine_id: 'machine' }]);
      if (args[2] === 'create') { creates++; createdAt = time; return ''; }
      return JSON.stringify([{ id: 'old', status: 'created' }, ...(createdAt === undefined ? [] : [{ id: 'new', status: time - createdAt >= 20_000 ? 'created' : 'pending' }])]);
    } };
  return { input, calls, get time() { return time; }, get creates() { return creates; }, get evidence() { return evidence; } };
}

test('image push retries the same command with backoff and fails clearly after exhaustion', async () => {
  let calls = 0; const waits = [];
  assert.equal(await retryCommand(async () => { if (++calls < 3) throw Error('registry unavailable'); return 'digest'; }, { sleep: async ms => { waits.push(ms); }, log: () => {} }), 'digest');
  assert.deepEqual(waits, [5000, 10000]);
  await assert.rejects(retryCommand(async () => { throw Error('registry unavailable'); }, { sleep: async () => {}, log: () => {} }), /after 3 attempts/);
});

test('backup waits beyond the old timeout and preserves a newly completed snapshot', async () => {
  const f = fixture(({ args, time, createdAt }) => args[2] === 'list' && createdAt !== undefined
    ? [{ id: 'old', status: 'created' }, { id: 'slow', status: time > 600_000 ? 'created' : 'pending' }] : undefined);
  const result = await snapshotStagingVolume(f.input);
  assert.equal(result.snapshot.id, 'slow'); assert.ok(f.time > 600_000);
  assert.equal(f.creates, 1); assert.deepEqual(f.evidence, result);
});

test('a prior pending snapshot must finish before requesting a new backup', async () => {
  const f = fixture(({ args, time }) => {
    if (args[2] === 'create' && time < 40_000) throw Error('An on-demand snapshot is pending for this volume');
  });
  const result = await snapshotStagingVolume(f.input);
  assert.equal(result.snapshot.id, 'new'); assert.ok(f.time >= 60_000); assert.equal(f.creates, 1);
});

test('transient snapshot list and creation failures are retried without accepting an old backup', async () => {
  let reads = 0, attempts = 0;
  const f = fixture(({ args }) => {
    if (args[2] === 'list' && ++reads === 2) throw Error('temporary Fly API failure');
    if (args[2] === 'create' && ++attempts === 1) throw Error('temporary create failure');
  });
  assert.equal((await snapshotStagingVolume(f.input)).snapshot.id, 'new');
  assert.equal(attempts, 2);
});

test('a lost create response polls its new snapshot instead of creating a duplicate', async () => {
  let queued = false, attempts = 0;
  const f = fixture(({ args, time }) => {
    if (args[2] === 'create') { queued = true; attempts++; throw Error('response lost'); }
    if (args[2] === 'list' && queued) return [{ id: 'new', status: time < 20_000 ? 'pending' : 'created' }];
  });
  assert.equal((await snapshotStagingVolume(f.input)).snapshot.id, 'new'); assert.equal(attempts, 1);
});

test('snapshot timeout and exhausted create retries stop deployment with pending evidence', async () => {
  const f = fixture(({ args }) => args[2] === 'list' ? [{ id: 'old', status: 'created' }] : undefined);
  await assert.rejects(snapshotStagingVolume({ ...f.input, timeoutMs: 60_000 }), /did not complete/);
  assert.equal(f.evidence.timedOut, true); assert.equal(f.creates, 1);
  assert.ok(f.calls.every(c => c.timeout <= 60_000));
  let failures = 0;
  const broken = fixture(({ args }) => { if (args[2] === 'create') { failures++; throw Error('create unavailable'); } });
  await assert.rejects(snapshotStagingVolume(broken.input), /after 3 attempts/); assert.equal(failures, 3);
});

test('an explicitly failed new snapshot is retried and only its completed replacement is accepted', async () => {
  const f = fixture(({ args, creates }) => args[2] === 'list' && creates > 0
    ? [{ id: 'old', status: 'created' }, { id: 'failed', status: 'failed' }, ...(creates > 1 ? [{ id: 'replacement', status: 'created' }] : [])] : undefined);
  assert.equal((await snapshotStagingVolume(f.input)).snapshot.id, 'replacement');
  assert.equal(f.creates, 2);
});
